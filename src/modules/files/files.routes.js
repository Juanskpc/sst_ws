import { Router } from 'express';
import { pool } from '../../config/db.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authRequired } from '../../middleware/auth.js';
import { notFound } from '../../utils/httpError.js';
import { storage } from '../../services/storage.service.js';

const router = Router();
router.use(authRequired);

/**
 * Lee del almacenamiento distinguiendo "no está el archivo" de un fallo real.
 *
 * La BD guarda solo la key; si el binario no está donde dice (archivo borrado,
 * bucket distinto, datos sembrados sin subir el fichero) el driver lanza ENOENT
 * y el cliente recibía un 500 opaco. Un 404 con el nombre del archivo le dice al
 * administrador exactamente qué pasó.
 */
async function leerArchivo(key, etiqueta) {
  try {
    return await storage.get(key);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.name === 'NoSuchKey') {
      throw notFound(`El archivo "${etiqueta}" ya no está disponible en el almacenamiento.`);
    }
    throw err;
  }
}

// Descargar un formato PDF generado (M4).
router.get('/documents/:id/download', asyncHandler(async (req, res) => {
  const r = await pool.query(`SELECT * FROM sst.documentos_generados WHERE id=$1`, [req.params.id]);
  const doc = r.rows[0];
  if (!doc) throw notFound('Documento no encontrado');
  const buffer = await leerArchivo(doc.url_pdf, doc.tipo);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${doc.tipo}.pdf"`);
  res.send(buffer);
}));

// VER-01 · Visualizar un soporte EN LÍNEA sin descargar (inline).
router.get('/supports/:id/view', asyncHandler(async (req, res) => {
  const r = await pool.query(`SELECT * FROM sst.archivos_soporte WHERE id=$1`, [req.params.id]);
  const file = r.rows[0];
  if (!file) throw notFound('Soporte no encontrado');
  const buffer = await leerArchivo(file.url_archivo, file.nombre_original || 'soporte');
  res.setHeader('Content-Type', file.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${file.nombre_original || 'soporte'}"`);
  res.send(buffer);
}));

export default router;
