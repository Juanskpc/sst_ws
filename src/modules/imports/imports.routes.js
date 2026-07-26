import { Router } from 'express';
import { pool } from '../../config/db.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authRequired, requireRole } from '../../middleware/auth.js';
import { uploadImport } from '../../middleware/upload.js';
import { badRequest, notFound } from '../../utils/httpError.js';
import { storage } from '../../services/storage.service.js';
import { readSheetPreview } from '../../services/extraction.service.js';
import { enqueueImport } from '../../queue/importQueue.js';

const router = Router();
router.use(authRequired);

// IMP-01/02 · Subir archivo (Excel SIPAB o PDF). Responde de inmediato (NFR<2s).
router.post('/', requireRole('admin'), uploadImport.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('Adjunta un archivo en el campo "file"');
  const { originalname, mimetype, buffer } = req.file;

  const fileKey = await storage.put('imports', originalname, buffer);
  const batch = await pool.query(
    `INSERT INTO sst.lotes_importacion (subido_por, nombre_archivo, url_archivo, tipo_mime, estado)
     VALUES ($1,$2,$3,$4,'PROCESANDO') RETURNING *`,
    [req.user.sub, originalname, fileKey, mimetype]
  );
  const batchId = batch.rows[0].id;

  // Encola el pipeline IA (clasificación + extracción + dedup) en background.
  enqueueImport({ batchId, buffer, mime: mimetype, filename: originalname, arlHint: req.body?.arl || null });

  res.status(202).json({
    message: 'Archivo recibido. Procesando con IA…',
    batch: batch.rows[0],
  });
}));

// Lista de lotes de importación
router.get('/', asyncHandler(async (req, res) => {
  const r = await pool.query(
    `SELECT b.*, a.nombre AS arl_nombre, u.nombre AS subido_por_nombre
     FROM sst.lotes_importacion b
     LEFT JOIN sst.arls a ON a.id = b.arl_detectada
     LEFT JOIN sst.usuarios u ON u.id = b.subido_por
     ORDER BY b.creado_en DESC LIMIT 100`
  );
  res.json({ data: r.rows });
}));

// Estado del lote (para polling del frontend)
router.get('/:id/status', asyncHandler(async (req, res) => {
  const r = await pool.query(
    `SELECT id, estado, total_ordenes, mensaje_error FROM sst.lotes_importacion WHERE id=$1`,
    [req.params.id]
  );
  if (!r.rows[0]) throw notFound('Lote no encontrado');
  res.json({ data: r.rows[0] });
}));

// IMP-03 · Archivo ORIGINAL del lote, servido en línea (inline) para la vista
// previa del modal de revisión. El navegador renderiza los PDF de forma nativa;
// para Excel se usa /:id/sheet (abajo), que sí es legible en HTML.
router.get('/:id/file', asyncHandler(async (req, res) => {
  const r = await pool.query(
    `SELECT nombre_archivo, url_archivo, tipo_mime FROM sst.lotes_importacion WHERE id=$1`,
    [req.params.id]
  );
  const lote = r.rows[0];
  if (!lote) throw notFound('Lote no encontrado');
  if (!lote.url_archivo) throw notFound('El lote no conserva el archivo original');

  const buffer = await storage.get(lote.url_archivo);
  res.setHeader('Content-Type', lote.tipo_mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${lote.nombre_archivo || 'documento'}"`);
  res.send(buffer);
}));

// IMP-03 · Hoja del Excel original como texto plano, para pintarla al lado de
// los campos extraídos. Solo aplica a lotes de Excel (Bolívar / SIPAB).
router.get('/:id/sheet', asyncHandler(async (req, res) => {
  const r = await pool.query(
    `SELECT nombre_archivo, url_archivo, tipo_mime FROM sst.lotes_importacion WHERE id=$1`,
    [req.params.id]
  );
  const lote = r.rows[0];
  if (!lote) throw notFound('Lote no encontrado');
  if (!lote.url_archivo) throw notFound('El lote no conserva el archivo original');

  const esExcel = /sheet|excel/.test(lote.tipo_mime || '') || /\.(xlsx|xls)$/i.test(lote.nombre_archivo || '');
  if (!esExcel) throw badRequest('El archivo del lote no es una hoja de cálculo');

  const buffer = await storage.get(lote.url_archivo);
  const preview = await readSheetPreview(buffer);
  res.json({ data: { nombre_archivo: lote.nombre_archivo, ...preview } });
}));

// Detalle del lote + borradores extraídos
router.get('/:id', asyncHandler(async (req, res) => {
  const b = await pool.query(`SELECT * FROM sst.lotes_importacion WHERE id=$1`, [req.params.id]);
  if (!b.rows[0]) throw notFound('Lote no encontrado');
  const borradores = await pool.query(
    `SELECT d.*, a.nombre AS arl_nombre FROM sst.borradores_extraccion d
     LEFT JOIN sst.arls a ON a.id = d.arl_id
     WHERE d.lote_importacion_id=$1 ORDER BY d.creado_en`,
    [req.params.id]
  );
  res.json({ data: { ...b.rows[0], borradores: borradores.rows } });
}));

// IMP-04 · Confirmar el lote tras la revisión humana en la vista previa.
// Los borradores pasan de PENDIENTE_REVISION → PENDIENTE_VALIDACION y recién
// entonces aparecen en la bandeja de Órdenes. Los DUPLICADA no se tocan.
router.post('/:id/confirm', requireRole('admin'), asyncHandler(async (req, res) => {
  const lote = await pool.query(`SELECT id FROM sst.lotes_importacion WHERE id=$1`, [req.params.id]);
  if (!lote.rows[0]) throw notFound('Lote no encontrado');

  const r = await pool.query(
    `UPDATE sst.borradores_extraccion
        SET estado='PENDIENTE_VALIDACION', actualizado_en=now()
      WHERE lote_importacion_id=$1 AND estado='PENDIENTE_REVISION'
      RETURNING id`,
    [req.params.id]
  );
  if (!r.rowCount) throw badRequest('El lote no tiene órdenes pendientes de revisión');

  res.json({
    message: `${r.rowCount} orden(es) enviada(s) a Órdenes.`,
    data: { confirmadas: r.rowCount },
  });
}));

// Descartar el lote completo sin enviarlo a Órdenes (los borradores quedan
// DESCARTADA; el archivo original se conserva para auditoría).
router.post('/:id/discard', requireRole('admin'), asyncHandler(async (req, res) => {
  const lote = await pool.query(`SELECT id FROM sst.lotes_importacion WHERE id=$1`, [req.params.id]);
  if (!lote.rows[0]) throw notFound('Lote no encontrado');

  const r = await pool.query(
    `UPDATE sst.borradores_extraccion
        SET estado='DESCARTADA', actualizado_en=now()
      WHERE lote_importacion_id=$1 AND estado='PENDIENTE_REVISION'
      RETURNING id`,
    [req.params.id]
  );
  res.json({
    message: `${r.rowCount} orden(es) descartada(s).`,
    data: { descartadas: r.rowCount },
  });
}));

export default router;
