import type { ErrorDominio } from './errors/domain-error.js';

/**
 * Resultado explícito para fallos *esperables* del dominio (patrón Result/Either).
 *
 * Las factorías y métodos de dominio devuelven `Resultado` en vez de lanzar
 * excepciones para errores de negocio previsibles. Las excepciones quedan
 * reservadas para fallos verdaderamente inesperados (bugs, infraestructura).
 */
export type Resultado<T, E extends ErrorDominio = ErrorDominio> =
  | { readonly ok: true; readonly valor: T }
  | { readonly ok: false; readonly error: E };

/** Construye un resultado exitoso. */
export function exito<T>(valor: T): Resultado<T, never> {
  return { ok: true, valor };
}

/** Construye un resultado fallido. */
export function fallo<E extends ErrorDominio>(error: E): Resultado<never, E> {
  return { ok: false, error };
}

/** *Type guard*: estrecha a la rama exitosa. */
export const esExito = <T, E extends ErrorDominio>(
  resultado: Resultado<T, E>,
): resultado is { readonly ok: true; readonly valor: T } => resultado.ok;

/** *Type guard*: estrecha a la rama fallida. */
export const esFallo = <T, E extends ErrorDominio>(
  resultado: Resultado<T, E>,
): resultado is { readonly ok: false; readonly error: E } => !resultado.ok;
