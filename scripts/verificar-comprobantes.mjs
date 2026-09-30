// Verifica B1-01 (motor de comprobantes) contra jdd_dev DENTRO de una transacción
// con ROLLBACK: el servicio y, saltándoselo con SQL directo, los triggers de la base.
// Uso: node --import tsx scripts/verificar-comprobantes.mjs   (requiere el túnel a jdd_dev)
import { pool } from '../src/config/db.js';
import {
  anularComprobante, contabilizarComprobante, crearComprobante, obtenerComprobante,
} from '../src/modules/contabilidad/comprobantes.service.js';

let fallos = 0;
const igual = (obtenido, esperado, texto) => {
  const ok = JSON.stringify(obtenido) === JSON.stringify(esperado);
  if (!ok) fallos++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${texto} → ${JSON.stringify(obtenido)}${ok ? '' : ` (esperado ${JSON.stringify(esperado)})`}`);
};

const client = await pool.connect();
let n = 0;
/** Corre `fn` en un SAVEPOINT y espera que falle con un mensaje que contenga `fragmento`. */
const rechaza = async (fn, fragmento, texto) => {
  const sp = `sp_${++n}`;
  await client.query(`SAVEPOINT ${sp}`);
  try {
    await fn();
    // Los triggers diferidos solo saltan al "commit": se fuerzan aquí.
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    fallos++;
    console.log(`FAIL ${texto} → no lanzó error`);
  } catch (e) {
    const ok = e.message.includes(fragmento);
    if (!ok) fallos++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${texto} → ${e.message.slice(0, 120)}`);
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    await client.query('SET CONSTRAINTS ALL DEFERRED');
  }
};

try {
  await client.query('BEGIN');
  const cuenta = async (codigo) => (await client.query(`SELECT id FROM sst.cuentas_contables WHERE codigo = $1`, [codigo])).rows[0].id;
  const clientes = await cuenta('13050501'); // exige tercero
  const ingresos = await cuenta('41800101');
  const banco = await cuenta('11100501');
  const grupo1305 = await cuenta('1305');     // agrupa: no recibe movimiento
  const axa = (await client.query(`SELECT tercero_id FROM sst.arls WHERE nombre = 'AXA Colpatria'`)).rows[0].tercero_id;
  const usuario = (await client.query(`SELECT id FROM sst.usuarios WHERE rol::text = 'admin' LIMIT 1`)).rows[0].id;
  const consecutivoNI = (await client.query(`SELECT consecutivo_actual FROM sst.tipos_comprobante WHERE codigo = 'NI'`)).rows[0].consecutivo_actual;
  const op = { client };

  const cuadrado = [
    { cuenta_id: clientes, tercero_id: axa, debito: '1000000.50' },
    { cuenta_id: ingresos, credito: '1000000.50', descripcion: 'Servicios SST' },
  ];

  console.log('\n— Servicio —');
  const b = await crearComprobante({ tipo: 'NI', fecha: '2026-09-15', descripcion: 'Prueba', lineas: cuadrado }, usuario, op);
  igual([b.estado, b.numero, b.total_debito, b.movimientos.length], ['BORRADOR', null, '1000000.50', 2], 'borrador sin número, con sus dos líneas');
  const c = await contabilizarComprobante(b.id, usuario, op);
  igual([c.estado, c.numero, c.numero_completo], ['CONTABILIZADO', consecutivoNI + 1, `NI-${consecutivoNI + 1}`], 'contabilizar le da el siguiente consecutivo');
  const directo = await crearComprobante({ tipo: 'NI', fecha: '2026-09-16', lineas: cuadrado, contabilizar: true }, usuario, op);
  igual(directo.numero, consecutivoNI + 2, 'contabilizar al crear también numera, sin huecos');

  await rechaza(() => crearComprobante({ tipo: 'NI', fecha: '2026-09-15', lineas: [
    { cuenta_id: clientes, tercero_id: axa, debito: 100 }, { cuenta_id: ingresos, credito: 90 }], contabilizar: true }, usuario, op),
  'no cuadra', 'descuadrado no se contabiliza');
  await rechaza(() => crearComprobante({ tipo: 'NI', fecha: '2026-09-15', lineas: [
    { cuenta_id: grupo1305, tercero_id: axa, debito: 100 }, { cuenta_id: ingresos, credito: 100 }] }, usuario, op),
  'no recibe movimiento', 'una cuenta que agrupa no recibe movimiento');
  await rechaza(() => crearComprobante({ tipo: 'NI', fecha: '2026-09-15', lineas: [
    { cuenta_id: clientes, debito: 100 }, { cuenta_id: ingresos, credito: 100 }] }, usuario, op),
  'exige tercero', 'la cuenta de clientes exige tercero');
  await rechaza(() => crearComprobante({ tipo: 'NI', fecha: '2026-09-15', lineas: [
    { cuenta_id: banco, debito: 100, credito: 100 }, { cuenta_id: ingresos, credito: 100 }] }, usuario, op),
  'uno de los dos', 'una línea no lleva débito y crédito a la vez');
  await rechaza(() => crearComprobante({ tipo: 'FV', fecha: '2026-09-15', lineas: cuadrado }, usuario, { client, soloManual: true }),
    'los genera el sistema', 'a mano no se crea una FV');
  await rechaza(() => contabilizarComprobante(c.id, usuario, op), 'ya está contabilizado', 'no se contabiliza dos veces');

  const an = await anularComprobante(c.id, 'Prueba de anulación', usuario, op);
  igual([an.estado, an.numero, an.motivo_anulacion], ['ANULADO', consecutivoNI + 1, 'Prueba de anulación'], 'anular conserva el número y el motivo');
  await rechaza(() => anularComprobante(c.id, 'otra vez', usuario, op), 'Solo se anula', 'lo anulado no se vuelve a anular');
  await rechaza(() => anularComprobante(directo.id, 'x', usuario, op), 'motivo', 'anular exige motivo');

  console.log('\n— Base de datos (saltándose el servicio) —');
  await rechaza(() => client.query(`UPDATE sst.movimientos SET debito = 1 WHERE comprobante_id = $1`, [directo.id]),
    'no se modifican', 'las líneas de un contabilizado no se editan');
  await rechaza(() => client.query(`DELETE FROM sst.movimientos WHERE comprobante_id = $1`, [directo.id]),
    'no se modifican', 'ni se borran');
  await rechaza(() => client.query(`UPDATE sst.comprobantes SET fecha = '2026-09-20' WHERE id = $1`, [directo.id]),
    'no se edita', 'la fecha de un contabilizado no cambia');
  await rechaza(() => client.query(`DELETE FROM sst.comprobantes WHERE id = $1`, [directo.id]),
    'se anula', 'un contabilizado no se borra');
  await rechaza(() => client.query(`UPDATE sst.comprobantes SET descripcion = 'x' WHERE id = $1`, [c.id]),
    'anulado', 'un anulado no admite cambios');
  await rechaza(async () => {
    const t = (await client.query(`SELECT id FROM sst.tipos_comprobante WHERE codigo = 'NI'`)).rows[0].id;
    // Como lo haría un script: borrador, líneas descuadradas y pasarlo a contabilizado.
    const id = (await client.query(
      `INSERT INTO sst.comprobantes (tipo_id, fecha, total_debito, total_credito)
       VALUES ($1, '2026-09-15', 100, 100) RETURNING id`, [t])).rows[0].id;
    await client.query(`INSERT INTO sst.movimientos (comprobante_id, linea, cuenta_id, debito) VALUES ($1, 1, $2, 100)`, [id, banco]);
    await client.query(`INSERT INTO sst.movimientos (comprobante_id, linea, cuenta_id, credito) VALUES ($1, 2, $2, 90)`, [id, ingresos]);
    await client.query(`UPDATE sst.comprobantes SET estado = 'CONTABILIZADO', numero = 999999 WHERE id = $1`, [id]);
  }, 'no cuadra', 'un asiento descuadrado escrito directo lo para el trigger diferido');
  await rechaza(async () => {
    const t = (await client.query(`SELECT id FROM sst.tipos_comprobante WHERE codigo = 'NI'`)).rows[0].id;
    const id = (await client.query(
      `INSERT INTO sst.comprobantes (tipo_id, fecha, total_debito, total_credito) VALUES ($1, '2026-09-15', 100, 100) RETURNING id`, [t])).rows[0].id;
    await client.query(`INSERT INTO sst.movimientos (comprobante_id, linea, cuenta_id, debito) VALUES ($1, 1, $2, 100)`, [id, clientes]);
    await client.query(`INSERT INTO sst.movimientos (comprobante_id, linea, cuenta_id, credito) VALUES ($1, 2, $2, 100)`, [id, ingresos]);
    await client.query(`UPDATE sst.comprobantes SET estado = 'CONTABILIZADO', numero = 999999 WHERE id = $1`, [id]);
  }, 'exige tercero', 'y uno sin el tercero que exige la cuenta');

  console.log('\n— Periodo cerrado —');
  await client.query(`INSERT INTO sst.periodos_contables (anio, mes, estado) VALUES (2026, 8, 'CERRADO')
                      ON CONFLICT (anio, mes) DO UPDATE SET estado = 'CERRADO'`);
  const ago = await crearComprobante({ tipo: 'NI', fecha: '2026-08-20', lineas: cuadrado }, usuario, op);
  igual(ago.estado, 'BORRADOR', 'un borrador sí se puede dejar en un mes cerrado');
  await rechaza(() => contabilizarComprobante(ago.id, usuario, op), 'está cerrado', 'no se contabiliza en un mes cerrado');
  await rechaza(() => client.query(
    `UPDATE sst.comprobantes SET estado = 'CONTABILIZADO', numero = 999998 WHERE id = $1`, [ago.id]),
  'cerrado', 'ni saltándose el servicio');

  console.log('\n— Origen único —');
  const conOrigen = { tipo: 'NI', fecha: '2026-09-15', lineas: cuadrado, origen_tipo: 'PRUEBA', origen_id: '00000000-0000-0000-0000-000000000001', contabilizar: true };
  await crearComprobante(conOrigen, usuario, op);
  await rechaza(() => crearComprobante(conOrigen, usuario, op), 'duplicate', 'un documento no se contabiliza dos veces');

  const leido = await obtenerComprobante(directo.id, client);
  igual([leido.movimientos[0].tercero_nombre != null, leido.movimientos[1].cuenta_codigo], [true, '41800101'], 'el detalle trae nombres de tercero y cuenta');
} finally {
  await client.query('ROLLBACK');
  client.release();
  const restos = (await pool.query(`SELECT count(*)::int AS n FROM sst.comprobantes`)).rows[0].n;
  const periodos = (await pool.query(`SELECT count(*)::int AS n FROM sst.periodos_contables`)).rows[0].n;
  console.log(`\nResiduos tras el ROLLBACK: ${restos} comprobantes, ${periodos} periodos`);
  if (restos || periodos) fallos++;
  await pool.end();
}
console.log(fallos ? `\n${fallos} FALLO(S)` : '\nTodo OK');
process.exit(fallos ? 1 : 0);
