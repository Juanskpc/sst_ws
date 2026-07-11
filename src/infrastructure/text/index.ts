import type { TextExtractorPort } from '../../application/ports/text-extractor.port.js';
import { ExcelExtractor } from './excel-extractor.js';
import { PdfExtractor } from './pdf-extractor.js';

export * from './excel-extractor.js';
export * from './pdf-extractor.js';
export * from './extraccion-texto.error.js';

/** Instancia el conjunto de extractores de texto disponibles (Excel + PDF). */
export function crearExtractoresTexto(): readonly TextExtractorPort[] {
  return [new ExcelExtractor(), new PdfExtractor()];
}
