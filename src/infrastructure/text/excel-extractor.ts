import ExcelJS from 'exceljs';
import type { TextExtractorPort } from '../../application/ports/text-extractor.port.js';
import { ExtraccionTextoError } from './extraccion-texto.error.js';

const MIME_XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MIME_XLS = 'application/vnd.ms-excel';

/**
 * Extrae texto plano de hojas de cálculo (.xlsx) — p. ej. el Excel SIPAB de
 * Bolívar. Recorre todas las hojas y filas, y usa el texto renderizado de cada
 * celda (`cell.text`), que resuelve fechas, fórmulas y rich-text a string.
 *
 * Formato de salida (legible por humano y por el modelo):
 *   # Hoja: <nombre>
 *   celda1\tcelda2\tcelda3
 *   ...
 */
export class ExcelExtractor implements TextExtractorPort {
  readonly tiposMimeSoportados = [MIME_XLSX, MIME_XLS] as const;

  soporta(tipoMime: string): boolean {
    return this.tiposMimeSoportados.includes(tipoMime as (typeof this.tiposMimeSoportados)[number]);
  }

  async extraerTexto(contenido: Uint8Array): Promise<string> {
    const workbook = new ExcelJS.Workbook();
    try {
      // Cast al tipo EXACTO que declara exceljs (incompatibilidad del `Buffer`
      // genérico de @types/node 22 con el `Buffer` que tipa exceljs).
      const datos = Buffer.from(contenido) as unknown as Parameters<
        typeof workbook.xlsx.load
      >[0];
      await workbook.xlsx.load(datos);
    } catch (causa) {
      throw new ExtraccionTextoError('excel', 'No se pudo leer el archivo Excel.', causa);
    }

    const partes: string[] = [];
    workbook.eachSheet((hoja) => {
      partes.push(`# Hoja: ${hoja.name}`);
      hoja.eachRow({ includeEmpty: false }, (fila) => {
        const celdas: string[] = [];
        fila.eachCell({ includeEmpty: false }, (celda) => {
          const texto = (celda.text ?? '').trim();
          if (texto.length > 0) celdas.push(texto);
        });
        if (celdas.length > 0) partes.push(celdas.join('\t'));
      });
    });

    return partes.join('\n').trim();
  }
}
