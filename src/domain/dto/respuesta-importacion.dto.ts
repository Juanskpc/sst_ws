import type { EstadoImportacion } from '../enums/estado-importacion.enum.js';

/**
 * Respuesta de la Fase A (ingesta, < 2s): el frontend obtiene el `loteId` y
 * consulta el estado por polling/SSE mientras el worker extrae.
 */
export interface RespuestaImportacionDTO {
  readonly loteId: string;
  readonly estado: EstadoImportacion;
  readonly nombreArchivo: string;
  readonly totalOrdenes: number;
  readonly mensajeError: string | null;
}
