// Verifica los cambios del 5-oct-2026 contra jdd_dev DENTRO de una transacción
// con ROLLBACK (no deja nada):
//   · varios asesores en una orden (`sst.orden_coasesores` + las dos vistas de la
//     cuenta de cobro): cada uno cobra sus horas y que uno ya esté en su cuenta
//     no da por cobradas las del otro;
//   · que las órdenes SIN coasesores salgan en la vista exactamente igual que antes;
//   · el catálogo de especialidades.
//
// Aplica las dos migraciones dentro de la misma transacción, estén o no ya puestas
// (son idempotentes).
//
// Uso: node --import tsx scripts/verificar-coasesores.mjs   (requiere el túnel a jdd_dev)
import { readFileSync } from 'node:fs';
import { pool } from '../src/config/db.js';
import { resumenPorMes } from '../src/modules/billing/billing.service.js';
import { coasesoresDeOrden } from '../src/modules/orders/orders.service.js';

let fallos = 0;
const igual = (obtenido, esperado, texto) => {
  const ok = JSON.stringify(obtenido) === JSON.stringify(esperado);
  if (!ok) fallos++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${texto} → ${JSON.stringify(obtenido)}${ok ? '' : ` (esperado ${JSON.stringify(esperado)})`}`);
};
const sinTransaccion = (archivo) => readFileSync(new URL(`../db/migraciones/${archivo}`, import.meta.url), 'utf8')
  .replace(/^\s*BEGIN;\s*$/m, '').replace(/^\s*COMMIT;\s*$/m, '');

const client = await pool.connect();
try {
  await client.query('BEGIN');

  // Foto de la vista ANTES de migrar: lo que hoy se le paga a cada quien.
  const foto = async () => (await client.query(
    `SELECT orden_id, profesional_id, horas::float AS horas, valor_hora_cobro::float AS valor,
            valor_cobro_total::float AS total, viaticos_valor::float AS viaticos, periodo
       FROM sst.vw_horas_ejecutadas ORDER BY orden_id, profesional_id`
  )).rows;
  const antes = await foto();

  await client.query(sinTransaccion('2026-10-05-coasesores.sql'));
  await client.query(sinTransaccion('2026-10-05-especialidades.sql'));

  // Se compara entera, pero se imprime solo el veredicto: son muchas filas.
  igual(JSON.stringify(await foto()) === JSON.stringify(antes), true,
    `la vista de horas no cambia para las ${antes.length} filas que ya existían`);

  // ---- Especialidades ----
  const esp = await client.query(`SELECT count(*)::int AS n FROM sst.especialidades`);
  igual(esp.rows[0].n >= 6, true, `el catálogo de especialidades nace sembrado (${esp.rows[0].n})`);
  const huerfanas = await client.query(
    `SELECT count(*)::int AS n FROM sst.profesionales p
      WHERE btrim(COALESCE(p.especialidad,'')) <> ''
        AND NOT EXISTS (SELECT 1 FROM sst.especialidades e WHERE upper(btrim(e.nombre)) = upper(btrim(p.especialidad)))`
  );
  igual(huerfanas.rows[0].n, 0, 'toda especialidad que ya tenía una ficha está en el catálogo');

  // ---- Varios asesores ----
  const profs = (await client.query(
    `INSERT INTO sst.profesionales (nombre, correo, valor_hora) VALUES
       ('ZZ PRUEBA PRINCIPAL', 'zz-principal@prueba.invalid', 50000),
       ('ZZ PRUEBA COASESOR',  'zz-coasesor@prueba.invalid',  40000)
     RETURNING id, nombre`
  )).rows;
  const [principal, coasesor] = profs;
  const orden = (await client.query(
    `INSERT INTO sst.ordenes_servicio
       (codigo, empresa_nombre, horas_asignadas, estado, profesional_asignado_id,
        valor_hora_cobro, valor_hora_origen, viaticos_valor, fecha_programada, fecha_ejecucion, soportes_aceptados_en,
        arl_id, numero_orden)
     VALUES ('OS-ZZ-PRUEBA', 'EMPRESA DE PRUEBA', 8, 'FINALIZADA', $1, 50000, 'profesional', 30000,
             '2099-01-15T13:00:00Z', '2099-01-15T13:00:00Z', now(),
             (SELECT id FROM sst.arls ORDER BY nombre LIMIT 1), 'ZZ-PRUEBA-COASESORES')
     RETURNING id`,
    [principal.id]
  )).rows[0];

  const filas = async () => (await client.query(
    `SELECT profesional_nombre AS quien, horas::float AS horas, valor_hora_cobro::float AS valor,
            valor_cobro_total::float AS total, COALESCE(viaticos_valor, 0)::float AS viaticos
       FROM sst.vw_horas_por_cobrar WHERE orden_id = $1 ORDER BY profesional_nombre DESC`,
    [orden.id]
  )).rows;

  igual(await filas(), [
    { quien: 'ZZ PRUEBA PRINCIPAL', horas: 8, valor: 50000, total: 400000, viaticos: 30000 },
  ], 'sin coasesores: una fila, las 8 h al principal');

  await client.query(
    `INSERT INTO sst.orden_coasesores (orden_id, profesional_id, horas, valor_hora_cobro, valor_hora_origen)
     VALUES ($1, $2, 4, 40000, 'profesional')`,
    [orden.id, coasesor.id]
  );
  igual(await filas(), [
    { quien: 'ZZ PRUEBA PRINCIPAL', horas: 4, valor: 50000, total: 200000, viaticos: 30000 },
    { quien: 'ZZ PRUEBA COASESOR', horas: 4, valor: 40000, total: 160000, viaticos: 0 },
  ], 'con coasesor: 4 h y 4 h, cada uno con su valor hora; los viáticos solo al principal');

  igual((await coasesoresDeOrden(orden.id, client)).map((c) => [c.nombre, c.horas]),
    [['ZZ PRUEBA COASESOR', 4]], 'coasesoresDeOrden devuelve al adicional con sus horas');

  // La pantalla de Cuentas de cobro: una fila por profesional y mes.
  const resumen = await resumenPorMes({ anio: 2099, client });
  const lista = Array.isArray(resumen) ? resumen : (resumen.filas ?? resumen.data ?? []);
  const deLaPrueba = lista
    .filter((f) => f.periodo === '2099-01')
    .map((f) => [f.profesional_nombre, Number(f.total_horas), Number(f.total_monto)])
    .sort((a, b) => (a[0] < b[0] ? 1 : -1));
  igual(deLaPrueba, [
    ['ZZ PRUEBA PRINCIPAL', 4, 230000],
    ['ZZ PRUEBA COASESOR', 4, 160000],
  ], 'Cuentas de cobro de 2099-01: dos filas (principal 4 h + viáticos; coasesor 4 h)');

  // El principal ya tiene la orden en SU cuenta: lo del coasesor sigue pendiente.
  const cuenta = (await client.query(
    `INSERT INTO sst.precuentas (profesional_id, periodo, total_horas, total_monto)
     VALUES ($1, '2099-01', 4, 230000) RETURNING id`, [principal.id]
  )).rows[0];
  await client.query(
    `INSERT INTO sst.precuenta_items (precuenta_id, orden_id, horas, valor_hora_snapshot, monto)
     VALUES ($1, $2, 4, 50000, 200000)`, [cuenta.id, orden.id]
  );
  igual((await filas()).map((f) => f.quien), ['ZZ PRUEBA COASESOR'],
    'con la cuenta del principal generada, queda pendiente solo lo del coasesor');

  // Una orden con dos asesores es UNA orden en los informes de horas.
  const informe = (await client.query(
    `SELECT count(DISTINCT orden_id)::int AS ordenes, sum(horas)::float AS horas
       FROM sst.vw_horas_ejecutadas WHERE orden_id = $1`, [orden.id]
  )).rows[0];
  igual(informe, { ordenes: 1, horas: 8 }, 'en los informes cuenta como 1 orden de 8 h');
} catch (e) {
  fallos++;
  console.error('ERROR', e.message);
} finally {
  await client.query('ROLLBACK');
  client.release();
  await pool.end();
}
console.log(fallos ? `\n${fallos} fallo(s).` : '\nTodo en verde. Nada quedó escrito (ROLLBACK).');
process.exit(fallos ? 1 : 0);
