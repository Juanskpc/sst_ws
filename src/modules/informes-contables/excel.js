import ExcelJS from 'exceljs';
import { obtenerEmisor } from '../parametros/emisor.service.js';

/**
 * Excel de los informes contables. A diferencia de `POST /reports/xlsx` (que
 * recibe filas ya armadas por el frontend como texto), aquí los importes van como
 * NÚMEROS: la contadora suma, filtra y cruza estas hojas con las de Siigo, y una
 * cifra guardada como texto no suma.
 *
 * El encabezado copia el de los informes de Siigo (título, empresa, NIT y rango)
 * para que las dos hojas se lean igual lado a lado.
 */

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const fechaLarga = (iso) => {
  const [a, m, d] = iso.split('-').map(Number);
  return `${d} de ${MESES[m - 1]} de ${a}`;
};

export const FORMATO_PESOS = '#,##0.00;-#,##0.00;0.00';

/**
 * Libro con el encabezado puesto. Devuelve la hoja y la fila donde van los
 * títulos de columna. `extra`: líneas de filtros aplicados (cuenta, tercero…).
 */
export async function libroConEncabezado({ titulo, hoja, desde, hasta, extra = [] }) {
  const emisor = await obtenerEmisor().catch(() => null);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ORBITA';
  wb.created = new Date();
  const ws = wb.addWorksheet(hoja);
  // Sin ficha del emisor (un ambiente recién montado) se omiten esas dos líneas.
  const lineas = [
    titulo,
    emisor?.razon_social,
    emisor ? `NIT ${emisor.nit}-${emisor.dv}` : null,
    `Del ${fechaLarga(desde)} al ${fechaLarga(hasta)}`,
    ...extra,
  ].filter(Boolean);
  lineas.forEach((texto, i) => {
    const fila = ws.addRow([texto]);
    fila.font = i === 0 ? { bold: true, size: 14, color: { argb: 'FF000B50' } } : { color: { argb: 'FF475569' } };
  });
  ws.addRow([]);
  return { wb, ws, filaTitulos: lineas.length + 2 };
}

/** Fila de títulos de columna con el azul del logo, fija al hacer scroll. */
export function titulosDeColumna(ws, titulos, anchos) {
  const fila = ws.addRow(titulos);
  fila.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  fila.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000B50' } };
  fila.alignment = { vertical: 'middle' };
  fila.height = 22;
  ws.views = [{ state: 'frozen', ySplit: fila.number }];
  anchos.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  return fila;
}

/** Convierte los importes (texto NUMERIC) de las columnas indicadas a número con formato de pesos. */
export function pesos(fila, columnas) {
  for (const c of columnas) {
    const celda = fila.getCell(c);
    if (celda.value !== null && celda.value !== '' && celda.value !== undefined) celda.value = Number(celda.value);
    celda.numFmt = FORMATO_PESOS;
  }
}

export async function enviarLibro(res, wb, nombre) {
  const buffer = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}.xlsx"`);
  res.send(Buffer.from(buffer));
}
