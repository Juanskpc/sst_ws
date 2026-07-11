/**
 * EST-01 · Estados obligatorios de la Orden de Servicio.
 * Refleja EXACTAMENTE el enum `sst.estado_orden` (schema.sql), acentos incluidos.
 *
 * Flujo: SIN PROGRAMAR → PROGRAMADA → EN VERIFICACIÓN → EJECUTADA / CANCELADA.
 * Las transiciones válidas se definen en `policies/transicion-estado.policy.ts`.
 */
export const EstadoOrden = {
  SIN_PROGRAMAR: 'SIN PROGRAMAR',
  PROGRAMADA: 'PROGRAMADA',
  EN_VERIFICACION: 'EN VERIFICACIÓN',
  EJECUTADA: 'EJECUTADA',
  CANCELADA: 'CANCELADA',
} as const;

export type EstadoOrden = (typeof EstadoOrden)[keyof typeof EstadoOrden];

export const ESTADOS_ORDEN = Object.values(EstadoOrden) as readonly EstadoOrden[];

export const esEstadoOrden = (valor: string): valor is EstadoOrden =>
  (ESTADOS_ORDEN as readonly string[]).includes(valor);
