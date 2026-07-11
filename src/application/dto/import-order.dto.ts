import type { MetadatosExtraccion } from '../../domain/dto/metadatos-extraccion.dto.js';
import type { CamposVistaPrevia } from '../../domain/dto/vista-previa-borrador.dto.js';
import type { OrderImportMeta } from '../ports/document-extractor.port.js';

/** Entrada del caso de uso: referencia al archivo ya subido + sus metadatos. */
export interface ImportOrderCommand {
  /** Key/ruta del archivo en el almacenamiento (S3/local). */
  readonly referenciaArchivo: string;
  readonly nombreArchivo: string;
  readonly tipoMime: string;
}

/**
 * Salida del caso de uso: el "JSON tipado" para la vista previa en Angular.
 *
 * - `campos`  → enriquecidos con nivel/requiereRevision para el split-view.
 * - `metadatos` → extracción cruda ({value,confidence}) para persistir después.
 * - `meta`    → datos de la llamada al modelo (auditoría/observabilidad).
 * NO incluye ids de persistencia: este caso de uso NO guarda nada.
 */
export interface ImportOrderResultDTO {
  readonly nombreArchivo: string;
  readonly tipoMime: string;
  readonly requiereRevision: boolean;
  readonly confianzaGeneral: number | null;
  readonly campos: CamposVistaPrevia;
  readonly metadatos: MetadatosExtraccion;
  readonly meta: OrderImportMeta;
}
