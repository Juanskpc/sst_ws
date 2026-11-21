/**
 * 20-nov-2026 · Borra la semilla de DEMOSTRACIÓN de reportes que dejó
 * `sembrar-demo-reportes.mjs` y deja `jdd_dev` como estaba antes de sembrar.
 *
 *   node scripts/demo/borrar-demo-reportes.mjs            → ensayo: borra y hace ROLLBACK
 *   node scripts/demo/borrar-demo-reportes.mjs --aplicar  → borra y hace COMMIT
 *
 * ⛔ Se niega a correr si DATABASE_URL no apunta a `jdd_dev`.
 *
 * Borra SOLO lo que está en `demo_semilla.registro` (más lo que cuelga por cascada de esas
 * filas: movimientos, ítems, tributos, documento_ordenes, eventos) y al final el esquema
 * `demo_semilla`. Antes de tocar nada comprueba que ninguna fila AJENA a la semilla apunte a
 * una fila demo (p. ej. un recibo real que abonó una factura demo): si la hay, no borra.
 *
 * ⚠️ Única excepción a "no desactivar triggers": un comprobante CONTABILIZADO no se puede
 * borrar (trg_comprobante_transicion lo impide: se anula). Para quitar los comprobantes demo
 * se desactiva ESE trigger dentro de esta transacción (ALTER TABLE es transaccional y bloquea
 * la tabla hasta el COMMIT, así que nadie más escribe comprobantes sin él) y se reactiva antes
 * de terminar. Si algo falla, el ROLLBACK lo deja activo como estaba.
 */
import 'dotenv/config';
import pg from 'pg';

const url = process.env.DATABASE_URL || '';
if (!/\/jdd_dev(\?|$)/.test(url)) {
  console.error('DATABASE_URL no apunta a jdd_dev: no se toca nada.');
  process.exit(1);
}
const APLICAR = process.argv.includes('--aplicar');
const c = new pg.Client({ connectionString: url, ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false } });
await c.connect();
const q = (sql, p) => c.query(sql, p);
const uno = async (sql, p) => (await q(sql, p)).rows[0];

async function conteos() {
  const r = await q(`SELECT relname AS tabla FROM pg_class k JOIN pg_namespace n ON n.oid = k.relnamespace
                      WHERE n.nspname = 'sst' AND k.relkind = 'r' ORDER BY 1`);
  const out = {};
  for (const { tabla } of r.rows) out[tabla] = (await uno(`SELECT count(*)::int AS n FROM sst."${tabla}"`)).n;
  return out;
}

try {
  await q('BEGIN');
  if (!(await uno(`SELECT to_regclass('demo_semilla.registro') IS NOT NULL AS ok`)).ok) {
    console.log('No hay semilla demo (no existe demo_semilla.registro). Nada que borrar.');
    await q('ROLLBACK');
    process.exit(0);
  }
  const meta = Object.fromEntries((await q(`SELECT clave, valor FROM demo_semilla.meta`)).rows.map((r) => [r.clave, r.valor]));
  const R = `(SELECT id FROM demo_semilla.registro WHERE tabla = $1)`;
  const ids = async (t) => (await q(`SELECT id FROM demo_semilla.registro WHERE tabla = $1`, [t])).rows.map((r) => r.id);

  // 1 · Nadie ajeno puede depender de la semilla.
  const ajenos = [];
  const chequeo = async (texto, sql) => { const n = Number((await uno(sql)).n); if (n) ajenos.push(`${n} ${texto}`); };
  const D = (t) => `(SELECT id FROM demo_semilla.registro WHERE tabla = '${t}')`;
  await chequeo('aplicaciones de cartera ajenas sobre documentos demo',
    `SELECT count(*)::int AS n FROM sst.cartera_aplicaciones WHERE cartera_documento_id IN ${D('cartera_documentos')} AND id NOT IN ${D('cartera_aplicaciones')}`);
  await chequeo('documentos ajenos que referencian un documento demo',
    `SELECT count(*)::int AS n FROM sst.documentos_electronicos WHERE (documento_referencia_id IN ${D('documentos_electronicos')} OR precuenta_id IN ${D('precuentas')}) AND id NOT IN ${D('documentos_electronicos')}`);
  await chequeo('ítems de documentos ajenos con órdenes demo',
    `SELECT count(*)::int AS n FROM sst.documento_items i WHERE i.orden_id IN ${D('ordenes_servicio')} AND i.documento_id NOT IN ${D('documentos_electronicos')}`);
  await chequeo('documento_ordenes ajenos con órdenes demo',
    `SELECT count(*)::int AS n FROM sst.documento_ordenes x WHERE x.orden_id IN ${D('ordenes_servicio')} AND x.documento_id NOT IN ${D('documentos_electronicos')}`);
  await chequeo('ítems de cuentas de cobro ajenas con órdenes demo',
    `SELECT count(*)::int AS n FROM sst.precuenta_items i WHERE i.orden_id IN ${D('ordenes_servicio')} AND i.id NOT IN ${D('precuenta_items')}`);
  await chequeo('movimientos ajenos con terceros demo',
    `SELECT count(*)::int AS n FROM sst.movimientos m WHERE m.tercero_id IN ${D('terceros')} AND m.comprobante_id NOT IN ${D('comprobantes')}`);
  await chequeo('órdenes ajenas con profesionales, empresas o terceros demo',
    `SELECT count(*)::int AS n FROM sst.ordenes_servicio o WHERE o.id NOT IN ${D('ordenes_servicio')}
       AND (o.profesional_asignado_id IN ${D('profesionales')} OR o.empresa_id IN ${D('empresas')} OR o.pagador_tercero_id IN ${D('terceros')})`);
  await chequeo('documentos, compras, recibos o egresos ajenos con terceros demo',
    `SELECT (SELECT count(*) FROM sst.documentos_electronicos WHERE tercero_id IN ${D('terceros')} AND id NOT IN ${D('documentos_electronicos')})
          + (SELECT count(*) FROM sst.compras WHERE tercero_id IN ${D('terceros')} AND id NOT IN ${D('compras')})
          + (SELECT count(*) FROM sst.recibos_caja WHERE tercero_id IN ${D('terceros')} AND id NOT IN ${D('recibos_caja')})
          + (SELECT count(*) FROM sst.egresos WHERE tercero_id IN ${D('terceros')} AND id NOT IN ${D('egresos')}) AS n`);
  await chequeo('liquidaciones de nómina ajenas de empleados demo',
    `SELECT count(*)::int AS n FROM sst.nomina_liquidaciones WHERE empleado_id IN ${D('empleados')} AND id NOT IN ${D('nomina_liquidaciones')}`);
  if (ajenos.length) {
    console.error('❌ Hay datos ajenos a la semilla que dependen de ella; no se borra nada:\n - ' + ajenos.join('\n - '));
    await q('ROLLBACK');
    process.exit(1);
  }

  const antes = await conteos();

  // 2 · Borrado, de las hojas a la raíz.
  await q(`ALTER TABLE sst.comprobantes DISABLE TRIGGER trg_comprobante_transicion`);
  const borrar = async (tabla, extra = '') => {
    const r = await q(`DELETE FROM sst.${tabla} WHERE id IN ${R} ${extra}`, [tabla]);
    return [tabla, r.rowCount];
  };
  const hechos = [];
  for (const t of ['periodos_contables', 'cartera_aplicacion_retenciones', 'cartera_aplicaciones', 'cartera_documentos',
    'recibos_caja', 'egresos', 'compra_retenciones', 'compra_items', 'compras', 'historial_cobro_orden']) hechos.push(await borrar(t));
  // Los documentos (notas y facturas en la misma sentencia: la referencia entre ellos se comprueba al final de la sentencia).
  hechos.push(await borrar('documentos_electronicos'));
  hechos.push(await borrar('comprobantes')); // sus movimientos se van por cascada
  for (const t of ['nomina_liquidaciones', 'empleados', 'precuenta_items', 'precuentas', 'respuestas_encuesta', 'historial_aprobacion_cobro',
    'historial_estados_orden', 'franjas_visita', 'borradores_extraccion', 'ordenes_servicio', 'lotes_importacion',
    'profesionales', 'empresas', 'terceros']) hechos.push(await borrar(t));
  await q(`ALTER TABLE sst.comprobantes ENABLE TRIGGER trg_comprobante_transicion`);

  // 3 · Lo registrado que quedó sin borrar (no debería haber nada).
  const quedan = [];
  for (const { tabla } of (await q(`SELECT DISTINCT tabla FROM demo_semilla.registro`)).rows) {
    const n = (await uno(`SELECT count(*)::int AS n FROM sst."${tabla}" WHERE id IN ${R}`, [tabla])).n;
    if (n) quedan.push(`${tabla}: ${n}`);
  }
  await q(`DROP SCHEMA demo_semilla CASCADE`);

  const despues = await conteos();
  console.table(hechos.map(([tabla, filas]) => ({ tabla, borradas: filas })));
  const cascada = Object.keys(antes).filter((t) => !hechos.some(([x]) => x === t) && antes[t] !== despues[t])
    .map((t) => ({ tabla: t, borradas_por_cascada: antes[t] - despues[t] }));
  if (cascada.length) console.table(cascada);

  // 4 · Comparación con la foto de antes de sembrar.
  const fallos = [...quedan.map((x) => `quedó sin borrar ${x}`)];
  const diferencias = [];
  for (const [t, n] of Object.entries(meta.conteos_antes ?? {})) {
    if (despues[t] !== n) diferencias.push({ tabla: t, al_sembrar: n, ahora: despues[t] });
  }
  const consec = (await q(`SELECT id, codigo, consecutivo_actual FROM sst.tipos_comprobante`)).rows;
  for (const k of meta.consecutivos ?? []) {
    const x = consec.find((y) => y.id === k.id);
    if (x && x.consecutivo_actual !== k.consecutivo_actual) diferencias.push({ tabla: `tipos_comprobante ${k.codigo}`, al_sembrar: k.consecutivo_actual, ahora: x.consecutivo_actual });
  }
  const trg = await uno(`SELECT tgenabled FROM pg_trigger WHERE tgname = 'trg_comprobante_transicion'`);
  if (trg.tgenabled !== 'O') fallos.push('el trigger trg_comprobante_transicion no quedó activo');
  if (diferencias.length) {
    console.log('\nℹ️  Tablas cuyo conteo no coincide con el de antes de sembrar (son cambios hechos por OTRAS personas en jdd_dev entre la siembra y hoy, no restos de la demo):');
    console.table(diferencias);
  } else {
    console.log('\nLos conteos de todas las tablas de sst y los consecutivos contables son IGUALES a los de antes de sembrar.');
  }

  if (fallos.length) {
    console.error('❌ ' + fallos.join('; '));
    await q('ROLLBACK');
    process.exitCode = 1;
  } else if (APLICAR) {
    await q('COMMIT');
    console.log('✅ Semilla demo BORRADA (COMMIT).');
  } else {
    await q('ROLLBACK');
    console.log('↩️  Ensayo del borrado: ROLLBACK (la semilla sigue en la base). Use --aplicar para borrar.');
  }
} catch (e) {
  await q('ROLLBACK').catch(() => {});
  console.error('❌ Error, no se borró nada:', e.message);
  process.exitCode = 1;
} finally {
  await c.end();
}
