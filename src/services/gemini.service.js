import { env } from '../config/env.js';

/**
 * ⚠️ ESTE ARCHIVO NO ES EL MOTOR PRINCIPAL DE EXTRACCIÓN.
 *
 * El motor PRINCIPAL de extracción de documentos es **OpenAI** (`gpt-4o-mini`),
 * implementado en `infrastructure/openai/openai-extraction.service.ts` y cableado
 * al pipeline por `services/openai-extraction.bridge.js`. La orquestación vive en
 * `services/extraction.service.js` (Excel determinista + PDF → OpenAI).
 *
 * Este módulo conserva SOLO componentes auxiliares que **continúan usando Gemini**
 * y están **PENDIENTES DE MIGRACIÓN** a OpenAI (no hacen parte del motor principal
 * de extracción): `classifyPdfArl` (clasificación de ARL), `executiveSummary`
 * (resumen ejecutivo) e `interpretSearch` (búsqueda en lenguaje natural). Si
 * `GEMINI_API_KEY` está vacío, esas tres funciones caen a un MOCK realista.
 *
 * `CANONICAL_FIELDS` y `computeOverallConfidence` (importado desde extraction)
 * siguen siendo la fuente canónica de campos y se reutilizan en todo el pipeline.
 *
 * NOTA: `extractFromPdf` y `mockExtract` quedaron como **código muerto** tras la
 * migración de la extracción a OpenAI (ver marca @deprecated abajo).
 *
 * ⚠️ Para los componentes que aún usan Gemini, verificar IDs de modelo/params
 * vigentes en la documentación oficial de Gemini.
 */

// Campos canónicos IMP-06 (forma PLANA: cada uno { value, confidence }).
// Los contactos anidados del esquema OpenAI se aplanan a *_nombre/_cargo/... aquí.
// Ninguna ARL trae todos: los ausentes salen con value vacío/null.
export const CANONICAL_FIELDS = [
  'numero_orden', 'codigo_cronograma', 'secuencia', 'nro_afiliacion',
  'nit_nic', 'empresa_nombre', 'actividad_economica', 'tipo_actividad', 'modalidad',
  'horas_asignadas', 'valor_unitario', 'valor_total',
  'fecha_orden', 'fecha_vencimiento', 'ciudad_ejecucion', 'direccion',
  'contacto_empresa_nombre', 'contacto_empresa_cargo', 'contacto_empresa_telefono',
  'contacto_sst_nombre', 'contacto_sst_telefono', 'contacto_sst_correo',
  'descripcion',
];

/**
 * Campos que VIVEN en el borrador junto a los canónicos pero que NO se le piden
 * al modelo (ago-2026).
 *
 * `tipo_servicio_arl` lo trae el Excel SIPAB en su propia columna, de forma
 * determinista: pedírselo además a la IA sería pagar tokens por adivinar un dato
 * que ya está leído, con el riesgo de que se lo invente en los PDF de AXA y
 * Colmena, donde esa letra ni existe. `modalidad_ejecucion` no está en ningún
 * documento: la escribe quien revisa la orden.
 *
 * Se quedan fuera de `CANONICAL_FIELDS` —y por tanto del esquema de salida y de
 * la confianza general— pero dentro de `CAMPOS_BORRADOR`, que es lo que la vista
 * previa deja corregir y lo que se materializa en la OS.
 */
export const CAMPOS_REVISION = ['tipo_servicio_arl', 'modalidad_ejecucion', 'viaticos_valor'];

/** Todo lo que el borrador guarda y el modal de revisión puede corregir. */
export const CAMPOS_BORRADOR = [...CANONICAL_FIELDS, ...CAMPOS_REVISION];

// responseSchema para salida estructurada (subconjunto OpenAPI Schema).
const fieldSchema = {
  type: 'object',
  properties: { value: { type: 'string' }, confidence: { type: 'number' } },
  required: ['value', 'confidence'],
};
export const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(CANONICAL_FIELDS.map((f) => [f, fieldSchema])),
  required: CANONICAL_FIELDS.filter((f) => !f.startsWith('contacto_')),
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

/**
 * Clasifica un PDF entre AXA Colpatria y Colmena (IMP-05 / IA-01 / IA-03).
 *
 * Devuelve `{ arlNombre, confidence }`. La clasificación por defecto es por
 * CONTENIDO del documento (texto del PDF), determinista y con un nivel de
 * confianza 0-100. Si `GEMINI_API_KEY` está definido, Gemini refina el NOMBRE de
 * la ARL (la confianza se mantiene estimada por contenido) — esa parte sigue
 * PENDIENTE DE MIGRACIÓN a OpenAI y no hace parte del motor principal de extracción.
 */
export async function classifyPdfArl(buffer) {
  // IA-01/IA-03: clasificación por contenido con confianza (reemplaza la antigua
  // heurística aleatoria por paridad de bytes).
  const content = await classifyByContent(buffer);
  if (!env.gemini.enabled) return content;
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
    const arlNombre = t.includes('colmena') ? 'Colmena' : 'AXA Colpatria';
    // Gemini decide el nombre; la confianza se estima por contenido.
    return { arlNombre, confidence: content.confidence };
  } catch (e) {
    console.warn('[gemini] clasificación falló, usando clasificación por contenido:', e.message);
    return content;
  }
}

/**
 * Extrae los campos canónicos de un PDF con Gemini (o mock).
 *
 * @deprecated CÓDIGO MUERTO. La extracción de PDF migró a OpenAI
 * (`openai-extraction.bridge.js` → `extractPdfWithOpenAI`). Esta función ya no la
 * invoca ningún módulo del pipeline y se conserva solo como referencia histórica
 * de la rama Gemini; puede eliminarse en una limpieza posterior.
 */
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

/**
 * Resumen ejecutivo de 3 párrafos por OS (Informes M10, ya maquetado).
 *
 * PENDIENTE DE MIGRACIÓN. Este componente continúa utilizando Gemini y no hace
 * parte del motor principal de extracción (que ya es OpenAI).
 */
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
 *
 * PENDIENTE DE MIGRACIÓN. Este componente continúa utilizando Gemini y no hace
 * parte del motor principal de extracción (que ya es OpenAI).
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

// IA-01: clasificación de ARL por CONTENIDO del PDF (AXA Colpatria vs Colmena),
// determinista y basada en el texto real del documento (no en el tamaño del archivo).
// Reutiliza el PdfExtractor ya existente (pdfjs) — sin nuevas dependencias.
let _pdfClassifier = null;
async function extractPdfTextForArl(buffer) {
  try {
    if (_pdfClassifier === null) {
      const { PdfExtractor } = await import('../infrastructure/text/pdf-extractor.js');
      _pdfClassifier = new PdfExtractor();
    }
    return await _pdfClassifier.extraerTexto(new Uint8Array(buffer));
  } catch {
    return '';
  }
}

/** Clasifica AXA Colpatria vs Colmena por keywords en el texto, con confianza 0-100. */
async function classifyByContent(buffer) {
  const text = (await extractPdfTextForArl(buffer)).toLowerCase();
  const axa = (text.match(/axa|colpatria/g) || []).length;
  const colmena = (text.match(/colmena/g) || []).length;
  const total = axa + colmena;
  if (total === 0) {
    // Sin señales en el texto (p. ej. PDF escaneado sin capa de texto): baja confianza.
    return { arlNombre: 'AXA Colpatria', confidence: 40 };
  }
  const esColmena = colmena >= axa;
  const ganador = esColmena ? colmena : axa;
  const confidence = Math.min(98, Math.round(60 + (ganador / total - 0.5) * 76));
  return { arlNombre: esColmena ? 'Colmena' : 'AXA Colpatria', confidence };
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
