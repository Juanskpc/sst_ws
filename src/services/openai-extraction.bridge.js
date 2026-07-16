// Puente mínimo JS→TS: conecta el pipeline de extracción existente con el
// OpenAIExtractionService (módulo TS congelado). NO es una capa nueva: es el
// glue imprescindible para (1) extraer texto del PDF, (2) instanciar el servicio
// con su config y (3) mapear el shape anidado de OpenAI al plano que el pipeline
// JS ya consume (ver matriz de compatibilidad).
import { OpenAIExtractionService } from '../infrastructure/openai/openai-extraction.service.js';
import { cargarConfigOpenAIExtraccion } from '../infrastructure/openai/openai-extraction.config.js';
import { PdfExtractor } from '../infrastructure/text/pdf-extractor.js';

let _svc = null;
let _pdf = null;
function deps() {
  if (_svc === null) _svc = new OpenAIExtractionService({ config: cargarConfigOpenAIExtraccion(process.env) });
  if (_pdf === null) _pdf = new PdfExtractor();
  return { svc: _svc, pdf: _pdf };
}

// Mapeo OpenAI → pipeline JS (matriz de compatibilidad):
//  • contacto_sst.* anidado → contacto_sst_* plano
//  • value null/undefined → ''  ·  horas_asignadas number → String
//  • confidence 1:1  ·  overall_confidence NO se propaga (lo recalcula el pipeline)
function aFieldsPlanos(data) {
  const s = (v) => (v === null || v === undefined ? '' : String(v));
  const c = data.contacto_sst;
  return {
    codigo_cronograma:     { value: s(data.codigo_cronograma.value),   confidence: data.codigo_cronograma.confidence },
    secuencia:             { value: s(data.secuencia.value),           confidence: data.secuencia.confidence },
    nit_nic:               { value: s(data.nit_nic.value),             confidence: data.nit_nic.confidence },
    empresa_nombre:        { value: s(data.empresa_nombre.value),      confidence: data.empresa_nombre.confidence },
    actividad_economica:   { value: s(data.actividad_economica.value), confidence: data.actividad_economica.confidence },
    horas_asignadas:       { value: s(data.horas_asignadas.value),     confidence: data.horas_asignadas.confidence },
    contacto_sst_nombre:   { value: s(c.nombre.value),                 confidence: c.nombre.confidence },
    contacto_sst_telefono: { value: s(c.telefono.value),               confidence: c.telefono.confidence },
    contacto_sst_correo:   { value: s(c.correo.value),                 confidence: c.correo.confidence },
    descripcion:           { value: s(data.descripcion.value),         confidence: data.descripcion.confidence },
  };
}

/**
 * Extrae los campos canónicos de un PDF usando OpenAI (reemplazo de extractFromPdf).
 * Devuelve { fields, engine } con el MISMO contrato que la rama Gemini anterior.
 * Los fallos afloran como excepción (→ lote ERROR); sin fallback silencioso a mock.
 */
export async function extractPdfWithOpenAI(buffer) {
  const { svc, pdf } = deps();
  const texto = await pdf.extraerTexto(new Uint8Array(buffer));
  if (!texto.trim()) {
    throw new Error('PDF sin capa de texto extraíble (posible escaneado; requiere OCR).');
  }
  const res = await svc.extraer(texto);
  if (!res.ok) throw res.error;
  return { fields: aFieldsPlanos(res.data), engine: res.meta.modelo };
}
