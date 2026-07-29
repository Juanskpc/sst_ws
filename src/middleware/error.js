import { HttpError } from '../utils/httpError.js';

/** Traduce errores de PostgreSQL / dominio a respuestas HTTP limpias. */
export function errorHandler(err, _req, res, _next) {
  // Errores de dominio lanzados por la función cambiar_estado_orden y checks.
  //
  // El mensaje va tal cual: lo escribe la función de dominio pensando en el
  // administrador ("Transición de estado inválida: PROGRAMADA → EJECUTADA.").
  // Antes se recortaba todo lo anterior al primer ": ", que era justamente la
  // parte que explicaba el problema y dejaba en pantalla solo "PROGRAMADA →
  // EJECUTADA.".
  if (err.code === 'P0001' || err.routine === 'exec_stmt_raise') {
    return res.status(409).json({ error: err.message });
  }
  // Valor fuera del enum (p.ej. un estado que no existe en EST-01). Es un dato
  // malo del cliente, no una falla del servidor: 400 con el valor recibido.
  if (err.code === '22P02') {
    const m = /invalid input value for enum \w+: "(.*)"/.exec(err.message || '');
    return res.status(400).json({
      error: m ? `Valor no válido: "${m[1]}".` : 'Valor no válido en la solicitud.',
    });
  }
  // Violación de unicidad (p.ej. dedup IMP-09, correo o documento duplicado).
  // Se traduce el detail de Postgres ("Key (correo)=(x@y.com) already exists.")
  // a un mensaje específico y legible para el usuario final.
  if (err.code === '23505') {
    const NOMBRES = {
      correo: 'el correo',
      documento_identidad: 'el documento de identidad',
      'arl_id, codigo_cronograma, secuencia': 'la combinación ARL + cronograma + secuencia',
    };
    const m = /Key \((.+?)\)=\((.+?)\)/.exec(err.detail || '');
    let mensaje = 'Registro duplicado';
    if (m) {
      mensaje = m[1] === 'es_maestro'
        ? 'Ya existe un Administrador Maestro en el sistema'
        : `Registro duplicado: ${NOMBRES[m[1]] || `el campo ${m[1]}`} "${m[2]}" ya está registrado`;
    }
    return res.status(409).json({ error: mensaje, detail: err.detail });
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
