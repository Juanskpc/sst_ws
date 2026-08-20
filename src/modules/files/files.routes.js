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

/**
 * Tipos de los formatos que se generan. Hoy todos son PDF, pero el tipo se
 * deduce de la key en vez de darlo por hecho: el registro de asistencia de
 * Colmena llegó como documento de Word y servirlo como `application/pdf` lo
 * entregaba roto.
 */
const MIME_POR_EXTENSION = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

// Descargar un formato generado (M4).
router.get('/documents/:id/download', asyncHandler(async (req, res) => {
  const r = await pool.query(`SELECT * FROM sst.documentos_generados WHERE id=$1`, [req.params.id]);
  const doc = r.rows[0];
  if (!doc) throw notFound('Documento no encontrado');
  const buffer = await leerArchivo(doc.url_pdf, doc.tipo);
  // La extensión real está en la key almacenada; `tipo` solo dice qué formato es
  // ('asistencia'), no en qué se generó.
  const ext = (/\.([a-z0-9]+)$/i.exec(doc.url_pdf || '')?.[1] || 'pdf').toLowerCase();
  res.setHeader('Content-Type', MIME_POR_EXTENSION[ext] || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${doc.tipo}.${ext}"`);
  res.send(buffer);
}));

// VER-01 · Visualizar un soporte EN LÍNEA sin descargar (inline).
router.get('/supports/:id/view', asyncHandler(async (req, res) => {
  const r = await pool.query(`SELECT * FROM sst.archivos_soporte WHERE id=$1`, [req.params.id]);
  const file = r.rows[0];
  if (!file) throw notFound('Soporte no encontrado');
  // Se sirve con el nombre CANÓNICO ('acta.pdf'), no con el que traía el móvil
  // del profesional: es el que ve el administrador si guarda el archivo, y el
  // que no mete comillas ni símbolos raros en la cabecera.
  const nombre = file.nombre_archivo || file.nombre_original || 'soporte';
  const buffer = await leerArchivo(file.url_archivo, nombre);
  res.setHeader('Content-Type', file.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${nombre.replace(/"/g, '')}"`);
  res.send(buffer);
}));

export default router;
