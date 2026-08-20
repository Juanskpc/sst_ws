/** Error HTTP con statusCode para el manejador central. */
export class HttpError extends Error {
  constructor(statusCode, message, details = undefined) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

export const badRequest   = (msg, d) => new HttpError(400, msg, d);
export const unauthorized = (msg = 'Su sesión no está activa. Vuelva a iniciar sesión.') => new HttpError(401, msg);
export const forbidden    = (msg = 'Su usuario no tiene permiso para esta acción.') => new HttpError(403, msg);
export const notFound     = (msg = 'Eso ya no está en el sistema. Recargue la página.') => new HttpError(404, msg);
export const conflict     = (msg, d) => new HttpError(409, msg, d);
export const tooManyRequests = (msg = 'Demasiadas solicitudes, intente más tarde') => new HttpError(429, msg);
