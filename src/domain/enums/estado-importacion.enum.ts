/**
 * Estado del lote de importación (M2).
 * Refleja el enum `sst.estado_importacion` (schema.sql).
 *
 * El lote nace en PROCESANDO (respuesta < 2s), el worker asíncrono lo lleva a
 * PROCESADO o ERROR.
 */
export const EstadoImportacion = {
  PROCESANDO: 'PROCESANDO',
  PROCESADO: 'PROCESADO',
  ERROR: 'ERROR',
} as const;

export type EstadoImportacion =
  (typeof EstadoImportacion)[keyof typeof EstadoImportacion];

export const ESTADOS_IMPORTACION = Object.values(
  EstadoImportacion,
) as readonly EstadoImportacion[];

export const esEstadoImportacion = (valor: string): valor is EstadoImportacion =>
  (ESTADOS_IMPORTACION as readonly string[]).includes(valor);
