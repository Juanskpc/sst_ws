import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';

/**
 * ".xls" es ambiguo: puede ser el binario BIFF/OLE2 de versiones viejas de
 * Excel, o (menos común) un OOXML/zip con la extensión vieja. `exceljs` solo
 * entiende el segundo formato — y ante el primero **no lanza error**:
 * `workbook.xlsx.load()` arma en silencio un workbook de 0 hojas. Así llegó un
 * SIPAB real de Bolívar el 16-sep-2026 ("ordenes bolivar desde junio.xls",
 * exportado por Excel de verdad, formato BIFF/OLE2) y el pipeline lo reportó
 * como "procesado, 0 órdenes" en vez de fallar.
 *
 * Por eso el formato se detecta por los BYTES del archivo (la firma del
 * contenedor OLE2), no por la extensión ni el `mimetype`: ambos son
 * falsificables y, en este caso, la extensión ".xls" no dice nada del formato
 * real.
 */
const FIRMA_OLE2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

function esXlsBinario(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 8 && buffer.subarray(0, 8).equals(FIRMA_OLE2);
}

/**
 * Lee la primera hoja de un Excel (.xlsx OOXML vía `exceljs`, o .xls binario
 * BIFF/OLE2 vía `xlsx`/SheetJS) y la deja como una rejilla uniforme, 1-indexada
 * igual que `exceljs`, para que el resto del código (parsing SIPAB, vista
 * previa) no necesite saber cuál de las dos librerías la leyó.
 *
 * `celda(r, c)` devuelve `{ value, text, numFmt }`:
 *  - `value`: el valor "crudo" (string, number o Date) — igual semántica que
 *    `cell.value` de exceljs.
 *  - `text`: el texto renderizado (resuelve fechas/fórmulas) — igual que
 *    `cell.text` de exceljs.
 *  - `numFmt`: el código de formato numérico, cuando se conoce.
 *
 * Devuelve `null` si el archivo no trae ninguna hoja.
 */
export async function leerRejillaExcel(buffer) {
  return esXlsBinario(buffer) ? leerRejillaXlsBinario(buffer) : leerRejillaXlsx(buffer);
}

async function leerRejillaXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) return null;

  const celdaDe = (cell) => ({ value: cell.value, text: (cell.text ?? '').toString(), numFmt: cell.numFmt });

  return {
    nombre: ws.name,
    rowCount: ws.rowCount || 0,
    columnCount: ws.columnCount || 0,
    celda: (r, c) => celdaDe(ws.getRow(r).getCell(c)),
    eachCell: (r, cb) => ws.getRow(r).eachCell((cell, col) => cb(celdaDe(cell), col)),
  };
}

function leerRejillaXlsBinario(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const nombreHoja = wb.SheetNames[0];
  if (!nombreHoja) return null;
  const ws = wb.Sheets[nombreHoja];
  const range = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : { e: { r: -1, c: -1 } };
  const rowCount = range.e.r + 1;
  const columnCount = range.e.c + 1;

  const celda = (r, c) => {
    const cell = ws[XLSX.utils.encode_cell({ r: r - 1, c: c - 1 })];
    if (!cell) return { value: null, text: '', numFmt: undefined };
    const value = cell.v ?? null;
    return { value, text: cell.w ?? (value == null ? '' : String(value)), numFmt: cell.z };
  };

  return {
    nombre: nombreHoja,
    rowCount,
    columnCount,
    celda,
    eachCell(r, cb) {
      for (let c = 1; c <= columnCount; c++) {
        if (ws[XLSX.utils.encode_cell({ r: r - 1, c: c - 1 })] === undefined) continue;
        cb(celda(r, c), c);
      }
    },
  };
}
