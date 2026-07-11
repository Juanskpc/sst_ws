/**
 * Puerto común de extracción de texto (Strategy).
 *
 * Cada implementación recibe los BYTES de un documento y devuelve ÚNICAMENTE
 * texto plano. No conoce OpenAI, ni la base de datos, ni el sistema de archivos:
 * recibe el contenido ya cargado (por multer/S3/quien sea) para ser reutilizable
 * con cualquier fuente.
 */
export interface TextExtractorPort {
  /** Tipos MIME que este extractor sabe procesar. */
  readonly tiposMimeSoportados: readonly string[];

  /** ¿Este extractor soporta el tipo MIME dado? */
  soporta(tipoMime: string): boolean;

  /** Extrae y devuelve el texto plano del documento. */
  extraerTexto(contenido: Uint8Array): Promise<string>;
}

/**
 * Selecciona el primer extractor capaz de procesar el tipo MIME dado.
 * Devuelve `null` si ninguno lo soporta (el llamador decide cómo tratarlo).
 */
export function seleccionarExtractor(
  tipoMime: string,
  extractores: readonly TextExtractorPort[],
): TextExtractorPort | null {
  return extractores.find((extractor) => extractor.soporta(tipoMime)) ?? null;
}
