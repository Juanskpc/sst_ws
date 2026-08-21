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

// ---------------------------------------------------------------------------
// Excel SIPAB (Bolívar)
// ---------------------------------------------------------------------------
//
// El SIPAB exporta SIEMPRE las mismas 41 columnas, así que la lectura es por
// **nombre exacto** de encabezado y no por parecido. Antes se buscaba por
// subcadena y eso mapeaba mal dos columnas que se llaman casi igual:
// "Descripcion Estado Empresa" —el estado de la empresa, "Activa"— ganaba el
// campo `descripcion` y dejaba fuera "Descripcion" (el título real de la
// actividad) y "Observaciones" (el detalle con contacto y requisitos). Las 99
// órdenes del SIPAB real entraban con descripción "Activa", y el formato AT-028
// imprimía "Activa" como Tema de la sesión.
//
// Las claves están normalizadas (minúsculas, sin tildes, solo alfanumérico).
// Las columnas que el SIPAB trae y NO se extraen se declaran con `null` para
// que el reconocimiento aproximado de más abajo no vuelva a pescarlas. Los
// valores que empiezan por `@` no son campos canónicos: son columnas auxiliares
// de las que se DERIVAN campos (la ubicación) o que se guardan como contexto.
const SIPAB_HEADERS = {
  'nit empresa': 'nit_nic',
  'razon social': 'empresa_nombre',
  'descripcion estado empresa': null,       // "Activa" — estado de la EMPRESA, no de la actividad
  'en mora': null,
  'numero cronograma': 'codigo_cronograma',
  'actividad cronograma': 'secuencia',
  'actividad programa': 'actividad_economica', // código del programa (508.11.15)
  'descripcion': 'tipo_actividad',          // título real de la actividad ("PRIMEROS AUXILIOS")
  'unidad medida': '@unidad_medida',
  'act programadas': 'horas_asignadas',
  'act ejecutadas': null,
  'act canceladas': null,
  'act reprogramadas': null,
  'aplazadas': null,
  'autor fact': null,
  'tipo servicio': '@tipo_servicio',
  'nro trabajadores programados': '@nro_trabajadores',
  'fecha programada': 'fecha_orden',
  'fecha ejecutada': null,
  'fecha reprogramada': null,
  'hora programada': '@hora_programada',
  'hora ejecutada': null,
  'nivel aplicacion': null,
  'valor transporte': null,
  'valor alojamiento': null,
  'valor alimentacion': null,
  'valor tiempo muerto': null,
  'valor desplazamiento': null,
  'autoriza viaticos': null,
  'valor material complementario': null,
  'proveedor': null,
  'nombre proveedor': null,                 // JD&D, el proveedor: no es la empresa cliente
  'profesional': null,
  'nombre profesional': '@profesional_arl', // profesional que sugiere la ARL (casi siempre vacío)
  'asesor gestion riesgos crono': null,
  'nombre asesor gestion riesgos': null,
  'director sectorial': null,
  'nombre director sectorial': null,
  'observaciones': 'descripcion',           // el detalle real: tema, contacto y requisitos
  'num pol': '@num_poliza',
  'ubicacion actividad': '@ubicacion',      // departamento, ciudad, dirección, teléfono y contacto
};

// Sinónimos para hojas que NO son el SIPAB tal cual (columnas añadidas a mano,
// como la de vencimiento de `docs/BasesDatosEjemplo/…-con-vencimiento.xlsx`).
// Solo se consultan para encabezados que el mapa exacto no conoce, así que ya
// no pueden robarle la columna a la lectura oficial.
const HEADER_MAP = [
  ['codigo_cronograma', ['numero cronograma', 'codigo cronograma', 'cronograma', 'crn']],
  ['secuencia', ['actividad cronograma', 'secuencia', 'sec', 'consecutivo']],
  ['nit_nic', ['nit empresa', 'nit', 'nic', 'identificacion']],
  ['empresa_nombre', ['razon social', 'empresa', 'cliente']],
  ['actividad_economica', ['actividad programa', 'actividad economica', 'ciiu']],
  ['tipo_actividad', ['tipo actividad', 'tema', 'actividad a realizar']],
  ['horas_asignadas', ['act programadas', 'horas programadas', 'horas', 'cantidad']],
  ['ciudad_ejecucion', ['ciudad']],
  ['direccion', ['direccion', 'sede']],
  ['fecha_orden', ['fecha programada', 'fecha de la orden', 'fecha orden']],
  ['fecha_vencimiento', ['fecha vencimiento', 'vencimiento']],
  ['contacto_empresa_nombre', ['contacto empresa', 'nombre contacto']],
  ['contacto_empresa_telefono', ['telefono empresa']],
  ['contacto_sst_nombre', ['contacto sst', 'responsable sst']],
  ['contacto_sst_telefono', ['telefono', 'celular', 'movil']],
  ['contacto_sst_correo', ['correo', 'email', 'e mail', 'mail']],
  ['descripcion', ['observacion', 'descripcion', 'detalle']],
];

/** Encabezado → clave normalizada: minúsculas, sin tildes, solo alfanumérico. */
function normalizarEncabezado(texto) {
  const t = texto && typeof texto === 'object' ? (texto.text ?? texto.result ?? '') : texto;
  return String(t ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Mapea un encabezado DESCONOCIDO a su campo canónico eligiendo el sinónimo más
 * específico (el más largo que aparezca en el texto). Solo se usa de respaldo:
 * las columnas del SIPAB oficial las resuelve `SIPAB_HEADERS` por nombre exacto.
 */
function matchHeader(headerText) {
  const h = normalizarEncabezado(headerText);
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

const MESES = {
  ene: 1, jan: 1, feb: 2, mar: 3, abr: 4, apr: 4, may: 5, jun: 6, jul: 7,
  ago: 8, aug: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12, dec: 12,
};

/**
 * Celda de fecha del SIPAB → `YYYY-MM-DD`, o null si no parece una fecha.
 *
 * La MISMA columna llega con dos tipos: en el SIPAB real, 23 de las 99 filas de
 * "Fecha Programada" son fechas de Excel y las otras 76 son el texto
 * `01/aug/2026` (mes abreviado en inglés, como lo escribe el reporte). Ese texto
 * no lo entiende `parseFechaCO`, así que esas 76 órdenes se guardaban con la
 * fecha en blanco. Se normaliza aquí para que la hoja y el campo extraído se
 * lean idénticos al compararlos.
 */
export function normalizarFechaSipab(raw) {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  const s = String(raw).trim();
  let m = /^(\d{1,2})[/-]([A-Za-zÀ-ſ]{3,9})\.?[/-](\d{4})$/.exec(s);
  if (m) {
    const mes = MESES[m[2].normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().slice(0, 3)];
    if (mes) return `${m[3]}-${String(mes).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

const CLAVES_UBICACION = 'Departamento|Ciudad|Direcci[oó]n|Tel[eé]fono|Contacto';

/**
 * "Ubicacion Actividad" viene como una sola celda con cinco datos:
 *   `Departamento: NARINO - Ciudad: PASTO - Dirección: CR 21A 17 27 -
 *    Teléfono: 3105006718 - Contacto: JULLY VANESA GETIAL PINCHAO`
 * Es el ÚNICO sitio del SIPAB donde vienen la ciudad, la dirección y el
 * contacto de la empresa, y entraba entera en `ciudad_ejecucion`: el formato
 * AT-028 imprimía el párrafo completo dentro de la casilla "Ciudad".
 *
 * No se parte por " - " porque las direcciones lo contienen; cada valor se corta
 * en la siguiente etiqueta conocida.
 */
export function parseUbicacionActividad(texto) {
  const s = String(texto ?? '').trim();
  const out = {};
  if (!s) return out;
  const re = new RegExp(
    `(${CLAVES_UBICACION})\\s*:\\s*([\\s\\S]*?)(?=\\s*-\\s*(?:${CLAVES_UBICACION})\\s*:|$)`,
    'gi',
  );
  for (const m of s.matchAll(re)) {
    const clave = normalizarEncabezado(m[1]);
    const valor = m[2].trim().replace(/\s*-\s*$/, '');
    if (valor) out[clave] = valor;
  }
  return out;
}

const RE_CORREO = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const RE_CELULAR = /\b3\d{2}[ .-]?\d{3}[ .-]?\d{4}\b/;

/** Primer correo que aparezca en un texto libre, en minúsculas. */
function correoEn(texto) {
  const m = RE_CORREO.exec(String(texto ?? ''));
  return m ? m[0].toLowerCase() : '';
}

/** Primer celular colombiano que aparezca en un texto libre, sin separadores. */
function celularEn(texto) {
  const m = RE_CELULAR.exec(String(texto ?? ''));
  return m ? m[0].replace(/[ .-]/g, '') : '';
}

/** Celda como texto plano (resuelve fechas, fórmulas y texto enriquecido). */
function textoDeCelda(cell) {
  const raw = cell?.value;
  if (raw == null) return '';
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  if (typeof raw === 'object') return String(cell.text ?? raw.text ?? '').trim();
  return String(raw).trim();
}

/**
 * Excel no tiene un tipo "hora": guarda las horas sueltas como una fecha en su
 * día cero, el 30-dic-1899, con el formato `h:mm`. Por eso "Hora Programada" y
 * "Hora Ejecutada" llegan aquí como `1899-12-30T08:00Z` en vez de como 08:00.
 */
const DIA_CERO_EXCEL = '1899-12-30';

/** ¿La celda es una hora del día y no una fecha? */
function esHoraSuelta(valor, numFmt) {
  if (!(valor instanceof Date)) return false;
  if (valor.toISOString().slice(0, 10) === DIA_CERO_EXCEL) return true;
  // Red de seguridad para hojas guardadas con el sistema de fechas de 1904: se
  // mira el formato, que en una hora lleva horas y no lleva día ni año.
  const fmt = String(numFmt ?? '');
  return /h/i.test(fmt) && !/[yd]/i.test(fmt);
}

/** `1899-12-30T08:00Z` → "08:00". */
function horaTexto(valor) {
  const hh = String(valor.getUTCHours()).padStart(2, '0');
  const mm = String(valor.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * "Hora Programada" → "08:00". Es la hora a la que empieza la visita, NO su
 * duración: las horas de la orden salen de "Act Programadas" y solo cuando la
 * unidad de medida son HORAS.
 */
function horaDeCelda(row, col) {
  if (!col) return null;
  const cell = row.getCell(col);
  const raw = cell.value;
  if (esHoraSuelta(raw, cell.numFmt)) {
    const hora = horaTexto(raw);
    return hora === '00:00' ? null : hora;   // 00:00 = casilla sin diligenciar
  }
  const s = String(raw ?? '').trim();
  return /^\d{1,2}:\d{2}/.test(s) ? s : null;
}

/**
 * Parsing determinista del Excel SIPAB (Bolívar). Confianza alta (99) para lo
 * que viene en su propia columna, más baja para lo que se deduce de un texto
 * libre — que es justo lo que tiene que mirar quien revisa.
 * Devuelve [{ fields: {campo:{value,confidence}}, sourceRow, sipab }].
 */
export async function parseExcelSipab(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];

  // Localiza la fila de encabezados (la primera con ≥3 columnas reconocidas) y
  // arma dos mapas: campo canónico → columna, y columna auxiliar → columna.
  let headerRowIdx = 1;
  let colMap = {};
  let auxMap = {};
  for (let r = 1; r <= Math.min(ws.rowCount, 10); r++) {
    const row = ws.getRow(r);
    const map = {};
    const aux = {};
    const desconocidas = [];
    row.eachCell((cell, col) => {
      const clave = normalizarEncabezado(cell.value);
      if (!clave) return;
      if (clave in SIPAB_HEADERS) {
        const destino = SIPAB_HEADERS[clave];
        if (destino == null) return;                      // columna conocida que no se extrae
        if (destino.startsWith('@')) aux[destino.slice(1)] = col;
        else if (!map[destino]) map[destino] = col;
        return;
      }
      desconocidas.push([cell.value, col]);
    });
    // Respaldo aproximado, solo para encabezados que el SIPAB no declara.
    for (const [valor, col] of desconocidas) {
      const canonical = matchHeader(valor);
      if (canonical && !map[canonical]) map[canonical] = col;
    }
    if (Object.keys(map).length + Object.keys(aux).length >= 3) {
      headerRowIdx = r;
      colMap = map;
      auxMap = aux;
      break;
    }
  }

  const celda = (row, col) => (col ? textoDeCelda(row.getCell(col)) : '');

  const records = [];
  for (let r = headerRowIdx + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const fields = {};
    const poner = (campo, value, confidence = 99) => {
      fields[campo] = { value: value || '', confidence: value ? confidence : 0 };
    };

    // 1) Columnas directas.
    let hasData = false;
    for (const canonical of CANONICAL_FIELDS) {
      const value = celda(row, colMap[canonical]);
      if (value) hasData = true;
      poner(canonical, value);
    }

    // 2) Fechas: la misma columna trae fechas de Excel y texto "01/aug/2026".
    for (const campo of ['fecha_orden', 'fecha_vencimiento']) {
      const iso = normalizarFechaSipab(fields[campo].value);
      if (iso) fields[campo].value = iso;
    }

    // 3) "Ubicacion Actividad" → ciudad, dirección y contacto de la empresa.
    //    Confianza 95 y no 99: el dato es fiable, pero sale de partir un texto.
    const ubic = parseUbicacionActividad(celda(row, auxMap.ubicacion));
    if (ubic.ciudad) poner('ciudad_ejecucion', ubic.ciudad, 95);
    if (ubic.direccion) poner('direccion', ubic.direccion, 95);
    if (ubic.contacto) poner('contacto_empresa_nombre', ubic.contacto, 95);
    if (ubic.telefono) poner('contacto_empresa_telefono', ubic.telefono, 95);

    // 4) El responsable de SST de la empresa no tiene columna: cuando existe, su
    //    correo y su celular van escritos dentro de las observaciones. Se
    //    rescatan con confianza 60 —por debajo del umbral de revisión (70)— para
    //    que salgan marcados y quien revisa los confirme contra la hoja.
    const observaciones = fields.descripcion.value;
    const correo = correoEn(observaciones);
    const celular = celularEn(observaciones);
    if (correo) poner('contacto_sst_correo', correo, 60);
    if (celular) poner('contacto_sst_telefono', celular, 60);

    // 5) "Act Programadas" son horas solo si la unidad de medida son HORAS. En
    //    UNIDADES (una investigación de accidente, por ejemplo) el número es una
    //    cantidad de actividades: un "1" que NO significa una hora. El SIPAB
    //    tampoco las trae en otra columna —"Hora Programada" es la hora de
    //    inicio de la visita (08:00), no una duración—, así que el campo se deja
    //    VACÍO para que lo diligencie quien revisa. Dejarlo con el número de
    //    actividades marcado en amarillo hacía que una orden de una investigación
    //    de accidente entrara a Órdenes como si fuera de una sola hora.
    const unidad = celda(row, auxMap.unidad_medida);
    if (fields.horas_asignadas.value && unidad && !/hora/i.test(unidad)) {
      fields.horas_asignadas.value = '';
      fields.horas_asignadas.confidence = 0;
    }

    // Fila válida solo si trae al menos cronograma o secuencia.
    if (hasData && (fields.codigo_cronograma.value || fields.secuencia.value)) {
      // Contexto del SIPAB que no es campo canónico pero explica la orden. Se
      // conserva en `metadatos_extraccion` para auditoría (y para las decisiones
      // que vengan después: la unidad de medida y la hora programada son las que
      // permiten entender una orden que no se midió en horas).
      const sipab = {
        unidad_medida: unidad || null,
        tipo_servicio: celda(row, auxMap.tipo_servicio) || null,
        nro_trabajadores: celda(row, auxMap.nro_trabajadores) || null,
        hora_programada: horaDeCelda(row, auxMap.hora_programada),
        num_poliza: (celda(row, auxMap.num_poliza) || '').replace(/^nro\.?\s*/i, '') || null,
        departamento: ubic.departamento || null,
        profesional_sugerido_arl: celda(row, auxMap.profesional_arl) || null,
      };
      // `sourceRow` = número de fila real en la hoja. Permite que la vista previa
      // del documento resalte la fila de la que salió cada orden extraída.
      records.push({ fields, sourceRow: r, sipab });
    }
  }
  return records;
}

/**
 * Representación en texto plano de la hoja, para pintarla junto a los campos
 * extraídos en el modal de revisión (IMP-03). No interpreta nada: devuelve las
 * celdas tal como se ven en Excel para que el humano compare contra el original.
 *
 * Se acota el tamaño porque viaja por HTTP y se renderiza en el navegador.
 */
export async function readSheetPreview(buffer, { maxRows = 300, maxCols = 40 } = {}) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) return { hoja: null, columnas: 0, filas: [], truncado: false };

  const totalCols = Math.min(ws.columnCount || 0, maxCols);
  const totalRows = Math.min(ws.rowCount || 0, maxRows);
  const filas = [];
  for (let r = 1; r <= totalRows; r++) {
    const row = ws.getRow(r);
    const celdas = [];
    for (let c = 1; c <= totalCols; c++) {
      const cell = row.getCell(c);
      // Las fechas se normalizan igual que en la extracción (ISO corto): así el
      // valor de la hoja y el campo extraído se leen idénticos al compararlos.
      // Incluye el texto `01/aug/2026` con el que el SIPAB escribe la mayoría de
      // sus fechas; si no lo fuera, `.text` resuelve fórmulas y texto enriquecido.
      const texto = String(cell.text ?? '').trim();
      // Las columnas de HORA se pintan como hora y no como fecha: Excel las
      // guarda en su día cero, así que "Hora Programada 08:00" aparecía en el
      // modal de revisión como `1899-12-30` —una fecha imposible al lado del
      // campo de horas, que es justo lo que había que comparar—.
      if (esHoraSuelta(cell.value, cell.numFmt)) {
        celdas.push(horaTexto(cell.value));
        continue;
      }
      celdas.push(
        cell.value instanceof Date
          ? cell.value.toISOString().slice(0, 10)
          : (normalizarFechaSipab(/^\d{1,2}[/-][A-Za-zÀ-ſ]{3,9}\.?[/-]\d{4}$/.test(texto) ? texto : null) ?? texto),
      );
    }
    // Se conservan las filas vacías intermedias: mantienen la numeración real.
    filas.push({ n: r, celdas });
  }
  return {
    hoja: ws.name,
    columnas: totalCols,
    filas,
    truncado: (ws.rowCount || 0) > totalRows || (ws.columnCount || 0) > totalCols,
  };
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
