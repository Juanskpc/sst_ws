import { Router } from 'express';
import { pool } from '../../config/db.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authRequired, requireRole } from '../../middleware/auth.js';
import { uploadImport } from '../../middleware/upload.js';
import { badRequest, notFound } from '../../utils/httpError.js';
import { storage } from '../../services/storage.service.js';
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
  enqueueImport({ batchId, buffer, mime: mimetype, arlHint: req.body?.arl || null });

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

export default router;
