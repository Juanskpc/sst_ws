import ExcelJS from 'exceljs';
import { CANONICAL_FIELDS, classifyPdfArl } from './gemini.service.js';
import { extractPdfWithOpenAI } from './openai-extraction.bridge.js';

/** Promedio de confianzas → confianza general de la OS (0-100). */
export function computeOverallConfidence(fields) {
  const vals = CANONICAL_FIELDS.map((f) => fields[f]?.confidence).filter((v) => typeof v === 'number');
  if (!vals.length) return 0;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

// Sinónimos de encabezados SIPAB (Bolívar) → campo canónico.
const HEADER_MAP = [
  ['codigo_cronograma', ['cronograma', 'codigo cronograma', 'código cronograma', 'crn']],
  ['secuencia', ['secuencia', 'sec']],
  ['nit_nic', ['nit', 'nic', 'identificacion', 'identificación']],
  ['empresa_nombre', ['empresa', 'razon social', 'razón social', 'cliente']],
  ['actividad_economica', ['actividad', 'ciiu', 'economica', 'económica']],
  ['horas_asignadas', ['horas', 'hora']],
  ['contacto_sst_nombre', ['contacto', 'nombre contacto', 'responsable']],
  ['contacto_sst_telefono', ['telefono', 'teléfono', 'celular', 'movil', 'móvil']],
  ['contacto_sst_correo', ['correo', 'email', 'e-mail', 'mail']],
  ['descripcion', ['descripcion', 'descripción', 'observacion', 'observación', 'detalle']],
];

function matchHeader(headerText) {
  const h = String(headerText || '').trim().toLowerCase();
  if (!h) return null;
  for (const [canonical, syns] of HEADER_MAP) {
    if (syns.some((s) => h.includes(s))) return canonical;
  }
  return null;
}

/**
 * Parsing determinista del Excel SIPAB (Bolívar). Confianza alta (~100%).
 * Devuelve un arreglo de registros: [{ fields: {campo:{value,confidence}} }].
 */
export async function parseExcelSipab(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];

  // Localiza la fila de encabezados (la primera con ≥3 coincidencias canónicas).
  let headerRowIdx = 1;
  let colMap = {};
  for (let r = 1; r <= Math.min(ws.rowCount, 10); r++) {
    const row = ws.getRow(r);
    const map = {};
    row.eachCell((cell, col) => {
      const canonical = matchHeader(cell.value);
      if (canonical && !map[canonical]) map[canonical] = col;
    });
    if (Object.keys(map).length >= 3) {
      headerRowIdx = r;
      colMap = map;
      break;
    }
  }

  const records = [];
  for (let r = headerRowIdx + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const fields = {};
    let hasData = false;
    for (const canonical of CANONICAL_FIELDS) {
      const col = colMap[canonical];
      let value = '';
      if (col) {
        const cell = row.getCell(col);
        value = cell.value == null ? '' : String(cell.value.text ?? cell.value).trim();
      }
      if (value) hasData = true;
      fields[canonical] = { value, confidence: value ? 99 : 0 };
    }
    // Fila válida solo si trae al menos cronograma o secuencia.
    if (hasData && (fields.codigo_cronograma.value || fields.secuencia.value)) {
      records.push({ fields });
    }
  }
  return records;
}

/**
 * Orquesta la extracción según ARL/formato.
 *  - Excel (Bolívar): determinista → múltiples OS por archivo.
 *  - PDF (AXA/Colmena): clasifica la ARL (aún Gemini — PENDIENTE DE MIGRACIÓN)
 *    y extrae los campos con **OpenAI** (motor principal, vía
 *    `extractPdfWithOpenAI`) → 1 OS por archivo.
 * Devuelve { arlNombre, records: [{ fields, engine }] }.
 */
export async function runExtraction({ buffer, mime, arlHint }) {
  const isExcel = /sheet|excel/.test(mime);
  if (isExcel) {
    const records = await parseExcelSipab(buffer);
    return {
      arlNombre: 'Bolívar',
      arlConfidence: 99, // Excel SIPAB → Bolívar por formato (determinista).
      records: records.map((r) => ({ ...r, engine: 'excel-determinista' })),
    };
  }
  // PDF: clasificar ARL por contenido si no viene forzada por el usuario.
  let arlNombre;
  let arlConfidence;
  if (arlHint) {
    arlNombre = arlHint;
    arlConfidence = 100; // ARL indicada manualmente por el usuario.
  } else {
    ({ arlNombre, confidence: arlConfidence } = await classifyPdfArl(buffer));
  }
  const { fields, engine } = await extractPdfWithOpenAI(buffer);
  return { arlNombre, arlConfidence, records: [{ fields, engine }] };
}
