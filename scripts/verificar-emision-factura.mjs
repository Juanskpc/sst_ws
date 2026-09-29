// Verifica A1-05 (emitir y conectar con el eje de cobro) CONTRA EL SANDBOX real
// de Factus (§1.5 punto 4 del plan: todo lo que emite se prueba ahí). Crea una
// orden y un borrador desechables para AXA, emite de verdad, comprueba que la
// orden quedó FACTURADA con el documento enlazado, que PATCH /orders/cobro
// rechaza desmarcarla, y deja la base como estaba (incluida la ficha de AXA,
// que se toca solo porque le faltaba el correo de facturación).
// Uso: node scripts/verificar-emision-factura.mjs (requiere el túnel a jdd_dev
// y las FACTUS_* del sandbox en .env)
import { pool } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { estaConfigurado, esSandbox } from '../src/modules/facturacion/adaptadores/factus.cliente.js';
import { storage } from '../src/services/storage.service.js';
import { crearBorrador } from '../src/modules/facturacion/borrador.service.js';
import { emitirDocumento } from '../src/modules/facturacion/emision.service.js';
import { signToken } from '../src/utils/security.js';

if (!estaConfigurado()) throw new Error('Faltan las variables FACTUS_* en .env');
if (!esSandbox()) throw new Error(`FACTUS_URL apunta a ${env.factus.url}. Este script solo corre contra el sandbox.`);

let fallos = 0;
const igual = (obtenido, esperado, texto) => {
  const ok = JSON.stringify(obtenido) === JSON.stringify(esperado);
  if (!ok) fallos++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${texto} → ${JSON.stringify(obtenido)}${ok ? '' : ` (esperado ${JSON.stringify(esperado)})`}`);
};
const cierto = (obtenido, texto) => igual(!!obtenido, true, texto);

const ADMIN_ID = (await pool.query(`SELECT id FROM sst.usuarios WHERE rol = 'admin' ORDER BY creado_en LIMIT 1`)).rows[0].id;
const axa = (await pool.query(`SELECT id, tercero_id FROM sst.arls WHERE nombre = 'AXA Colpatria'`)).rows[0];
const correoOriginal = (await pool.query(`SELECT correo_facturacion FROM sst.terceros WHERE id = $1`, [axa.tercero_id])).rows[0].correo_facturacion;

let ordenId, documentoId, pdfPath, xmlPath, servidor;
try {
  // AXA no tiene correo de facturación cargado (dato real): se completa solo
  // para esta prueba y se restaura al final (regla "no mutar datos reales,
  // dejarlos como estaban" de CLAUDE.md §5).
  await pool.query(`UPDATE sst.terceros SET correo_facturacion = 'facturacion.prueba@jddconsultores.test' WHERE id = $1`, [axa.tercero_id]);

  ordenId = (await pool.query(
    `INSERT INTO sst.ordenes_servicio
       (arl_id, codigo, numero_orden, empresa_nombre, tipo_actividad, tema_actividad, horas_asignadas,
        estado, estado_arl, estado_cobro)
     VALUES ($1,'OS-A105-1','AXA-A105','EMPRESA DE PRUEBA','Capacitación','Prueba A1-05 (sandbox)',3,
             'FINALIZADA'::sst.estado_orden,'APROBADO'::sst.estado_arl,'NO FACTURADA'::sst.estado_cobro)
     RETURNING id`,
    [axa.id],
  )).rows[0].id;

  const borrador = await crearBorrador({ arlId: axa.id, ordenIds: [ordenId], usuarioId: ADMIN_ID });
  documentoId = borrador.id;
  igual(borrador.estado, 'BORRADOR', 'Nace en BORRADOR');

  console.log('\nEmitiendo contra el sandbox de Factus (puede tardar unos segundos)…');
  const resultado = await emitirDocumento(documentoId, ADMIN_ID);

  if (resultado?.pendiente) {
    console.log(`⚠ Factus no decidió en el tiempo de esta prueba (${resultado.estado}). No es un fallo del código: use "Consultar estado" más tarde. Deteniendo la verificación aquí.`);
  } else {
    igual(resultado.estado, 'VALIDADO', 'Quedó VALIDADO en el sandbox');
    cierto(resultado.numero, 'Factus asignó un número');
    cierto(resultado.cufe, 'Factus devolvió el CUFE');
    pdfPath = resultado.pdf_path; xmlPath = resultado.xml_path;
    cierto(pdfPath, 'Se guardó la ruta del PDF');
    cierto(xmlPath, 'Se guardó la ruta del XML');
    if (!pdfPath || !xmlPath) {
      const evt = (await pool.query(`SELECT descripcion FROM sst.documento_eventos WHERE documento_id = $1 AND codigo = 'DESCARGA_FALLIDA'`, [documentoId])).rows[0];
      console.log(`  motivo: ${evt?.descripcion ?? '(sin evento DESCARGA_FALLIDA)'}`);
    }
    if (pdfPath) cierto((await storage.get(pdfPath)).length > 0, 'El PDF existe de verdad en el storage');
    if (xmlPath) cierto((await storage.get(xmlPath)).length > 0, 'El XML existe de verdad en el storage');

    const orden = (await pool.query(
      `SELECT estado_cobro::text AS estado_cobro, cobro_numero_factura FROM sst.ordenes_servicio WHERE id = $1`, [ordenId],
    )).rows[0];
    igual(orden.estado_cobro, 'FACTURADA', 'La orden pasó a FACTURADA');
    cierto(orden.cobro_numero_factura, 'La orden guardó el número de factura');

    const historial = (await pool.query(
      `SELECT estado_nuevo::text AS estado_nuevo, documento_id, numero_factura FROM sst.historial_cobro_orden WHERE orden_id = $1 ORDER BY cambiado_en DESC LIMIT 1`,
      [ordenId],
    )).rows[0];
    igual([historial.estado_nuevo, historial.documento_id], ['FACTURADA', documentoId], 'El historial quedó enlazado a ESTE documento');

    // Reemitir un documento ya VALIDADO debe rechazarse sin llamar a Factus otra vez.
    try {
      await emitirDocumento(documentoId, ADMIN_ID);
      fallos++; console.log('FAIL Reemitir un documento VALIDADO → no lanzó error');
    } catch (e) {
      const ok = e.message.includes('validado');
      if (!ok) fallos++;
      console.log(`${ok ? 'OK  ' : 'FAIL'} Reemitir un documento VALIDADO se rechaza → ${e.message.slice(0, 100)}`);
    }

    // PATCH /orders/cobro debe rechazar desmarcarla (por HTTP, para probar la ruta real).
    servidor = await levantarServidorTemporal();
    const token = signToken({ id: ADMIN_ID, correo: 'admin@jdd.com', rol: 'contador', nombre: 'Prueba' });
    const resp = await fetch(`http://localhost:${servidor.puerto}/api/orders/cobro`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ids: [ordenId], estado: 'NO FACTURADA' }),
    });
    const cuerpo = await resp.json();
    igual(resp.status, 200, 'PATCH /orders/cobro responde 200 (no revienta, solo no aplica el cambio)');
    igual(cuerpo.bloqueadas_por_factura_electronica, ['OS-A105-1'], 'La orden queda listada como bloqueada por factura electrónica');
    igual(cuerpo.actualizadas, [], 'Ninguna orden se desmarcó de verdad');
    const ordenTrasPatch = (await pool.query(`SELECT estado_cobro::text AS estado_cobro FROM sst.ordenes_servicio WHERE id = $1`, [ordenId])).rows[0];
    igual(ordenTrasPatch.estado_cobro, 'FACTURADA', 'La orden sigue FACTURADA después del intento de desmarcarla');
  }
} finally {
  if (servidor) await servidor.cerrar();
  // Limpieza: el documento (con sus ítems/tributos/eventos/relaciones por
  // CASCADE) y la orden desechable. La factura VALIDADA en el sandbox de
  // Factus NO se borra (sería alterar un documento fiscal, aunque sea de
  // prueba — mismo criterio que `factus-borrar-prueba.mjs`).
  if (documentoId) await pool.query(`DELETE FROM sst.documentos_electronicos WHERE id = $1`, [documentoId]);
  if (ordenId) await pool.query(`DELETE FROM sst.historial_cobro_orden WHERE orden_id = $1`, [ordenId]);
  if (ordenId) await pool.query(`DELETE FROM sst.ordenes_servicio WHERE id = $1`, [ordenId]);
  await pool.query(`UPDATE sst.terceros SET correo_facturacion = $2 WHERE id = $1`, [axa.tercero_id, correoOriginal]);
  if (pdfPath) await storage.remove(pdfPath).catch(() => {});
  if (xmlPath) await storage.remove(xmlPath).catch(() => {});

  const restos = (await pool.query(`SELECT count(*)::int AS n FROM sst.ordenes_servicio WHERE codigo = 'OS-A105-1'`)).rows[0].n;
  const correoRestaurado = (await pool.query(`SELECT correo_facturacion FROM sst.terceros WHERE id = $1`, [axa.tercero_id])).rows[0].correo_facturacion;
  console.log(`\nResiduos: ${restos} orden(es) · correo de AXA restaurado: ${correoRestaurado === correoOriginal}`);
  if (restos || correoRestaurado !== correoOriginal) fallos++;
  await pool.end();
}
console.log(fallos ? `\n${fallos} FALLO(S)` : '\nTodo OK');
process.exit(fallos ? 1 : 0);

/** Instancia temporal del servidor Express, solo para probar PATCH /orders/cobro por HTTP de verdad. */
async function levantarServidorTemporal() {
  const { createApp } = await import('../src/app.js');
  const app = createApp();
  return new Promise((resolve) => {
    const s = app.listen(0, () => {
      resolve({ puerto: s.address().port, cerrar: () => new Promise((r) => s.close(r)) });
    });
  });
}
