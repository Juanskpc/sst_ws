import { HttpError } from '../utils/httpError.js';

/** Traduce errores de PostgreSQL / dominio a respuestas HTTP limpias. */
export function errorHandler(err, _req, res, _next) {
  // Errores de dominio lanzados por la función cambiar_estado_orden y checks.
  if (err.code === 'P0001' || err.routine === 'exec_stmt_raise') {
    return res.status(409).json({ error: err.message.replace(/^.*?:\s/, '') || err.message });
  }
  // Violación de unicidad (p.ej. dedup IMP-09 o email duplicado).
  if (err.code === '23505') {
    return res.status(409).json({ error: 'Registro duplicado', detail: err.detail });
  }
  // FK inválida.
  if (err.code === '23503') {
    return res.status(400).json({ error: 'Referencia inválida', detail: err.detail });
  }
  if (err instanceof HttpError) {
    return res.status(err.statusCode).json({ error: err.message, details: err.details });
  }
  // Multer u otros.
  if (err.name === 'MulterError') {
    return res.status(400).json({ error: `Error de archivo: ${err.message}` });
  }
  console.error('[error]', err);
  res.status(500).json({ error: 'Error interno del servidor' });
}
