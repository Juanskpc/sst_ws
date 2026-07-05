import { env } from '../config/env.js';

/**
 * Motor de IA del PRODUCTO = Google Gemini (NO Claude).
 * Si GEMINI_API_KEY está vacío → se usa un extractor MOCK realista, de modo que
 * todo el pipeline funcione end-to-end. Enchufar Gemini real = solo poner la key.
 *
 * ⚠️ Verificar IDs de modelo/params vigentes en la doc oficial de Gemini.
 */

// Campos canónicos IMP-06 (cada uno { value, confidence }).
export const CANONICAL_FIELDS = [
  'codigo_cronograma', 'secuencia', 'nit_nic', 'empresa_nombre',
  'actividad_economica', 'horas_asignadas',
  'contacto_sst_nombre', 'contacto_sst_telefono', 'contacto_sst_correo',
  'descripcion',
];

// responseSchema para salida estructurada (subconjunto OpenAPI Schema).
const fieldSchema = {
  type: 'object',
  properties: { value: { type: 'string' }, confidence: { type: 'number' } },
  required: ['value', 'confidence'],
};
export const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(CANONICAL_FIELDS.map((f) => [f, fieldSchema])),
  required: CANONICAL_FIELDS.filter((f) => !f.startsWith('contacto_sst_')),
};

let _ai = null;
async function getClient() {
  if (_ai) return _ai;
  const { GoogleGenAI } = await import('@google/genai');
  _ai = new GoogleGenAI({ apiKey: env.gemini.apiKey });
  return _ai;
}

const EXTRACTION_PROMPT = `Eres un extractor experto de Órdenes de Servicio de ARL colombianas (SST).
Extrae los campos canónicos del documento adjunto. Para cada campo devuelve
{value, confidence} donde confidence es tu certeza 0-100. Si un campo no aparece
o está ilegible/truncado (típico en descripción de AXA), usa el mejor valor posible
y una confidence baja. Responde SOLO el JSON del esquema.`;

/** Clasifica un PDF entre AXA Colpatria y Colmena (IMP-05). */
export async function classifyPdfArl(buffer) {
  if (!env.gemini.enabled) return mockClassify(buffer);
  try {
    const ai = await getClient();
    const resp = await ai.models.generateContent({
      model: env.gemini.modelFlash,
      contents: [
        { text: 'Clasifica esta OS por ARL. Responde solo: "AXA Colpatria" o "Colmena".' },
        { inlineData: { mimeType: 'application/pdf', data: buffer.toString('base64') } },
      ],
    });
    const t = (resp.text || '').toLowerCase();
    return t.includes('colmena') ? 'Colmena' : 'AXA Colpatria';
  } catch (e) {
    console.warn('[gemini] clasificación falló, usando heurística:', e.message);
    return mockClassify(buffer);
  }
}

/** Extrae los campos canónicos de un PDF con Gemini (o mock). */
export async function extractFromPdf(buffer, arlNombre) {
  if (!env.gemini.enabled) return mockExtract(arlNombre);
  try {
    const ai = await getClient();
    const resp = await ai.models.generateContent({
      model: env.gemini.modelPro,
      contents: [
        { text: EXTRACTION_PROMPT },
        { inlineData: { mimeType: 'application/pdf', data: buffer.toString('base64') } },
      ],
      config: { responseMimeType: 'application/json', responseSchema: EXTRACTION_SCHEMA },
    });
    return { fields: JSON.parse(resp.text), engine: env.gemini.modelPro };
  } catch (e) {
    console.warn('[gemini] extracción falló, usando mock:', e.message);
    return mockExtract(arlNombre);
  }
}

/** Resumen ejecutivo de 3 párrafos por OS (Informes M10, ya maquetado). */
export async function executiveSummary(order) {
  if (!env.gemini.enabled) return mockSummary(order);
  try {
    const ai = await getClient();
    const resp = await ai.models.generateContent({
      model: env.gemini.modelFlash,
      contents: [{
        text: `Redacta un resumen ejecutivo de exactamente 3 párrafos de esta Orden de Servicio SST,
destacando requisitos especiales (ej. trabajo en alturas certificado). Datos:\n${JSON.stringify(order)}`,
      }],
    });
    return resp.text || mockSummary(order);
  } catch (e) {
    console.warn('[gemini] resumen falló, usando mock:', e.message);
    return mockSummary(order);
  }
}

/**
 * Buscador en lenguaje natural → filtros estructurados (Informes M10).
 * Devuelve { arl?, minHoras?, bajaConfianza?, status?, texto? }.
 */
export async function interpretSearch(queryText) {
  if (env.gemini.enabled) {
    try {
      const ai = await getClient();
      const resp = await ai.models.generateContent({
        model: env.gemini.modelFlash,
        contents: [{
          text: `Convierte esta búsqueda en filtros JSON con claves opcionales
{arl, minHoras, bajaConfianza (bool), status, texto}. Búsqueda: "${queryText}"`,
        }],
        config: { responseMimeType: 'application/json' },
      });
      return JSON.parse(resp.text);
    } catch (e) {
      console.warn('[gemini] interpretación NL falló, usando keywords:', e.message);
    }
  }
  return keywordInterpret(queryText);
}

// ============================ MOCKS realistas ================================

function mockClassify(buffer) {
  // Heurística barata por tamaño/paridad — determinista para el mismo archivo.
  return buffer.length % 2 === 0 ? 'AXA Colpatria' : 'Colmena';
}

const rand = (min, max) => Math.round(min + Math.random() * (max - min));

function mockExtract(arlNombre) {
  const isAxa = /axa/i.test(arlNombre || '');
  const empresas = [
    ['Construcciones del Valle Ltda.', '901.225.480-3', 'Obras de ingeniería civil (CIIU 4290)'],
    ['Logística Express Colombia', '830.090.112-8', 'Almacenamiento y depósito (CIIU 5210)'],
    ['Inversiones Andinas S.A.S', '900.184.552-1', 'Construcción de edificios residenciales (CIIU 4111)'],
  ];
  const [empresa, nit, actividad] = empresas[rand(0, empresas.length - 1)];
  const seq = rand(40, 99);
  // AXA suele traer descripción truncada y NIT/horas de baja confianza.
  const base = isAxa ? [58, 78] : [78, 92];
  const f = (v, lo, hi) => ({ value: String(v), confidence: rand(lo, hi) });
  return {
    engine: 'mock',
    fields: {
      codigo_cronograma:   f(`CRN-2026-0${100 + seq}`, base[0], base[1]),
      secuencia:           f(`SEC-00${seq}`, base[0] + 5, base[1] + 3),
      nit_nic:             f(isAxa ? nit.replace(/\d(?=\d{2}-)/, '?') : nit, isAxa ? 58 : 84, isAxa ? 66 : 96),
      empresa_nombre:      f(empresa, base[0] + 8, base[1] + 4),
      actividad_economica: f(actividad, base[0], base[1]),
      horas_asignadas:     f(String(rand(4, 8)), isAxa ? 55 : 82, isAxa ? 62 : 94),
      contacto_sst_nombre:   f('Andrés Caicedo', base[0] + 6, base[1]),
      contacto_sst_telefono: f('+57 313 402 8890', base[0], base[1] - 5),
      contacto_sst_correo:   f('contacto.sst@empresa.com.co', base[0] + 3, base[1]),
      descripcion: f(
        isAxa
          ? 'Inspección de condiciones de seguridad en obra. Documento escaneado con baja legibilidad; verificar contra el original…'
          : 'Evaluación de riesgo biomecánico; recomendaciones de pausas activas y ajuste de estaciones de trabajo.',
        isAxa ? 55 : 80, isAxa ? 64 : 88
      ),
    },
  };
}

function mockSummary(order) {
  const alturas = /altura/i.test(JSON.stringify(order));
  return [
    `La Orden de Servicio para ${order.empresa_nombre || 'la empresa'} (${order.arl_nombre || 'ARL'}) contempla ${order.horas_asignadas || 'N'} horas de intervención en el marco del SG-SST (Resolución 0312 de 2019).`,
    `La actividad económica registrada es "${order.actividad_economica || 'no especificada'}", con contacto SST ${order.contacto_sst_nombre || 'por confirmar'}. El alcance descrito prioriza la identificación de peligros y la verificación de controles en terreno.`,
    alturas
      ? 'Requisito especial detectado: trabajo en alturas — se exige equipo certificado y personal con curso vigente (Res. 4272 de 2021) antes de la ejecución.'
      : 'No se detectaron requisitos especiales de alto riesgo; se recomienda validar los soportes al cierre de la visita.',
  ].join('\n\n');
}

function keywordInterpret(q) {
  const text = (q || '').toLowerCase();
  const filters = {};
  for (const arl of ['bolívar', 'bolivar', 'axa', 'colmena']) {
    if (text.includes(arl)) filters.arl = arl.startsWith('bol') ? 'Bolívar' : arl === 'axa' ? 'AXA Colpatria' : 'Colmena';
  }
  const m = text.match(/m[aá]s de (\d+)\s*hora/);
  if (m) filters.minHoras = parseInt(m[1], 10);
  if (/baja confianza|poca confianza|alerta/.test(text)) filters.bajaConfianza = true;
  return filters;
}
