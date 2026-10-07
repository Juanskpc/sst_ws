// A4-02 · Verificación del documento soporte manual y de la carga masiva por Excel.
//
// 1. DS manual (la contadora, §3.5): dentro de una transacción con ROLLBACK se crea
//    y se arma su asiento: D a la cuenta elegida (51101001) / C honorarios por pagar.
// 2. Carga masiva: un Excel armado en memoria con dos filas del mismo proveedor y
//    referencia (un solo DS) y una fila con una cuenta que no existe → la revisión
//    marca el error y no guarda nada; corregido, se importa de verdad y los
//    borradores creados se borran al final.
//
// Uso: node --import tsx scripts/verificar-soporte-manual.mjs
import ExcelJS from 'exceljs';
import { pool } from '../src/config/db.js';
import { crearSoporteManual } from '../src/modules/facturacion/soporte.service.js';
import { importarSoportes } from '../src/modules/facturacion/soporte-importar.service.js';
import { construirAsiento } from '../src/modules/contabilidad/contabilizacion.service.js';

const db = (await pool.query('SELECT current_database() AS db')).rows[0].db;
if (db !== 'jdd_dev') throw new Error(`Base inesperada: ${db}`);
let fallos = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) fallos += 1; };
const q = async (sql, params) => (await pool.query(sql, params)).rows;

const admin = (await q(`SELECT id FROM sst.usuarios WHERE rol = 'admin' ORDER BY creado_en LIMIT 1`))[0];
const tercero = (await q(`SELECT id, numero_documento FROM sst.terceros WHERE activo ORDER BY creado_en LIMIT 1`))[0];
const cuenta = (await q(`SELECT id FROM sst.cuentas_contables WHERE codigo = '51101001'`))[0];
if (!tercero || !cuenta) throw new Error('jdd_dev necesita un tercero activo y la cuenta 51101001.');
const creados = [];

try {
  // 1 · DS manual + asiento, con ROLLBACK.
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    try {
      await crearSoporteManual({ tercero_id: tercero.id, lineas: [{ descripcion: 'Sin cuenta', cantidad: 1, valor_unitario: 1000 }] }, admin.id, { client: c });
      ok(false, 'línea sin cuenta rechazada');
    } catch (e) { ok(e.statusCode === 400, `línea sin cuenta rechazada (${e.message})`); }
    await c.query('ROLLBACK');
    await c.query('BEGIN');
    const ds = await crearSoporteManual({
      tercero_id: tercero.id, observaciones: 'Prueba A4-02',
      lineas: [{ descripcion: 'Honorarios contabilidad septiembre', cantidad: 1, valor_unitario: '1.500.000,00'.replace(/\./g, '').replace(',', '.'), cuenta_id: cuenta.id }],
    }, admin.id, { client: c });
    ok(ds.tipo === 'DOC_SOPORTE' && ds.estado === 'BORRADOR' && !ds.precuenta_id, `DS manual en borrador ${ds.reference_code}`);
    ok(Number(ds.total_a_pagar) === 1500000, `total ${ds.total_a_pagar}`);
    const a = await construirAsiento(ds.id, c);
    const codigos = new Map((await c.query(`SELECT id, codigo FROM sst.cuentas_contables WHERE id = ANY($1::uuid[])`, [a.lineas.map((l) => l.cuenta_id)])).rows.map((x) => [x.id, x.codigo]));
    console.log('   asiento:', a.lineas.map((l) => `${codigos.get(l.cuenta_id)} ${l.debito ? 'D ' + l.debito : 'C ' + l.credito}`).join(' | '));
    ok(a.lineas.some((l) => codigos.get(l.cuenta_id) === '51101001' && Number(l.debito) === 1500000), 'débito a la cuenta elegida (51101001)');
    ok(a.lineas.some((l) => codigos.get(l.cuenta_id) === '23352501' && Number(l.credito) === 1500000), 'crédito a honorarios por pagar (23352501)');
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }

  // 2 · Carga masiva.
  const excel = async (filas) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Documentos soporte');
    ws.addRow(['Documento del proveedor', 'Referencia', 'Detalle', 'Cantidad', 'Valor unitario', 'Cuenta de costo o gasto', 'Observación']);
    ws.addRow(['Cédula o NIT sin dígito de verificación; debe existir en Terceros', '', '', '', '', '', '']);
    for (const f of filas) ws.addRow(f);
    return Buffer.from(await wb.xlsx.writeBuffer());
  };
  const malo = await excel([
    [tercero.numero_documento, 'PRUEBA-A402', 'Honorarios parte 1', 2, 100000, '51101001', 'Prueba'],
    [tercero.numero_documento, 'PRUEBA-A402', 'Honorarios parte 2', 1, 50000, '51101001', ''],
    [tercero.numero_documento, '', 'Cuenta inexistente', 1, 1000, '00000001', ''],
  ]);
  const r1 = await importarSoportes(malo, { usuarioId: admin.id, simular: false });
  if (r1.importados) creados.push(...(await q(`SELECT id FROM sst.documentos_electronicos WHERE tipo = 'DOC_SOPORTE' AND estado = 'BORRADOR' AND creado_en > now() - interval '1 minute'`)).map((x) => x.id));
  ok(r1.documentos === 2 && r1.errores === 1 && r1.importados === 0, `con un error no guarda nada (${r1.documentos} documentos, ${r1.errores} error: ${r1.resultados.find((x) => x.error)?.error})`);
  const bueno = await excel([
    [tercero.numero_documento, 'PRUEBA-A402', 'Honorarios parte 1', 2, 100000, '51101001', 'Prueba'],
    [tercero.numero_documento, 'PRUEBA-A402', 'Honorarios parte 2', 1, 50000, '51101001', ''],
  ]);
  const r2 = await importarSoportes(bueno, { usuarioId: admin.id, simular: true });
  ok(r2.errores === 0 && r2.documentos === 1 && Number(r2.total) === 250000 && r2.importados === 0, `revisión sin errores: 1 documento por ${r2.total}, nada guardado`);
  const r3 = await importarSoportes(bueno, { usuarioId: admin.id, simular: false });
  ok(r3.importados === 1, `importado: ${r3.importados} borrador`);
  const nuevos = await q(
    `SELECT d.id, d.total_a_pagar, (SELECT count(*)::int FROM sst.documento_items i WHERE i.documento_id = d.id) AS lineas
       FROM sst.documentos_electronicos d WHERE d.tipo = 'DOC_SOPORTE' AND d.estado = 'BORRADOR' AND d.observaciones = 'Prueba'`,
  );
  creados.push(...nuevos.map((n) => n.id));
  ok(nuevos.length === 1 && nuevos[0].lineas === 2 && Number(nuevos[0].total_a_pagar) === 250000, 'quedó un borrador con 2 líneas por 250.000');
} finally {
  if (creados.length) await q(`DELETE FROM sst.documentos_electronicos WHERE id = ANY($1::uuid[]) AND estado = 'BORRADOR'`, [creados]);
  await pool.end();
}
console.log(fallos ? `\n${fallos} comprobación(es) fallaron.` : '\nTodo en verde.');
process.exitCode = fallos ? 1 : 0;
