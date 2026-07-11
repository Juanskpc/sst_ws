import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { type LoggerPort, silentLogger } from '../../application/ports/logger.port.js';
import { responderError } from './http-response.js';

/**
 * Envuelve un handler async para que cualquier rechazo llegue al manejador de
 * errores central (Express 5 ya reenvía promesas rechazadas, pero esto lo hace
 * explícito y compatible).
 */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

/** Manejador de errores central: cualquier error no controlado → 500 JSON limpio. */
export function crearManejadorErrores(logger: LoggerPort = silentLogger): ErrorRequestHandler {
  return (err: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(err);
      return;
    }
    logger.error('http.error_no_controlado', {
      mensaje: err instanceof Error ? err.message : String(err),
    });
    responderError(res, 500, 'ERROR_INTERNO', 'Ocurrió un error inesperado.');
  };
}
