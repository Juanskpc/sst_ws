import { type Resultado, exito, fallo } from '../shared/result.js';
import { EstadoOrden } from '../enums/estado-orden.enum.js';
import {
  MotivoRequeridoError,
  RegresionEjecutadaError,
  TransicionInvalidaError,
} from '../errors/ordenes.errors.js';
import type { OrdenServicioId, UsuarioId } from '../shared/identifiers.js';

/**
 * Política pura de transición de estados de la OS (EST-01..06).
 *
 * Es el espejo en dominio de la función SQL `sst.cambiar_estado_orden`. Tener la
 * regla también en TS habilita validación temprana y tests sin BD; la BD queda
 * como defensa en profundidad. Ambas DEBEN mantenerse sincronizadas.
 */

/** Matriz de transiciones válidas (EST-01). Los estados terminales no tienen salidas. */
export const TRANSICIONES_VALIDAS: Readonly<
  Record<EstadoOrden, readonly EstadoOrden[]>
> = {
  [EstadoOrden.SIN_PROGRAMAR]: [EstadoOrden.PROGRAMADA, EstadoOrden.CANCELADA],
  [EstadoOrden.PROGRAMADA]: [
    EstadoOrden.EN_VERIFICACION,
    EstadoOrden.SIN_PROGRAMAR,
    EstadoOrden.CANCELADA,
  ],
  [EstadoOrden.EN_VERIFICACION]: [
    EstadoOrden.EJECUTADA,
    EstadoOrden.PROGRAMADA,
    EstadoOrden.CANCELADA,
  ],
  [EstadoOrden.EJECUTADA]: [],
  [EstadoOrden.CANCELADA]: [],
};

/** Registro de auditoría producido por un cambio de estado (event source). */
export interface EntradaHistorialEstado {
  readonly ordenId: OrdenServicioId;
  readonly estadoAnterior: EstadoOrden | null;
  readonly estadoNuevo: EstadoOrden;
  readonly cambiadoPor: UsuarioId | null;
  readonly motivo: string | null;
  readonly cambiadoEn: Date;
}

export const esEstadoTerminal = (estado: EstadoOrden): boolean =>
  TRANSICIONES_VALIDAS[estado].length === 0;

export const esTransicionValida = (
  desde: EstadoOrden,
  hacia: EstadoOrden,
): boolean => TRANSICIONES_VALIDAS[desde].includes(hacia);

/**
 * Motivo obligatorio (EST-04/05): al CANCELAR y al rechazar una verificación
 * (EN VERIFICACIÓN → PROGRAMADA).
 */
export const requiereMotivo = (desde: EstadoOrden, hacia: EstadoOrden): boolean =>
  hacia === EstadoOrden.CANCELADA ||
  (desde === EstadoOrden.EN_VERIFICACION && hacia === EstadoOrden.PROGRAMADA);

/**
 * Valida una transición aplicando EST-01..06.
 * No muta nada: devuelve `Resultado<void>` con el error de dominio adecuado.
 */
export function validarTransicion(
  desde: EstadoOrden,
  hacia: EstadoOrden,
  motivo: string | null,
): Resultado<void, RegresionEjecutadaError | TransicionInvalidaError | MotivoRequeridoError> {
  // EST-06: nunca se retrocede desde EJECUTADA.
  if (desde === EstadoOrden.EJECUTADA) {
    return fallo(new RegresionEjecutadaError());
  }
  if (!esTransicionValida(desde, hacia)) {
    return fallo(new TransicionInvalidaError(desde, hacia));
  }
  if (requiereMotivo(desde, hacia) && (motivo === null || motivo.trim().length === 0)) {
    return fallo(new MotivoRequeridoError(desde, hacia));
  }
  return exito(undefined);
}
