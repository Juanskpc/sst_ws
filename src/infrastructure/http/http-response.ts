import type { Response } from 'express';
import type { CodigoErrorDominio } from '../../domain/shared/errors/domain-error.js';

/**
 * Contrato de respuesta HTTP uniforme (consumido por Angular):
 *   éxito → { ok: true, data }
 *   error → { ok: false, error: { codigo, mensaje, detalles } }
 */

/** Mapeo de códigos de error de dominio a status HTTP (traducción propia del borde). */
export const STATUS_POR_CODIGO: Record<CodigoErrorDominio, number> = {
  VALOR_INVALIDO: 400,
  ARCHIVO_NO_SOPORTADO: 415,
  ARL_NO_RECONOCIDA: 422,
  ORDEN_DUPLICADA: 409,
  EXTRACCION_FALLIDA: 422,
  LOTE_NO_ENCONTRADO: 404,
  BORRADOR_NO_ENCONTRADO: 404,
  BORRADOR_NO_VALIDABLE: 409,
  TRANSICION_INVALIDA: 409,
  MOTIVO_REQUERIDO: 400,
  REGRESION_EJECUTADA: 409,
};

export function responderExito<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ ok: true, data });
}

export function responderError(
  res: Response,
  status: number,
  codigo: string,
  mensaje: string,
  detalles: unknown = null,
): void {
  res.status(status).json({ ok: false, error: { codigo, mensaje, detalles } });
}
