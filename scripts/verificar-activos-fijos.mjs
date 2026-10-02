// Verifica C7-01 (activos fijos, depreciación mensual y QR) contra jdd_dev DENTRO
// de una transacción con ROLLBACK. Los meses de prueba son de 2024, que no tiene
// movimientos reales. Aplica la migración dentro de la transacción si falta.
// Uso: node --import tsx scripts/verificar-activos-fijos.mjs   (requiere el túnel)
import fs from 'node:fs';
import { pool } from '../src/config/db.js';
import { anularComprobante, obtenerComprobante } from '../src/modules/contabilidad/comprobantes.service.js';
import {
  actualizarActivo, crearActivo, cuotaCentavos, depreciarMes, eliminarActivo, listarActivos, obtenerActivo, qrActivo,
  revertirDepreciacion, vistaPreviaDepreciacion,
} from '../src/modules/contabilidad/activos.service.js';
import { balanceComprobacion } from '../src/modules/informes-contables/balance.service.js';

let fallos = 0;
const igual = (obtenido, esperado, texto) => {
  const ok = JSON.stringify(obtenido) === JSON.stringify(esperado);
  if (!ok) fallos++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${texto}${ok ? '' : `\n     obtenido ${JSON.stringify(obtenido)}\n     esperado ${JSON.stringify(esperado)}`}`);
};

const client = await pool.connect();
let n = 0;
const rechaza = async (fn, fragmento, texto) => {
  const sp = `sp_${++n}`;
  await client.query(`SAVEPOINT ${sp}`);
  try {
    await fn();
    fallos++; console.log(`FAIL ${texto} → no lanzó error`);
  } catch (e) {
    const ok = e.message.includes(fragmento);
    if (!ok) fallos++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${texto} → ${e.message.slice(0, 120)}`);
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
  }
};

try {
  await client.query('BEGIN');
  const existe = (await client.query(`SELECT to_regclass('sst.activos_fijos') AS t`)).rows[0].t;
  if (!existe) {
    const sql = fs.readFileSync('db/migraciones/2026-10-02-activos-fijos.sql', 'utf8').replace(/^BEGIN;|^COMMIT;/gm, '');
    await client.query(sql);
    console.log('(migración aplicada dentro de la transacción)');
  }
  const q1 = async (sql, p = []) => (await client.query(sql, p)).rows[0];
  const previos = (await q1(`SELECT count(*)::int AS n FROM sst.comprobantes WHERE fecha < '2025-01-01'`)).n;
  igual(previos, 0, 'no hay comprobantes antes de 2025 (cifras exactas)');

  // Cuentas de prueba (el PUC de desarrollo no trae propiedad, planta y equipo).
  const cuenta = async (codigo) => (await q1(`SELECT id FROM sst.cuentas_contables WHERE codigo = $1`, [codigo]))?.id;
  const nueva = async (codigo, nombre, naturaleza, mov = false) => {
    const ya = await cuenta(codigo);
    if (ya) return ya;
    const padre = codigo.length === 1 ? null : await cuenta(codigo.slice(0, [0, 1, 2, 2, 4, 4, 6, 6, 8][codigo.length - 1] ?? codigo.length - 2));
    return (await q1(
      `INSERT INTO sst.cuentas_contables (codigo, nombre, naturaleza, padre_id, acepta_movimiento) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [codigo, nombre, naturaleza, padre, mov])).id;
  };
  await nueva('15', 'Propiedad, planta y equipo', 'DEBITO');
  await nueva('1528', 'Equipo de computación', 'DEBITO');
  await nueva('152805', 'Equipos de procesamiento de datos', 'DEBITO');
  const cActivo = await nueva('15280501', 'Computadores (prueba)', 'DEBITO', true);
  await nueva('1592', 'Depreciación acumulada', 'CREDITO');
  await nueva('159220', 'Equipo de computación', 'CREDITO');
  const cDep = await nueva('15922001', 'Depreciación computadores (prueba)', 'CREDITO', true);
  await nueva('51', 'Operacionales de administración', 'DEBITO');
  await nueva('5160', 'Depreciaciones', 'DEBITO');
  await nueva('516020', 'Equipo de computación', 'DEBITO');
  const cGasto = await nueva('51602001', 'Gasto depreciación computadores (prueba)', 'DEBITO', true);

  const op = { client };
  const alta = async (v) => (await crearActivo({
    descripcion: v.descripcion, fecha_compra: v.fecha_compra, valor_compra: v.valor, valor_residual: v.residual ?? 0,
    vida_util_meses: v.vida, inicio_depreciacion: v.inicio,
    cuenta_activo_id: cActivo, cuenta_depreciacion_id: cDep, cuenta_gasto_id: cGasto,
  }, null, op)).id;

  console.log('\n— Alta —');
  await rechaza(() => alta({ descripcion: 'Malo', fecha_compra: '2024-01-10', valor: '100', residual: '100', vida: 12 }), 'residual', 'el residual debe ser menor que el costo');
  const cCxc = await cuenta('13050501');
  await rechaza(() => crearActivo({ descripcion: 'Malo', fecha_compra: '2024-01-10', valor_compra: '100', vida_util_meses: 12,
    cuenta_activo_id: cActivo, cuenta_depreciacion_id: cDep, cuenta_gasto_id: cCxc }, null, op), 'exige tercero', 'una cuenta que exige tercero no sirve de gasto');
  const porDefecto = await crearActivo({ descripcion: 'Silla (prueba)', fecha_compra: '2024-06-20', valor_compra: '300000', vida_util_meses: 60,
    cuenta_activo_id: cActivo, cuenta_depreciacion_id: cDep, cuenta_gasto_id: cGasto }, null, op);
  igual([porDefecto.codigo.startsWith('AF-'), porDefecto.inicio_depreciacion], [true, '2024-07-01'], 'código AF- y, por defecto, empieza el mes siguiente a la compra');
  await eliminarActivo(porDefecto.id, op);
  igual((await q1(`SELECT count(*)::int AS n FROM sst.activos_fijos WHERE id = $1`, [porDefecto.id])).n, 0, 'sin depreciación sí se borra');

  console.log('\n— Cálculo de la cuota —');
  igual([1, 2, 3].map((k) => cuotaCentavos({ valor_compra: '1000000', valor_residual: '0', vida_util_meses: 3 }, k)), [33333333, 33333333, 33333334],
    'línea recta: 333.333,33 × 2 y la última 333.333,34 (suma exacta 1.000.000)');
  igual(cuotaCentavos({ valor_compra: '120000', valor_residual: '12000', vida_util_meses: 12 }, 5), 900000, 'con residual: (120.000 − 12.000) / 12 = 9.000');
  igual(cuotaCentavos({ valor_compra: '100', valor_residual: '0', vida_util_meses: 3 }, 4), 0, 'después de la vida útil, cero');

  const pc = await alta({ descripcion: 'Portátil (prueba)', fecha_compra: '2024-01-15', valor: '1000000', vida: 3, inicio: '2024-02-01' });
  const imp = await alta({ descripcion: 'Impresora (prueba)', fecha_compra: '2023-12-20', valor: '120000', residual: '12000', vida: 12, inicio: '2024-01-01' });

  console.log('\n— Depreciación mensual —');
  const prev = await vistaPreviaDepreciacion(2024, 1, client);
  igual([prev.activos.map((a) => a.descripcion), prev.total], [['Impresora (prueba)'], '9000.00'], 'enero: solo la impresora (el portátil empieza en febrero)');
  const ene = await depreciarMes(2024, 1, null, op);
  const dpEne = await obtenerComprobante(ene.comprobante_id, client);
  igual([dpEne.tipo_codigo, dpEne.fecha, dpEne.estado, dpEne.total_debito], ['DP', '2024-01-31', 'CONTABILIZADO', '9000.00'], 'el DP de enero, al último día del mes');
  igual(dpEne.movimientos.map((m) => [m.cuenta_codigo, m.debito, m.credito]), [['51602001', '9000.00', '0.00'], ['15922001', '0.00', '9000.00']],
    'D gasto por depreciación / C depreciación acumulada');
  await rechaza(() => depreciarMes(2024, 1, null, op), 'Ya está depreciado', 'el mismo mes no se deprecia dos veces');
  await rechaza(() => anularComprobante(ene.comprobante_id, 'prueba suelta', null, op), 'lo generó un documento', 'el DP no se anula suelto desde Contabilidad');

  // Marzo sin correr febrero: cada activo se pone al día con sus cuotas pendientes.
  const mar = await depreciarMes(2024, 3, null, op);
  igual(mar.total, '684666.66', 'marzo pone al día: portátil 2 cuotas (666.666,66) + impresora 2 (18.000)');
  const fichaPc = await obtenerActivo(pc, client);
  igual([fichaPc.cuotas_registradas, fichaPc.depreciacion_acumulada, fichaPc.valor_en_libros], [2, '666666.66', '333333.34'], 'ficha del portátil tras marzo');
  igual(fichaPc.tabla.map((t) => [t.cuota, `${t.anio}-${t.mes}`, t.valor, t.registrada]),
    [[1, '2024-2', '333333.33', true], [2, '2024-3', '333333.33', true], [3, '2024-4', '333333.34', false]], 'tabla de depreciación: registrado y proyectado');
  await rechaza(() => depreciarMes(2024, 2, null, op), 'en orden', 'no se vuelve a un mes anterior al último depreciado');

  console.log('\n— Edición con depreciación registrada —');
  await rechaza(() => actualizarActivo(pc, { valor_compra: '2000000' }, null, op), 'ya tiene depreciación', 'el valor ya no se cambia');
  const editado = await actualizarActivo(pc, { descripcion: 'Portátil del área contable (prueba)', responsable: 'CONTADORA' }, null, op);
  igual([editado.descripcion, editado.responsable, editado.valor_compra], ['Portátil del área contable (prueba)', 'CONTADORA', '1000000.00'], 'lo descriptivo sí se edita');
  await rechaza(() => eliminarActivo(pc, op), 'no se puede borrar', 'un activo depreciado no se borra');

  console.log('\n— Revertir —');
  await rechaza(() => revertirDepreciacion(2024, 1, 'prueba', null, op), 'Solo se revierte la última', 'solo la última corrida se revierte');
  await revertirDepreciacion(2024, 3, 'prueba de reversión', null, op);
  igual((await obtenerComprobante(mar.comprobante_id, client)).estado, 'ANULADO', 'revertir anula el DP de marzo');
  igual((await obtenerActivo(pc, client)).cuotas_registradas, 0, 'y borra sus cuotas');
  const mar2 = await depreciarMes(2024, 3, null, op);
  igual(mar2.total, mar.total, 'el mes se puede volver a correr y da lo mismo');
  const abr = await depreciarMes(2024, 4, null, op);
  igual(abr.total, '342333.34', 'abril: última cuota del portátil (333.333,34) + 9.000 de la impresora');
  const fin = await obtenerActivo(pc, client);
  igual([fin.depreciacion_acumulada, fin.valor_en_libros, fin.totalmente_depreciado], ['1000000.00', '0.00', true], 'el portátil termina en su valor residual (0), exacto');
  const may = await vistaPreviaDepreciacion(2024, 5, client);
  igual(may.activos.map((a) => a.descripcion), ['Impresora (prueba)'], 'mayo: el portátil ya no deprecia');

  const b = await balanceComprobacion({ desde: '2024-01-01', hasta: '2024-12-31' }, client);
  const fila = (c) => b.filas.find((f) => f.codigo === c)?.saldo_final;
  igual([fila('51602001'), fila('15922001'), b.cuadra], ['1036000.00', '-1036000.00', true], 'el balance de 2024: 1.000.000 del portátil + 4 cuotas de 9.000 de la impresora, y cuadra');

  console.log('\n— Listado y QR —');
  const lista = await listarActivos(client);
  igual(lista.filter((a) => [pc, imp].includes(a.id)).map((a) => a.cuotas_registradas), [3, 4], 'el listado trae las cuotas de cada activo');
  const png = await qrActivo(pc, client);
  igual(png.subarray(1, 4).toString(), 'PNG', 'el QR sale como imagen PNG');
  await rechaza(() => depreciarMes(2100, 1, null, op), 'aún no empieza', 'no se deprecia un mes futuro');
} finally {
  await client.query('ROLLBACK');
  client.release();
  await pool.end();
}

console.log(`\n${fallos ? `${fallos} FALLO(S)` : 'Todo OK'}`);
process.exit(fallos ? 1 : 0);
