// Verifica las peticiones del 29-oct-2026 sobre cuentas de cobro contra jdd_dev DENTRO de una
// transacción con ROLLBACK (la migración se aplica dentro de la misma transacción y se deshace):
// referencia real de la orden, tema del registro de asistencia, horas editables, línea manual,
// quitar una orden (queda apartada del cobro) y devolverla, y el PDF.
// Uso: node --import tsx scripts/verificar-29-oct.mjs   (requiere el túnel)
import { readFileSync } from 'node:fs';
import { pool } from '../src/config/db.js';
import {
  agregarLineaManual, ajustarItemsPrecuenta, obtenerPrecuenta, quitarLineaPrecuenta, restaurarExclusion,
} from '../src/modules/billing/billing.service.js';
import { generatePrecuentaPdf } from '../src/services/pdf.service.js';
import { referenciaOrden } from '../src/utils/referencia-orden.js';

let fallos = 0;
const igual = (obtenido, esperado, texto) => {
  const ok = JSON.stringify(obtenido) === JSON.stringify(esperado);
  if (!ok) fallos++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${texto}${ok ? '' : `\n     obtenido ${JSON.stringify(obtenido)}\n     esperado ${JSON.stringify(esperado)}`}`);
};
const falla = async (fn, texto) => {
  try { await fn(); igual('no lanzó', 'lanza', texto); } catch (e) { igual(true, true, `${texto} (${e.message})`); }
};
const client = await pool.connect();
const q = async (sql, p = []) => (await client.query(sql, p)).rows;
const op = { client };

try {
  await client.query('BEGIN');
  const sql = readFileSync(new URL('../db/migraciones/2026-10-29-cuenta-cobro-lineas.sql', import.meta.url), 'utf8')
    .replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');
  await client.query(sql);
  igual(true, true, 'la migración corre (y se repite) sin errores');
  await client.query(sql);

  console.log('\n— Referencia —');
  igual(referenciaOrden({ codigo_cronograma: '134803', secuencia: '67' }), '134803_67', 'avisos siguen con «_»');
  igual(referenciaOrden({ codigo_cronograma: '134803', secuencia: '67' }, { separador: '-' }), '134803-67', 'cuenta de cobro con «-»');
  igual(referenciaOrden({ numero_orden: '10810250', codigo: 'OS-1' }, { separador: '-' }), '10810250', 'Sura/AXA: número de orden');

  const bolivar = (await q("SELECT id FROM sst.arls WHERE nombre ILIKE '%bol%var%' LIMIT 1"))[0].id;
  const prof = (await q(`INSERT INTO sst.profesionales (nombre, correo, valor_hora) VALUES ('ZZ PRUEBA 29OCT','zz29oct@example.com',28000) RETURNING id`))[0].id;
  const orden = async (codigo, cron, sec, tema, horas) => (await q(
    `INSERT INTO sst.ordenes_servicio (arl_id, codigo, codigo_cronograma, secuencia, empresa_nombre, tipo_actividad,
       tema_actividad, horas_asignadas, estado, profesional_asignado_id, valor_hora_cobro, fecha_ejecucion,
       soportes_aceptados_en, fecha_vencimiento)
     VALUES ($1,$2,$3,$4,'ZZ EMPRESA 29OCT','CAP SEGURIDAD VIAL',$5,$6,'FINALIZADA'::sst.estado_orden,$7,28000,'2099-03-10',now(),'2099-12-31')
     RETURNING id`, [bolivar, codigo, cron, sec, tema, horas, prof]))[0].id;
  const o1 = await orden('OS-ZZ-2901', '9134803', '67', 'Plan estratégico de seguridad vial', 19);
  const o2 = await orden('OS-ZZ-2902', '9134803', '68', null, 2);

  // La cuenta como la deja `generarPrecuentas` (que usa el pool y no ve esta transacción): mismas columnas.
  const pc = (await q(
    `INSERT INTO sst.precuentas (profesional_id, periodo, total_horas, total_monto, total_viaticos, estado, token)
     VALUES ($1,'2099-03',21,588000,0,'generada','zz29oct-token') RETURNING id`, [prof]))[0].id;
  for (const [o, cron, sec, act, h] of [[o1, '9134803', '67', 'Plan estratégico de seguridad vial', 19], [o2, '9134803', '68', 'CAP SEGURIDAD VIAL', 2]]) {
    await q(`INSERT INTO sst.precuenta_items (precuenta_id, orden_id, orden_codigo, orden_referencia, empresa_nombre, arl_nombre,
               actividad, fecha_ejecucion, horas, valor_hora_snapshot, monto, viaticos, origen_tarifa)
             VALUES ($1,$2,'X',$3,'ZZ EMPRESA 29OCT','Bolívar',$4,'2099-03-10',$5,28000,$6,0,'orden')`,
    [pc, o, `${cron}-${sec}`, act, h, h * 28000]);
  }

  console.log('\n— Horas editables (19 → 9) —');
  let d = await obtenerPrecuenta(pc, client);
  const l1 = d.items.find((i) => i.orden_id === o1);
  d = await ajustarItemsPrecuenta(pc, [{ id: l1.id, horas: 9 }], null, op);
  const l1b = d.items.find((i) => i.orden_id === o1);
  igual([Number(l1b.horas), Number(l1b.horas_original), Number(l1b.monto)], [9, 19, 252000], 'la línea queda en 9 h, recuerda las 19 y vale 9 × 28.000');
  igual([Number(d.total_horas), Number(d.total_monto)], [11, 308000], 'los totales se recalculan');
  igual(l1b.valor_hora_original, null, 'el valor hora no se marca como cambiado si no se tocó');
  await falla(() => ajustarItemsPrecuenta(pc, [{ id: l1.id, horas: 0 }], null, op), 'cero horas se rechaza');

  console.log('\n— Línea manual —');
  await falla(() => agregarLineaManual(pc, { actividad: 'X', horas: 2, valor_hora: 28000, fecha_ejecucion: '2099-04-01' }, null, op), 'fecha fuera del mes se rechaza');
  await falla(() => agregarLineaManual(pc, { actividad: '', horas: 2, valor_hora: 28000 }, null, op), 'sin actividad se rechaza');
  d = await agregarLineaManual(pc, { actividad: 'Gestión SG-SST en Comtexaco', empresa_nombre: 'COMTEXACO', horas: 4, valor_hora: 30000, viaticos: 20000 }, null, op);
  const man = d.items.find((i) => i.manual);
  igual([man.orden_id, Number(man.monto), Number(man.viaticos), String(man.fecha_ejecucion instanceof Date ? man.fecha_ejecucion.getDate() : man.fecha_ejecucion)],
    [null, 120000, 20000, '31'], 'manual sin orden, 4 × 30.000 + viáticos, fechada el último día del mes');
  igual(d.items.at(-1).id, man.id, 'las manuales van al final');
  igual([Number(d.total_horas), Number(d.total_monto), Number(d.total_viaticos)], [15, 448000, 20000], 'totales con la manual');
  d = await ajustarItemsPrecuenta(pc, [{ id: man.id, actividad: 'Gestión en Gmaz', horas: 5 }], null, op);
  const man2 = d.items.find((i) => i.manual);
  igual([man2.actividad, Number(man2.horas), man2.ajuste_manual, man2.horas_original], ['Gestión en Gmaz', 5, false, null], 'la manual se corrige sin marcarse «ajustada»');

  console.log('\n— Quitar una orden ya pagada —');
  const l2 = d.items.find((i) => i.orden_id === o2);
  d = await quitarLineaPrecuenta(pc, l2.id, null, null, op);
  igual(d.items.some((i) => i.orden_id === o2), false, 'la línea sale de la cuenta');
  igual(d.excluidas.map((x) => [x.orden_referencia, x.motivo]), [['9134803-68', 'Ya pagada por fuera de ORBITA']], 'queda en «apartadas del cobro»');
  const pend = await q(`SELECT count(*)::int AS n FROM sst.vw_horas_por_cobrar WHERE orden_id = $1`, [o2]);
  igual(pend[0].n, 0, 'la apartada no cuenta como trabajo por cobrar');
  await restaurarExclusion(o2, prof, client);
  const pend2 = await q(`SELECT count(*)::int AS n FROM sst.vw_horas_por_cobrar WHERE orden_id = $1`, [o2]);
  igual(pend2[0].n, 1, 'al devolverla vuelve a estar por cobrar');
  const solo = (await obtenerPrecuenta(pc, client)).items;
  for (const it of solo.filter((i) => i.manual)) await quitarLineaPrecuenta(pc, it.id, null, null, op);
  await falla(async () => {
    const r = (await obtenerPrecuenta(pc, client)).items;
    await client.query('SAVEPOINT s');
    try { await quitarLineaPrecuenta(pc, r[0].id, null, null, op); } finally { await client.query('ROLLBACK TO SAVEPOINT s'); }
  }, 'no se deja la cuenta en cero');

  console.log('\n— PDF —');
  await agregarLineaManual(pc, { actividad: 'Gestión SG-SST en Comtexaco', orden_referencia: 'COMTEX-1', horas: 4, valor_hora: 30000 }, null, op);
  const pdf = await generatePrecuentaPdf(await obtenerPrecuenta(pc, client));
  igual(pdf.length > 1000, true, `el PDF se genera (${pdf.length} bytes)`);

  console.log('\n— Cuenta enviada: no se toca —');
  await q(`UPDATE sst.precuentas SET estado='enviada' WHERE id=$1`, [pc]);
  await falla(() => agregarLineaManual(pc, { actividad: 'X', horas: 1, valor_hora: 1 }, null, op), 'agregar a una enviada se rechaza');
} finally {
  await client.query('ROLLBACK');
  client.release();
  await pool.end();
}
console.log(fallos ? `\n${fallos} FALLO(S)` : '\nTodo OK (nada quedó escrito: ROLLBACK)');
process.exit(fallos ? 1 : 0);
