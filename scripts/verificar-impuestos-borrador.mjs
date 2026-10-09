// 9-oct-2026 · Verifica las dos opciones nuevas del borrador de factura:
//   · corregir el IVA de una línea (cambiando su producto) y quitar/poner retenciones;
//   · la vista previa en PDF antes de emitir.
// Todo en una transacción con ROLLBACK: no deja nada en la base.
//   node --import tsx scripts/verificar-impuestos-borrador.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pool } from '../src/config/db.js';
import { cambiarImpuestosBorrador, crearBorradorManual } from '../src/modules/facturacion/borrador.service.js';
import { pdfVistaPrevia } from '../src/modules/facturacion/representacion.service.js';

const client = await pool.connect();
let fallos = 0;
const comprobar = (ok, t) => { console.log(`${ok ? '✓' : '✗'} ${t}`); if (!ok) fallos += 1; };
const falla = async (fn, t, patron) => {
  await client.query('SAVEPOINT s');
  try { await fn(); comprobar(false, `${t} (no falló)`); } catch (e) {
    comprobar((e.statusCode ?? 500) < 500 && (!patron || patron.test(e.message)), `${t} → «${e.message}»`);
  }
  await client.query('ROLLBACK TO SAVEPOINT s');
};
const textoPdf = (bytes) => {
  const f = path.join(os.tmpdir(), `vista-${Date.now()}.pdf`);
  fs.writeFileSync(f, bytes);
  try { return execFileSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8' }); } catch { return null; } finally { fs.unlinkSync(f); }
};

try {
  await client.query('BEGIN');
  const usuario = (await client.query(`SELECT id FROM sst.usuarios ORDER BY creado_en LIMIT 1`)).rows[0].id;
  const cliente = (await client.query(`SELECT id FROM sst.terceros WHERE activo AND es_cliente AND NOT es_arl ORDER BY creado_en LIMIT 1`)).rows[0];
  const gravado = (await client.query(`SELECT id FROM sst.productos WHERE activo AND tratamiento_iva = 'GRAVADO' LIMIT 1`)).rows[0];
  const sinIva = (await client.query(`SELECT id FROM sst.productos WHERE activo AND tratamiento_iva <> 'GRAVADO' LIMIT 1`)).rows[0];
  if (!cliente || !gravado || !sinIva) throw new Error('Faltan un cliente, un producto gravado y uno sin IVA para probar.');
  const rf = (await client.query(
    `INSERT INTO sst.retenciones (codigo, nombre, tipo, tarifa, aplica_a, factus_tributo_id) VALUES ('PRUEBA-IMP-RF', 'PRUEBA RF 11', 'RETEFUENTE', 11, 'VENTA', '06') RETURNING id`,
  )).rows[0].id;
  const rf4 = (await client.query(
    `INSERT INTO sst.retenciones (codigo, nombre, tipo, tarifa, aplica_a, factus_tributo_id) VALUES ('PRUEBA-IMP-RF4', 'PRUEBA RF 4', 'RETEFUENTE', 4, 'VENTA', '06') RETURNING id`,
  )).rows[0].id;
  const formas = (await client.query(`SELECT id, codigo_dian FROM sst.formas_pago WHERE activo`)).rows;
  const credito = formas.find((f) => f.codigo_dian === '2');

  const f = await crearBorradorManual({
    tercero_id: cliente.id, observaciones: 'Prueba de impuestos',
    items: [
      { descripcion: 'Línea A (gravada)', cantidad: 1, valor_unitario: 1000000, producto_id: gravado.id },
      { descripcion: 'Línea B (gravada)', cantidad: 2, valor_unitario: 500000, producto_id: gravado.id },
    ],
    retenciones_ids: [rf], forma_pago_id: credito?.id, plazo_dias: 30,
  }, usuario, client);
  comprobar(Number(f.totales.total_iva) === 380000, `borrador con IVA 19 % en las dos líneas (${f.totales.total_iva})`);
  comprobar(f.retenciones.length === 1 && f.retenciones[0].id === rf, 'trae su retención con el id (para editarla)');

  // 1 · Quitar el IVA de la línea B pasándola a un producto sin IVA.
  const lineaB = f.items.find((it) => it.descripcion.startsWith('Línea B'));
  const g = await cambiarImpuestosBorrador(f.id, { productos: { [lineaB.id]: sinIva.id } }, usuario, client);
  comprobar(Number(g.totales.total_iva) === 190000, `sin IVA en la línea B: IVA total 190.000 (${g.totales.total_iva})`);
  comprobar(g.items.find((it) => it.descripcion.startsWith('Línea B')).iva_pct === 0, 'la línea B queda en 0 %');
  comprobar(g.retenciones.length === 1, 'la retención se conserva si no se manda la lista');
  comprobar(g.observaciones === 'Prueba de impuestos' && g.forma_pago_id === f.forma_pago_id && g.fecha_vencimiento === f.fecha_vencimiento,
    'observaciones, forma de pago y vencimiento quedan iguales');
  comprobar(g.items.map((it) => it.descripcion).join('|') === f.items.map((it) => it.descripcion).join('|'), 'las líneas y su orden quedan iguales');
  const esperado = 2000000 + 190000 - 220000;
  comprobar(Number(g.totales.total_a_pagar) === esperado, `total recalculado: ${g.totales.total_a_pagar} = ${esperado}`);
  comprobar(g.eventos.some((e) => e.codigo === 'EDITADO'), 'queda en el historial');

  // 2 · Quitar la retención y poner otra.
  const h = await cambiarImpuestosBorrador(f.id, { retenciones_ids: [rf4] }, usuario, client);
  comprobar(h.retenciones.length === 1 && h.retenciones[0].id === rf4 && Number(h.retenciones[0].valor) === 80000, 'se cambia la retefuente 11 % por la de 4 %');
  comprobar(Number(h.items.find((it) => it.descripcion.startsWith('Línea B')).iva_pct) === 0, 'el IVA corregido antes se mantiene');
  const sinRet = await cambiarImpuestosBorrador(f.id, { retenciones_ids: [] }, usuario, client);
  comprobar(sinRet.retenciones.length === 0 && Number(sinRet.totales.total_a_pagar) === 2190000, 'sin retenciones: total = subtotal + IVA');

  // 3 · Lo que debe rechazar, con un mensaje claro.
  await falla(() => cambiarImpuestosBorrador(f.id, { productos: { '00000000-0000-0000-0000-000000000000': sinIva.id } }, usuario, client), 'una línea de otra factura', /no pertenece/);
  await falla(() => cambiarImpuestosBorrador(f.id, { retenciones_ids: ['00000000-0000-0000-0000-000000000000'] }, usuario, client), 'una retención que no existe', /recargue/);
  // Cada guardado vuelve a crear las líneas: se usan las del último detalle.
  const lineaB2 = sinRet.items.find((it) => it.descripcion.startsWith('Línea B'));
  await falla(() => cambiarImpuestosBorrador(f.id, { productos: { [lineaB2.id]: '00000000-0000-0000-0000-000000000000' } }, usuario, client), 'un producto que no existe', /producto/);

  // 4 · Vista previa
  const conEmisor = (await client.query(`SELECT 1 FROM sst.emisor WHERE id = 1`)).rows[0];
  if (!conEmisor) {
    await falla(() => pdfVistaPrevia(f.id, client), 'vista previa sin empresa emisora', /empresa emisora/);
    const pasto = (await client.query(`SELECT id FROM sst.municipios WHERE codigo_dian = '52001'`)).rows[0].id;
    await client.query(
      `INSERT INTO sst.emisor (id, tipo_persona, nit, dv, razon_social, direccion, municipio_id, correo, telefono, ambiente, responsabilidades_rut)
       VALUES (1, 'JURIDICA', '901203812', 4, 'EMISOR DE PRUEBA', 'CARRERA 24 N. 17-15', $1, 'prueba@example.com', '3144768516', 'PRUEBAS', '{48}')`, [pasto],
    );
  }
  await cambiarImpuestosBorrador(f.id, { retenciones_ids: [rf] }, usuario, client);
  const pdf = await pdfVistaPrevia(f.id, client);
  comprobar(pdf?.length > 1000, `vista previa armada (${pdf?.length} bytes)`);
  const t = textoPdf(pdf);
  if (t) {
    if (process.argv[2]) fs.writeFileSync(path.join(process.argv[2], 'vista-previa-borrador.pdf'), pdf); // copia para verla
    // La marca va en diagonal: al extraer el texto sus palabras salen sueltas entre las demás.
    comprobar(['PREVIA', 'VALIDEZ'].every((w) => t.includes(w)), 'lleva la marca «VISTA PREVIA - SIN VALIDEZ»');
    comprobar(/se asigna al emitir/.test(t) && /se genera al emitir ante la DIAN/.test(t), 'sin número ni CUFE: dice que los da la emisión');
    comprobar(/nea A \(gravada\)/.test(t) && /nea B \(gravada\)/.test(t) && /Retefuente 11%/.test(t), 'trae las líneas y la retención del borrador');
  } else {
    console.log('· (sin pdftotext: no se revisa el texto del PDF)');
  }
  await client.query(`UPDATE sst.documentos_electronicos SET estado = 'VALIDADO', cufe = 'x', numero = 1 WHERE id = $1`, [f.id]);
  await falla(() => pdfVistaPrevia(f.id, client), 'vista previa de una ya emitida', /Ver factura/);
  await falla(() => cambiarImpuestosBorrador(f.id, { retenciones_ids: [] }, usuario, client), 'corregir impuestos de una ya emitida', /borrador/);
} catch (e) {
  comprobar(false, `se cayó: ${e.stack}`);
} finally {
  await client.query('ROLLBACK').catch(() => {});
  client.release();
  await pool.end();
}
console.log(fallos ? `\n${fallos} FALLO(S)` : '\nTodo OK');
process.exit(fallos ? 1 : 0);
