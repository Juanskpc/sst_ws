/**
 * Vacía los datos de PRUEBA de la base de desarrollo `jdd_dev` para repetir el
 * flujo de punta a punta desde cero (igual que la limpieza del 30-sep-2026).
 *
 *   node scripts/limpiar-jdd-dev.mjs --confirmar
 *
 * Borra órdenes, borradores, importaciones, soportes, franjas, enlaces,
 * historiales, prefacturas, documentos electrónicos, comprobantes y
 * movimientos, cartera, encuestas, notificaciones y empresas, y pone la
 * numeración contable en 0. Conserva la configuración (usuarios, ARL, tipos de
 * orden, profesionales, terceros, PUC, reglas, productos, retenciones,
 * resoluciones). Todo en una transacción: si algo falla, no toca nada.
 *
 * ⛔ Se niega a correr si DATABASE_URL no apunta a `jdd_dev`: NUNCA en producción.
 * Antes de usarlo, sacar un respaldo (pg_dump en ~/respaldos del VPS de desarrollo).
 */
import 'dotenv/config';
import pg from 'pg';

const url = process.env.DATABASE_URL || '';
if (!/\/jdd_dev(\?|$)/.test(url)) {
  console.error('DATABASE_URL no apunta a jdd_dev: no se toca nada.');
  process.exit(1);
}
if (!process.argv.includes('--confirmar')) {
  console.error('Falta --confirmar. Uso: node scripts/limpiar-jdd-dev.mjs --confirmar');
  process.exit(1);
}

const TABLAS = [
  'archivos_soporte', 'borradores_extraccion', 'cartera_documentos', 'comprobantes', 'movimientos',
  'documento_eventos', 'documento_item_tributos', 'documento_items', 'documento_ordenes', 'documentos_electronicos',
  'documentos_generados', 'enlaces_publicos', 'franjas_visita', 'historial_aprobacion_cobro', 'historial_cobro_orden',
  'historial_estado_arl', 'historial_estados_orden', 'lotes_importacion', 'notificaciones', 'ordenes_servicio',
  'prefactura_filas', 'prefacturas', 'respuestas_encuesta', 'empresas',
];

const c = new pg.Client({ connectionString: url });
await c.connect();

/**
 * Postgres solo deja vaciar una tabla si TODAS las que la referencian van en el
 * mismo TRUNCATE (egresos, recibos, compras… apuntan a `comprobantes`). Se
 * agregan solas, pero solo si están VACÍAS: una dependiente con datos sería
 * algo que no sabemos si se quiere borrar, y entonces no se toca nada.
 */
async function dependientes(base) {
  const todas = new Set(base);
  for (;;) {
    const r = await c.query(
      `SELECT DISTINCT cl.relname AS tabla
         FROM pg_constraint co
         JOIN pg_class cl ON cl.oid = co.conrelid
         JOIN pg_class rf ON rf.oid = co.confrelid
         JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE co.contype = 'f' AND n.nspname = 'sst'
          AND rf.relname = ANY($1) AND NOT (cl.relname = ANY($1))`,
      [[...todas]],
    );
    if (!r.rows.length) return [...todas].filter((t) => !base.includes(t));
    r.rows.forEach((x) => todas.add(x.tabla));
  }
}

const extra = await dependientes(TABLAS);
for (const t of extra) {
  const n = Number((await c.query(`SELECT count(*) FROM sst."${t}"`)).rows[0].count);
  if (n) {
    console.error(`sst.${t} referencia a una tabla de la lista y TIENE ${n} filas: no se toca nada.`);
    await c.end();
    process.exit(1);
  }
}
if (extra.length) console.log(`Dependientes vacías incluidas: ${extra.join(', ')}`);

try {
  await c.query('BEGIN');
  await c.query(`TRUNCATE ${[...TABLAS, ...extra].map((t) => 'sst.' + t).join(', ')}`);
  await c.query('UPDATE sst.tipos_comprobante SET consecutivo_actual = 0');
  await c.query('COMMIT');
  console.log(`OK: ${TABLAS.length} tablas vaciadas y numeración contable en 0.`);
} catch (e) {
  await c.query('ROLLBACK');
  console.error('ROLLBACK, no se tocó nada:', e.message);
  process.exitCode = 1;
} finally {
  await c.end();
}
