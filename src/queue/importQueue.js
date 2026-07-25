import { pool } from '../config/db.js';
import { runExtraction, computeOverallConfidence } from '../services/extraction.service.js';

/**
 * Cola de importación en memoria (Fase 1). Procesa el lote de forma asíncrona
 * para que el request de subida responda de inmediato (NFR < 2s).
 * En producción se reemplaza por una cola real (BullMQ/SQS) sin tocar los llamadores.
 */
export function enqueueImport(job) {
  setImmediate(() => processBatch(job).catch((err) => {
    console.error('[importQueue] fallo procesando lote', job.batchId, err);
    pool.query(
      `UPDATE sst.lotes_importacion SET estado='ERROR', mensaje_error=$2 WHERE id=$1`,
      [job.batchId, err.message]
    ).catch(() => {});
  }));
}

async function arlIdByName(nombre) {
  const r = await pool.query(`SELECT id FROM sst.arls WHERE nombre = $1`, [nombre]);
  return r.rows[0]?.id || null;
}

async function processBatch({ batchId, buffer, mime, arlHint }) {
  const { arlNombre, arlConfidence, records } = await runExtraction({ buffer, mime, arlHint });
  const arlId = await arlIdByName(arlNombre);

  let created = 0;
  for (const rec of records) {
    const fields = rec.fields;
    const overall = computeOverallConfidence(fields);
    const cron = fields.codigo_cronograma?.value || null;
    const sec = fields.secuencia?.value || null;

    // Dedup IMP-07/09 contra OS ya persistidas.
    let duplicadoDe = null;
    if (arlId && cron && sec) {
      const dup = await pool.query(
        `SELECT id FROM sst.ordenes_servicio
         WHERE arl_id=$1 AND codigo_cronograma=$2 AND secuencia=$3`,
        [arlId, cron, sec]
      );
      duplicadoDe = dup.rows[0]?.id || null;
    }

    const metadata = { ...fields, overall_confidence: overall, engine: rec.engine, arl_confidence: arlConfidence };
    await pool.query(
      `INSERT INTO sst.borradores_extraccion
         (lote_importacion_id, arl_id, confianza_general, metadatos_extraccion, estado, duplicado_de)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        batchId, arlId, overall, metadata,
        duplicadoDe ? 'DUPLICADA' : 'PENDIENTE_VALIDACION',
        duplicadoDe,
      ]
    );
    created++;
  }

  await pool.query(
    `UPDATE sst.lotes_importacion
       SET estado='PROCESADO', arl_detectada=$2, total_ordenes=$3
     WHERE id=$1`,
    [batchId, arlId, created]
  );
}
