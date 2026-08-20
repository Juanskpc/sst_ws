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

/**
 * CFG-04 · Tipo de orden deducido del título de la actividad.
 *
 * La ARL no manda una categoría: manda un título ("CAP SEGURIDAD VIAL",
 * "Asesoría en SG-SST"). Cuando ese texto dice claramente de qué se trata se
 * preselecciona el tipo, y si no, se deja vacío y lo elige quien revisa —
 * adivinar mal aquí sale caro: de esta categoría cuelga el valor hora.
 */
async function tipoOrdenPorTexto(texto) {
  const t = String(texto || '').toLowerCase();
  const nombre = /asesor/.test(t) ? 'Asesoría'
    : /inspec/.test(t) ? 'Inspección'
    : /(^|\W)(cap|capacit|charla|formaci)/.test(t) ? 'Capacitación'
    : null;
  if (!nombre) return null;
  const r = await pool.query(
    `SELECT id FROM sst.tipos_orden WHERE activo AND lower(btrim(nombre))=lower($1)`, [nombre]
  );
  return r.rows[0]?.id || null;
}

async function arlIdByName(nombre) {
  const r = await pool.query(`SELECT id FROM sst.arls WHERE nombre = $1`, [nombre]);
  return r.rows[0]?.id || null;
}

async function processBatch({ batchId, buffer, mime, filename, arlHint }) {
  const { arlNombre, arlConfidence, records } = await runExtraction({ buffer, mime, filename, arlHint });
  const arlId = await arlIdByName(arlNombre);

  let created = 0;
  for (const rec of records) {
    const fields = rec.fields;
    const overall = computeOverallConfidence(fields);
    const numeroOrden = fields.numero_orden?.value || null;
    const cron = fields.codigo_cronograma?.value || null;
    const sec = fields.secuencia?.value || null;

    // Dedup IMP-07/09 contra OS ya persistidas, según la identidad de la ARL:
    // AXA/Colmena por numero_orden; Bolívar por (cronograma + secuencia).
    let duplicadoDe = null;
    if (arlId && numeroOrden) {
      const dup = await pool.query(
        `SELECT id FROM sst.ordenes_servicio WHERE arl_id=$1 AND numero_orden=$2`,
        [arlId, numeroOrden]
      );
      duplicadoDe = dup.rows[0]?.id || null;
    } else if (arlId && cron && sec) {
      const dup = await pool.query(
        `SELECT id FROM sst.ordenes_servicio
         WHERE arl_id=$1 AND codigo_cronograma=$2 AND secuencia=$3`,
        [arlId, cron, sec]
      );
      duplicadoDe = dup.rows[0]?.id || null;
    }

    const metadata = {
      ...fields,
      overall_confidence: overall,
      engine: rec.engine,
      arl_confidence: arlConfidence,
      // Solo Excel: fila de la hoja de la que salió esta orden. La usa la vista
      // previa del documento para resaltarla junto a los campos extraídos.
      source_row: rec.sourceRow ?? null,
    };
    // El borrador nace en PENDIENTE_REVISION: se queda en la vista previa de
    // Importar y NO entra a Órdenes hasta que el Admin confirme el lote
    // (POST /imports/:id/confirm). Así la revisión humana es obligatoria.
    const tipoOrdenId = await tipoOrdenPorTexto(
      fields.tipo_actividad?.value || fields.descripcion?.value || '',
    );
    await pool.query(
      `INSERT INTO sst.borradores_extraccion
         (lote_importacion_id, arl_id, confianza_general, metadatos_extraccion, estado, duplicado_de, tipo_orden_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        batchId, arlId, overall, metadata,
        duplicadoDe ? 'DUPLICADA' : 'PENDIENTE_REVISION',
        duplicadoDe, tipoOrdenId,
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
