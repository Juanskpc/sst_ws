import type { MetadatosExtraccion } from '../../domain/dto/metadatos-extraccion.dto.js';
import type { ExtraccionFallidaError } from '../../domain/errors/ordenes.errors.js';

/**
 * Puerto de extracción de documentos (Ports & Adapters).
 *
 * Los casos de uso dependen de esta abstracción, NO de OpenAI. Permite sustituir
 * el proveedor (OpenAI ↔ Gemini) o inyectar un doble en tests sin tocar el núcleo.
 */

/** Metadatos operativos de la llamada (para logging/auditoría de calidad). */
export interface OrderImportMeta {
  readonly modelo: string;
  readonly latenciaMs: number;
  readonly tokensPrompt: number | null;
  readonly tokensRespuesta: number | null;
}

/**
 * Resultado de una extracción. Discriminado por `ok` (patrón Result): éxito con
 * los datos ya validados contra el esquema, o fallo con un error de dominio.
 * `data` se tipa como `MetadatosExtraccion` (contrato de dominio), no como el
 * tipo inferido de Zod: la capa de aplicación no depende de la validación.
 */
export type OrderImportResult =
  | { readonly ok: true; readonly data: MetadatosExtraccion; readonly meta: OrderImportMeta }
  | { readonly ok: false; readonly error: ExtraccionFallidaError };

export interface DocumentExtractorPort {
  /** Extrae los campos canónicos de una OS a partir de texto plano. */
  extraer(textoPlano: string): Promise<OrderImportResult>;
}
