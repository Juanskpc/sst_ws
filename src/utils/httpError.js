/** Error HTTP con statusCode para el manejador central. */
export class HttpError extends Error {
  constructor(statusCode, message, details = undefined) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

export const badRequest   = (msg, d) => new HttpError(400, msg, d);
export const unauthorized = (msg = 'No autenticado') => new HttpError(401, msg);
export const forbidden    = (msg = 'No autorizado') => new HttpError(403, msg);
export const notFound     = (msg = 'Recurso no encontrado') => new HttpError(404, msg);
export const conflict     = (msg, d) => new HttpError(409, msg, d);
