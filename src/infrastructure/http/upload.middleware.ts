import { extname } from 'node:path';
import multer from 'multer';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { responderError } from './http-response.js';

/** Límite de tamaño del archivo subido (10 MB). */
export const TAMANO_MAX_BYTES = 10 * 1024 * 1024;

/** Tipos MIME aceptados (PDF de AXA/Colmena y Excel SIPAB de Bolívar). */
export const MIMES_PERMITIDOS = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;

/** Extensiones aceptadas (defensa adicional al MIME, que es falsificable). */
export const EXTENSIONES_PERMITIDAS = ['.pdf', '.xlsx'] as const;

/** Error interno para distinguir el rechazo del fileFilter de multer. */
class TipoArchivoNoPermitidoError extends Error {
  constructor(nombre: string, mime: string) {
    super(
      `Tipo de archivo no permitido: "${nombre}" (${mime}). Solo se aceptan PDF y Excel (.xlsx).`,
    );
    this.name = 'TipoArchivoNoPermitidoError';
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TAMANO_MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const extension = extname(file.originalname).toLowerCase();
    const mimeOk = (MIMES_PERMITIDOS as readonly string[]).includes(file.mimetype);
    const extOk = (EXTENSIONES_PERMITIDAS as readonly string[]).includes(extension);
    if (mimeOk && extOk) {
      cb(null, true);
      return;
    }
    cb(new TipoArchivoNoPermitidoError(file.originalname, file.mimetype));
  },
});

/**
 * Middleware de subida de UN archivo con validación de tamaño/tipo/extensión.
 * Convierte los errores de multer en respuestas JSON limpias (no las deja
 * escapar como excepciones sin formato).
 */
export function middlewareSubida(campo: string): RequestHandler {
  const single = upload.single(campo);
  return (req: Request, res: Response, next: NextFunction) => {
    single(req, res, (err: unknown) => {
      if (err === undefined || err === null) {
        next();
        return;
      }
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          responderError(
            res,
            413,
            'ARCHIVO_MUY_GRANDE',
            `El archivo supera el tamaño máximo permitido (${TAMANO_MAX_BYTES} bytes).`,
          );
          return;
        }
        responderError(res, 400, 'ERROR_SUBIDA', err.message, { code: err.code });
        return;
      }
      if (err instanceof TipoArchivoNoPermitidoError) {
        responderError(res, 415, 'TIPO_NO_PERMITIDO', err.message);
        return;
      }
      next(err as Error);
    });
  };
}
