import { z } from 'zod';

/**
 * Resultado de validación de FRONTERA (Zod), independiente del `Resultado<T,E>`
 * del dominio: la validación de entrada es una preocupación de la capa externa
 * (adaptador IA / HTTP), no del núcleo de negocio.
 */

/** Error de validación normalizado y serializable hacia el cliente. */
export interface ErrorValidacion {
  /** Ruta del campo con notación de punto, p. ej. `contacto_sst.correo`. */
  readonly campo: string;
  /** Mensaje claro y accionable (en español). */
  readonly mensaje: string;
  /** Código de issue de Zod (p. ej. `invalid_type`, `too_big`). */
  readonly codigo: string;
}

export type ResultadoValidacion<T> =
  | { readonly ok: true; readonly datos: T }
  | { readonly ok: false; readonly errores: readonly ErrorValidacion[] };

/** Aplana un `ZodError` a una lista estable de {@link ErrorValidacion}. */
export function formatearErroresZod(error: z.ZodError): ErrorValidacion[] {
  return error.issues.map((issue) => ({
    campo: issue.path.length > 0 ? issue.path.map(String).join('.') : '(raíz)',
    mensaje: issue.message,
    codigo: issue.code,
  }));
}

/**
 * Ejecuta un esquema sobre datos desconocidos y devuelve un resultado tipado.
 * Reutilizable por cualquier validador (evita repetir el patrón `safeParse`).
 */
export function validarCon<S extends z.ZodType>(
  schema: S,
  datos: unknown,
): ResultadoValidacion<z.infer<S>> {
  const resultado = schema.safeParse(datos);
  if (resultado.success) {
    return { ok: true, datos: resultado.data };
  }
  return { ok: false, errores: formatearErroresZod(resultado.error) };
}
