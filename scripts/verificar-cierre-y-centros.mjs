// Verifica B8-01 (centros de costo) y B10-01 (cierre de año) contra jdd_dev DENTRO
// de una transacción con ROLLBACK. El cierre se prueba con años sin movimientos
// reales (2025 con utilidad, 2024 con pérdida) para no tocar los asientos de 2026.
// Uso: node --import tsx scripts/verificar-cierre-y-centros.mjs   (requiere el túnel)
import { pool } from '../src/config/db.js';
import { anularComprobante, crearComprobante, obtenerComprobante } from '../src/modules/contabilidad/comprobantes.service.js';
import { cerrarAnio, vistaPreviaCierre } from '../src/modules/contabilidad/cierre.service.js';

let fallos = 0;
const igual = (obtenido, esperado, texto) => {
  const ok = JSON.stringify(obtenido) === JSON.stringify(esperado);
  if (!ok) fallos++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${texto}${ok ? '' : `\n     obtenido ${JSON.stringify(obtenido)}\n     esperado ${JSON.stringify(esperado)}`}`);
};
const ordenar = (ls) => [...ls].sort((a, b) => (a[0] + a[1] + a[2]).localeCompare(b[0] + b[1] + b[2]));

const client = await pool.connect();
let n = 0;
const rechaza = async (fn, fragmento, texto) => {
  const sp = `sp_${++n}`;
  await client.query(`SAVEPOINT ${sp}`);
  try {
    await fn();
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    fallos++; console.log(`FAIL ${texto} → no lanzó error`);
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
  const q1 = async (sql, p = []) => (await client.query(sql, p)).rows[0];
  const cuenta = async (codigo) => (await q1(`SELECT id FROM sst.cuentas_contables WHERE codigo = $1`, [codigo])).id;
  const op = { client };
  const banco = await cuenta('11100501');
  const ingreso = await cuenta('41800101');
  const combustible = await cuenta('51953501');
  const ni = (fecha, lineas, extra = {}) => crearComprobante({ tipo: 'NI', fecha, lineas, contabilizar: true, ...extra }, null, op);

  console.log('\n— Centros de costo —');
  const cc = (await q1(`INSERT INTO sst.centros_costo (codigo, nombre) VALUES ('ZZ-TRANSP', 'Transporte (prueba)') RETURNING id`)).id;
  const ccInactivo = (await q1(`INSERT INTO sst.centros_costo (codigo, nombre, activo) VALUES ('ZZ-OFF', 'Inactivo', false) RETURNING id`)).id;
  await client.query(`UPDATE sst.cuentas_contables SET exige_centro_costo = true WHERE id = $1`, [combustible]);
  await rechaza(() => ni('2026-09-20', [{ cuenta_id: combustible, debito: 5000 }, { cuenta_id: banco, credito: 5000 }]),
    'exige centro de costo', 'una cuenta que exige centro de costo no acepta la línea sin él');
  await rechaza(() => ni('2026-09-20', [{ cuenta_id: combustible, centro_costo_id: ccInactivo, debito: 5000 }, { cuenta_id: banco, credito: 5000 }]),
    'inactivo', 'un centro de costo inactivo no se usa');
  const conCc = await ni('2026-09-20', [{ cuenta_id: combustible, centro_costo_id: cc, debito: 5000 }, { cuenta_id: banco, credito: 5000 }]);
  const leido = await obtenerComprobante(conCc.id, client);
  igual(leido.movimientos.find((m) => m.cuenta_id === combustible).centro_costo_codigo, 'ZZ-TRANSP', 'con el centro de costo se contabiliza y el detalle lo muestra');
  await rechaza(async () => {
    const t = (await q1(`SELECT id FROM sst.tipos_comprobante WHERE codigo = 'NI'`)).id;
    const id = (await q1(`INSERT INTO sst.comprobantes (tipo_id, fecha, total_debito, total_credito) VALUES ($1, '2026-09-20', 5000, 5000) RETURNING id`, [t])).id;
    await client.query(`INSERT INTO sst.movimientos (comprobante_id, linea, cuenta_id, debito) VALUES ($1, 1, $2, 5000)`, [id, combustible]);
    await client.query(`INSERT INTO sst.movimientos (comprobante_id, linea, cuenta_id, credito) VALUES ($1, 2, $2, 5000)`, [id, banco]);
    await client.query(`UPDATE sst.comprobantes SET estado = 'CONTABILIZADO', numero = 999999 WHERE id = $1`, [id]);
  }, 'exige centro de costo', 'y saltándose el servicio, lo para el trigger');
  await client.query(`UPDATE sst.cuentas_contables SET exige_centro_costo = false WHERE id = $1`, [combustible]);

  console.log('\n— Cierre de año —');
  // Patrimonio: 3 → 36 → 3605/3610 → subcuenta → auxiliar (el PUC de desarrollo no trae la clase 3).
  const nueva = async (codigo, nombre, padre, mov = false) => (await q1(
    `INSERT INTO sst.cuentas_contables (codigo, nombre, naturaleza, padre_id, acepta_movimiento) VALUES ($1, $2, 'CREDITO', $3, $4) RETURNING id`,
    [codigo, nombre, padre, mov])).id;
  const c3 = await nueva('3', 'Patrimonio', null);
  const c36 = await nueva('36', 'Resultados del ejercicio', c3);
  const utilidad = await nueva('36050501', 'Utilidad del ejercicio', await nueva('360505', 'Utilidad del ejercicio', await nueva('3605', 'Utilidad del ejercicio', c36)), true);
  const perdida = await nueva('36100501', 'Pérdida del ejercicio', await nueva('361005', 'Pérdida del ejercicio', await nueva('3610', 'Pérdida del ejercicio', c36)), true);

  await ni('2025-06-10', [{ cuenta_id: banco, debito: '1000000' }, { cuenta_id: ingreso, credito: '1000000' }]);
  await ni('2025-07-10', [{ cuenta_id: combustible, debito: '300000' }, { cuenta_id: banco, credito: '300000' }]);
  const previa = await vistaPreviaCierre(2025, client);
  igual([previa.cerrado, previa.cuentas, previa.tipo_resultado, previa.resultado], [null, 2, 'UTILIDAD', '700000.00'], 'la vista previa de 2025: 2 cuentas y utilidad de 700.000');
  await rechaza(() => cerrarAnio(2025, { cuenta_utilidad_id: banco }, null, op), 'patrimonio', 'la utilidad tiene que ir a una cuenta de patrimonio');

  const cierre = await cerrarAnio(2025, { cuenta_utilidad_id: utilidad, cuenta_perdida_id: perdida }, null, op);
  igual([cierre.tipo_resultado, cierre.resultado, cierre.comprobante.startsWith('CA-')], ['UTILIDAD', '700000.00', true], 'el cierre genera el CA con la utilidad');
  const ca = await obtenerComprobante(cierre.comprobante_id, client);
  igual(ordenar(ca.movimientos.map((m) => [m.cuenta_codigo, Number(m.debito) ? 'D' : 'C', Number(m.debito) ? m.debito : m.credito])),
    ordenar([['41800101', 'D', '1000000.00'], ['51953501', 'C', '300000.00'], ['36050501', 'C', '700000.00']]),
    'CA: D ingresos, C gastos y C utilidad del ejercicio, al 31 de diciembre');
  igual(ca.fecha, '2025-12-31', 'fechado el 31 de diciembre');
  const resto = (await q1(
    `SELECT COALESCE(sum(m.debito - m.credito), 0) AS s FROM sst.movimientos m
       JOIN sst.comprobantes c ON c.id = m.comprobante_id AND c.estado = 'CONTABILIZADO' AND c.anio = 2025
       JOIN sst.cuentas_contables cc ON cc.id = m.cuenta_id WHERE left(cc.codigo, 1) IN ('4','5','6','7')`)).s;
  igual(resto, '0.00', 'las cuentas de resultado de 2025 quedan en cero');
  igual((await q1(`SELECT count(*)::int AS n FROM sst.periodos_contables WHERE anio = 2025 AND estado = 'CERRADO'`)).n, 12, 'los doce meses de 2025 quedan cerrados');
  await rechaza(() => cerrarAnio(2025, { cuenta_utilidad_id: utilidad }, null, op), 'ya está cerrado', 'un año no se cierra dos veces');
  await rechaza(() => ni('2025-05-02', [{ cuenta_id: banco, debito: 1 }, { cuenta_id: ingreso, credito: 1 }]), 'cerrado', 'nada se contabiliza en el año cerrado');
  await rechaza(() => anularComprobante(cierre.comprobante_id, 'intento de reabrir', null, op), 'no se reversa', 'el CA no se anula (D-20)');

  await ni('2024-03-15', [{ cuenta_id: combustible, debito: '120000' }, { cuenta_id: banco, credito: '120000' }]);
  const cierre24 = await cerrarAnio(2024, { cuenta_utilidad_id: utilidad, cuenta_perdida_id: perdida }, null, op);
  const ca24 = await obtenerComprobante(cierre24.comprobante_id, client);
  igual([cierre24.tipo_resultado, ca24.movimientos.find((m) => m.cuenta_codigo === '36100501')?.debito], ['PERDIDA', '120000.00'],
    'un año con pérdida la lleva, al débito, a la cuenta de pérdida');
  await rechaza(() => cerrarAnio(2023, { cuenta_utilidad_id: utilidad, cuenta_perdida_id: perdida }, null, op), 'nada que cerrar', 'un año sin movimientos no se cierra');
} finally {
  await client.query('ROLLBACK');
  client.release();
  const restos = (await pool.query(`SELECT (SELECT count(*) FROM sst.centros_costo)::int + (SELECT count(*) FROM sst.periodos_contables WHERE anio < 2026)::int
                                          + (SELECT count(*) FROM sst.comprobantes WHERE anio < 2026)::int AS n`)).rows[0].n;
  console.log(`\nResiduos tras el ROLLBACK: ${restos}`);
  if (restos) fallos++;
  await pool.end();
}
console.log(fallos ? `\n${fallos} FALLO(S)` : '\nTodo OK');
process.exit(fallos ? 1 : 0);
