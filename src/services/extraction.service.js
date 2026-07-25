import ExcelJS from 'exceljs';
import { CANONICAL_FIELDS, classifyPdfArl } from './gemini.service.js';
import { extractPdfWithOpenAI } from './openai-extraction.bridge.js';

/**
 * Confianza general de la OS (0-100): promedio de la confianza de los campos que
 * SÍ traen valor. Los campos legítimamente ausentes en una ARL (p. ej. valores o
 * fechas en Bolívar) no cuentan, para no diluir artificialmente la confianza.
 */
export function computeOverallConfidence(fields) {
  const vals = CANONICAL_FIELDS
    .map((f) => fields[f])
    .filter((c) => c && c.value !== '' && c.value != null && typeof c.confidence === 'number')
    .map((c) => c.confidence);
  if (!vals.length) return 0;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

// Sinónimos de encabezados SIPAB (Bolívar) → campo canónico. El orden importa:
// las claves más específicas van primero (p. ej. "numero cronograma" antes que
// cualquier "actividad"). Bolívar no trae valores/fechas de orden ni afiliación.
const HEADER_MAP = [
  ['codigo_cronograma', ['numero cronograma', 'número cronograma', 'cronograma', 'codigo cronograma', 'código cronograma', 'crn']],
  ['secuencia', ['actividad cronograma', 'secuencia', 'sec', 'consecutivo']],
  ['nit_nic', ['nit empresa', 'nit', 'nic', 'identificacion', 'identificación']],
  ['empresa_nombre', ['razon social', 'razón social', 'empresa', 'cliente']],
  ['actividad_economica', ['actividad programa', 'actividad economica', 'actividad económica', 'ciiu']],
  ['horas_asignadas', ['act programadas', 'horas programadas', 'horas', 'hora', 'cantidad']],
  ['ciudad_ejecucion', ['ciudad', 'ubicacion actividad', 'ubicación actividad']],
  ['fecha_orden', ['fecha programada', 'fecha de la orden', 'fecha orden']],
  ['fecha_vencimiento', ['fecha vencimiento', 'fecha de vencimiento']],
  ['contacto_sst_nombre', ['nombre profesional', 'contacto', 'nombre contacto', 'responsable']],
  ['contacto_sst_telefono', ['telefono', 'teléfono', 'celular', 'movil', 'móvil']],
  ['contacto_sst_correo', ['correo', 'email', 'e-mail', 'mail']],
  ['descripcion', ['descripcion', 'descripción', 'observacion', 'observación', 'detalle']],
];

/**
 * Mapea un encabezado a su campo canónico eligiendo el sinónimo MÁS ESPECÍFICO
 * (el de mayor longitud que aparezca en el texto). Así "Actividad Cronograma"
 * gana con 'actividad cronograma' (→ secuencia) sobre 'cronograma' (→ cronograma).
 */
function matchHeader(headerText) {
  const h = String(headerText || '').trim().toLowerCase();
  if (!h) return null;
  let best = null;
  let bestLen = 0;
  for (const [canonical, syns] of HEADER_MAP) {
    for (const s of syns) {
      if (h.includes(s) && s.length > bestLen) {
        best = canonical;
        bestLen = s.length;
      }
    }
  }
  return best;
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
        const raw = row.getCell(col).value;
        if (raw == null) value = '';
        // Las celdas de fecha de exceljs son objetos Date → normaliza a ISO corto.
        else if (raw instanceof Date) value = raw.toISOString().slice(0, 10);
        else if (typeof raw === 'object' && raw.text != null) value = String(raw.text).trim();
        else value = String(raw).trim();
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
export async function runExtraction({ buffer, mime, filename, arlHint }) {
  // Algunos clientes suben .xlsx como application/octet-stream: se cae a la
  // extensión para no mandar un Excel por el camino de PDF.
  const isExcel = /sheet|excel/.test(mime || '') || /\.(xlsx|xls)$/i.test(filename || '');
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
