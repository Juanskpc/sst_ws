/**
 * Estado del borrador de extracción del pipeline IA (M2/M3, staging).
 * Refleja el enum `sst.estado_extraccion` (schema.sql).
 *
 * PROCESANDO → PENDIENTE_VALIDACION → (VALIDADA | DUPLICADA | DESCARTADA | ERROR)
 * Al VALIDAR se materializa en `ordenes_servicio` con estado SIN PROGRAMAR.
 */
export const EstadoExtraccion = {
  PROCESANDO: 'PROCESANDO',
  PENDIENTE_VALIDACION: 'PENDIENTE_VALIDACION',
  VALIDADA: 'VALIDADA',
  DUPLICADA: 'DUPLICADA',
  DESCARTADA: 'DESCARTADA',
  ERROR: 'ERROR',
} as const;

export type EstadoExtraccion =
  (typeof EstadoExtraccion)[keyof typeof EstadoExtraccion];

export const ESTADOS_EXTRACCION = Object.values(
  EstadoExtraccion,
) as readonly EstadoExtraccion[];

export const esEstadoExtraccion = (valor: string): valor is EstadoExtraccion =>
  (ESTADOS_EXTRACCION as readonly string[]).includes(valor);
