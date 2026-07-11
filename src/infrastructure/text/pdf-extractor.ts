import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { TextExtractorPort } from '../../application/ports/text-extractor.port.js';
import { ExtraccionTextoError } from './extraccion-texto.error.js';

const MIME_PDF = 'application/pdf';

/**
 * Extrae texto plano de PDFs (AXA, Colmena) usando PDF.js (pdfjs-dist).
 *
 * Lee la CAPA DE TEXTO del PDF página por página. Nota importante: un PDF
 * escaneado (imagen sin capa de texto) devolverá texto vacío — ese caso requiere
 * OCR, que queda fuera de este extractor (costura futura). Aquí no se decide qué
 * hacer con el vacío: se devuelve tal cual y el caso de uso lo evalúa.
 */
export class PdfExtractor implements TextExtractorPort {
  readonly tiposMimeSoportados = [MIME_PDF] as const;

  soporta(tipoMime: string): boolean {
    return tipoMime === MIME_PDF;
  }

  async extraerTexto(contenido: Uint8Array): Promise<string> {
    let documento;
    try {
      documento = await getDocument({
        // Copia defensiva: pdf.js "detacha" el buffer recibido; no debemos
        // neutralizar el `Uint8Array` del llamador (reutilización segura).
        data: new Uint8Array(contenido),
        useSystemFonts: true,
        isEvalSupported: false, // endurecimiento: no evaluar expresiones del PDF
      }).promise;
    } catch (causa) {
      throw new ExtraccionTextoError('pdf', 'No se pudo abrir el documento PDF.', causa);
    }

    try {
      const paginas: string[] = [];
      for (let numero = 1; numero <= documento.numPages; numero++) {
        const pagina = await documento.getPage(numero);
        const contenidoTexto = await pagina.getTextContent();
        const textoPagina = contenidoTexto.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ')
          .replace(/[ \t]+/g, ' ')
          .trim();
        paginas.push(textoPagina);
      }
      return paginas.join('\n\n').trim();
    } catch (causa) {
      throw new ExtraccionTextoError('pdf', 'No se pudo extraer el texto del PDF.', causa);
    } finally {
      await documento.destroy();
    }
  }
}
