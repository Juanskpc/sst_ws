// Verifica A1-07 (rechazos, corrección, eventos DIAN y aceptación tácita)
// CONTRA EL SANDBOX real de Factus para el ciclo rechazo→corregir→reemitir
// (§1.5 punto 4 del plan). Para provocar un rechazo GENUINO del lado de Factus
// (un municipio con código DANE inválido) se usa un ARL/tercero/municipio
// **desechables, creados por este script**, nunca los catálogos ni los
// terceros reales: así no hay que tocar (ni restaurar) datos compartidos.
// Uso: node --import tsx scripts/verificar-eventos-factura.mjs
import { pool } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { calcularDv } from '../src/utils/nit.js';
import { estaConfigurado, esSandbox } from '../src/modules/facturacion/adaptadores/factus.cliente.js';
import { crearBorrador, actualizarBorrador } from '../src/modules/facturacion/borrador.service.js';
import { emitirDocumento, corregirDocumento } from '../src/modules/facturacion/emision.service.js';
import { consultarEventosDocumento, marcarAceptacionTacita } from '../src/modules/facturacion/eventos.service.js';

if (!estaConfigurado()) throw new Error('Faltan las variables FACTUS_* en .env');
if (!esSandbox()) throw new Error(`FACTUS_URL apunta a ${env.factus.url}. Este script solo corre contra el sandbox.`);

let fallos = 0;
const igual = (obtenido, esperado, texto) => {
  const ok = JSON.stringify(obtenido) === JSON.stringify(esperado);
  if (!ok) fallos++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${texto} → ${JSON.stringify(obtenido)}${ok ? '' : ` (esperado ${JSON.stringify(esperado)})`}`);
};
const distinto = (a, b, texto) => {
  const ok = a !== b;
  if (!ok) fallos++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${texto} → "${a}" vs "${b}"`);
};
const rechaza = async (fn, fragmento, texto) => {
  try { await fn(); fallos++; console.log(`FAIL ${texto} → no lanzó error`); }
  catch (e) {
    const ok = e.message.includes(fragmento);
    if (!ok) fallos++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${texto} → ${e.message.slice(0, 130)}`);
  }
};

const ADMIN_ID = (await pool.query(`SELECT id FROM sst.usuarios WHERE rol = 'admin' ORDER BY creado_en LIMIT 1`)).rows[0].id;
const nitCedula = (await pool.query(`SELECT id FROM sst.tipos_documento_identidad WHERE codigo_dian = '31'`)).rows[0].id;
const departamentoId = (await pool.query(`SELECT id FROM sst.departamentos LIMIT 1`)).rows[0].id;

let municipioId, terceroId, arlId, ordenId, documentoId, referenceCodeInicial;
try {
  // Todo lo de abajo es EXCLUSIVO de esta prueba: un municipio con código DANE
  // que no existe, un tercero y un ARL nuevos. Nada real se toca.
  municipioId = (await pool.query(
    `INSERT INTO sst.municipios (codigo_dian, nombre, departamento_id) VALUES ('ZZZZZ', 'MUNICIPIO DE PRUEBA A107', $1) RETURNING id`,
    [departamentoId],
  )).rows[0].id;

  const numeroDoc = String(900000000 + Math.floor(Math.random() * 9999));
  const dv = calcularDv(numeroDoc);
  terceroId = (await pool.query(
    `INSERT INTO sst.terceros (tipo_persona, tipo_documento_id, numero_documento, dv, razon_social, direccion,
                                municipio_id, correo_facturacion, es_arl, es_cliente)
     VALUES ('JURIDICA', $1, $2, $3, 'EMPRESA DE PRUEBA A1-07 SAS', 'Calle de prueba 1', $4,
             'facturacion.prueba@jddconsultores.test', true, true)
     RETURNING id`,
    [nitCedula, numeroDoc, dv, municipioId],
  )).rows[0].id;
  arlId = (await pool.query(`INSERT INTO sst.arls (nombre, formato_origen, tercero_id) VALUES ('ARL DE PRUEBA A1-07', 'pdf', $1) RETURNING id`, [terceroId])).rows[0].id;

  ordenId = (await pool.query(
    `INSERT INTO sst.ordenes_servicio
       (arl_id, codigo, numero_orden, empresa_nombre, tipo_actividad, tema_actividad, horas_asignadas, valor_total,
        estado, estado_arl, estado_cobro)
     VALUES ($1,'OS-A107-1','AXA-A107','EMPRESA DE PRUEBA','Capacitación','Prueba A1-07 (sandbox)',2,117712,
             'FINALIZADA'::sst.estado_orden,'APROBADO'::sst.estado_arl,'NO FACTURADA'::sst.estado_cobro)
     RETURNING id`,
    [arlId],
  )).rows[0].id;

  const borrador = await crearBorrador({ arlId, ordenIds: [ordenId], usuarioId: ADMIN_ID });
  documentoId = borrador.id;
  referenceCodeInicial = borrador.reference_code;
  igual(borrador.estado, 'BORRADOR', 'Nace en BORRADOR');

  console.log('\nEmitiendo con un municipio DANE inválido a propósito (debe RECHAZAR de verdad)…');
  const r1 = await emitirDocumento(documentoId, ADMIN_ID);

  if (r1.pendiente) {
    console.log(`⚠ Factus no decidió a tiempo (${r1.estado}); se fuerza RECHAZADO a mano para seguir probando corregirDocumento (no depende de CÓMO se llegó a RECHAZADO).`);
    await pool.query(`UPDATE sst.documentos_electronicos SET estado = 'RECHAZADO' WHERE id = $1`, [documentoId]);
  } else {
    igual(r1.estado, 'RECHAZADO', 'Factus rechaza de verdad el municipio inválido');
  }

  // ── corregirDocumento ────────────────────────────────────────────────────
  const corregido = await corregirDocumento(documentoId, ADMIN_ID);
  igual(corregido.estado, 'BORRADOR', 'corregirDocumento devuelve el documento a BORRADOR');
  distinto(corregido.reference_code, referenceCodeInicial, 'corregirDocumento estrena un reference_code nuevo');
  await rechaza(() => corregirDocumento(documentoId, ADMIN_ID), 'Solo se corrige', 'Ya en BORRADOR: corregir de nuevo se rechaza');

  const codigosEventos = corregido.eventos?.map((e) => e.codigo) ?? (await pool.query(`SELECT codigo FROM sst.documento_eventos WHERE documento_id = $1`, [documentoId])).rows.map((r) => r.codigo);
  igual(codigosEventos.includes('CORREGIDO'), true, 'El historial conserva el evento CORREGIDO (no se borra nada)');
  igual(codigosEventos.includes('CREADO'), true, 'El historial conserva el evento CREADO original');

  // Se corrige el municipio ANTES de reemitir: el tercero de prueba pasa a
  // apuntar al Bogotá REAL del catálogo (solo se lee, nunca se toca) en vez de
  // renombrar el municipio inválido (su código ya es único, no se puede
  // "arreglar" a uno que otra fila ya tiene).
  const bogotaReal = (await pool.query(`SELECT id FROM sst.municipios WHERE codigo_dian = '11001'`)).rows[0].id;
  await pool.query(`UPDATE sst.terceros SET municipio_id = $2 WHERE id = $1`, [terceroId, bogotaReal]);
  await actualizarBorrador(documentoId, {
    items: [{ orden_id: ordenId, descripcion: 'Prueba A1-07 corregida', cantidad: 2, valor_unitario: 58856 }],
    descuento_comercial_pct: 0, retenciones_ids: [],
  }, ADMIN_ID);

  console.log('\nReemitiendo ya corregido (debe VALIDAR)…');
  const r2 = await emitirDocumento(documentoId, ADMIN_ID);
  if (r2.pendiente) {
    console.log('⚠ Factus no decidió a tiempo en esta corrida; se detiene aquí la parte de eventos/aceptación tácita.');
  } else {
    igual(r2.estado, 'VALIDADO', 'La reemisión corregida sí valida');
    distinto(r2.reference_code, referenceCodeInicial, 'La factura VALIDADA quedó con el reference_code nuevo, no el rechazado');

    console.log('\nConsultando eventos DIAN de verdad…');
    const eventos = await consultarEventosDocumento(documentoId, ADMIN_ID);
    console.log(`  consultados: ${eventos.consultados}, nuevos: ${eventos.nuevos}`);
    igual(eventos.consultados >= 0 && eventos.nuevos >= 0, true, 'Consultar eventos responde sin error contra el sandbox');
    const eventos2 = await consultarEventosDocumento(documentoId, ADMIN_ID);
    igual(eventos2.nuevos, 0, 'Repetir "Consultar eventos" no inserta duplicados');

    // ── Reglas de la aceptación tácita interna (sin red) ──────────────────
    await rechaza(() => marcarAceptacionTacita(documentoId, ADMIN_ID), 'crédito', 'Rechaza si la factura es de contado (forma de pago por defecto)');

    await pool.query(
      `UPDATE sst.documentos_electronicos SET forma_pago_id = (SELECT id FROM sst.formas_pago WHERE codigo_dian = '2') WHERE id = $1`,
      [documentoId],
    );
    await rechaza(() => marcarAceptacionTacita(documentoId, ADMIN_ID), 'Todavía no vence', 'A crédito pero sin vencer: se rechaza');

    await pool.query(`UPDATE sst.documentos_electronicos SET fecha_vencimiento = CURRENT_DATE - 5 WHERE id = $1`, [documentoId]);
    const marcada = await marcarAceptacionTacita(documentoId, ADMIN_ID);
    igual(marcada.marcada, true, 'A crédito y vencida: se marca');
    await rechaza(() => marcarAceptacionTacita(documentoId, ADMIN_ID), 'Ya está marcada', 'Marcarla dos veces se rechaza');

    // Un reclamo (031) de la DIAN debe bloquear el apunte interno.
    const otroDoc = (await pool.query(
      `INSERT INTO sst.documentos_electronicos (tipo, reference_code, estado, tercero_id, forma_pago_id, fecha_vencimiento, total_a_pagar)
       VALUES ('FACTURA','ORB-FACTURA-A107-RECLAMO','VALIDADO',$1,(SELECT id FROM sst.formas_pago WHERE codigo_dian='2'), CURRENT_DATE - 5, 1000)
       RETURNING id`,
      [terceroId],
    )).rows[0].id;
    await pool.query(`INSERT INTO sst.documento_eventos (documento_id, codigo, descripcion) VALUES ($1,'RADIAN_031','Reclamo de prueba')`, [otroDoc]);
    await rechaza(() => marcarAceptacionTacita(otroDoc, ADMIN_ID), 'ya registró un evento', 'Con un reclamo (031) registrado, no se puede marcar');
    await pool.query(`DELETE FROM sst.documentos_electronicos WHERE id = $1`, [otroDoc]);
  }
} finally {
  if (documentoId) await pool.query(`DELETE FROM sst.documentos_electronicos WHERE id = $1`, [documentoId]);
  if (ordenId) {
    await pool.query(`DELETE FROM sst.historial_cobro_orden WHERE orden_id = $1`, [ordenId]);
    await pool.query(`DELETE FROM sst.ordenes_servicio WHERE id = $1`, [ordenId]);
  }
  if (arlId) await pool.query(`DELETE FROM sst.arls WHERE id = $1`, [arlId]);
  if (terceroId) await pool.query(`DELETE FROM sst.terceros WHERE id = $1`, [terceroId]);
  if (municipioId) await pool.query(`DELETE FROM sst.municipios WHERE id = $1`, [municipioId]);

  const restos = (await pool.query(`SELECT count(*)::int AS n FROM sst.ordenes_servicio WHERE codigo LIKE 'OS-A107-%'`)).rows[0].n;
  const restosMuni = (await pool.query(`SELECT count(*)::int AS n FROM sst.municipios WHERE nombre = 'MUNICIPIO DE PRUEBA A107'`)).rows[0].n;
  console.log(`\nResiduos: ${restos} orden(es), ${restosMuni} municipio(s) de prueba`);
  if (restos || restosMuni) fallos++;
  await pool.end();
}
console.log(fallos ? `\n${fallos} FALLO(S)` : '\nTodo OK');
process.exit(fallos ? 1 : 0);
