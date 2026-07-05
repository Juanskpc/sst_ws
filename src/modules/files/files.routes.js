import { Router } from 'express';
import { pool } from '../../config/db.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authRequired } from '../../middleware/auth.js';
import { notFound } from '../../utils/httpError.js';
import { storage } from '../../services/storage.service.js';

const router = Router();
router.use(authRequired);

// Descargar un formato PDF generado (M4).
router.get('/documents/:id/download', asyncHandler(async (req, res) => {
  const r = await pool.query(`SELECT * FROM sst.documentos_generados WHERE id=$1`, [req.params.id]);
  const doc = r.rows[0];
  if (!doc) throw notFound('Documento no encontrado');
  const buffer = await storage.get(doc.url_pdf);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${doc.tipo}.pdf"`);
  res.send(buffer);
}));

// VER-01 · Visualizar un soporte EN LÍNEA sin descargar (inline).
router.get('/supports/:id/view', asyncHandler(async (req, res) => {
  const r = await pool.query(`SELECT * FROM sst.archivos_soporte WHERE id=$1`, [req.params.id]);
  const file = r.rows[0];
  if (!file) throw notFound('Soporte no encontrado');
  const buffer = await storage.get(file.url_archivo);
  res.setHeader('Content-Type', file.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${file.nombre_original || 'soporte'}"`);
  res.send(buffer);
}));

export default router;
