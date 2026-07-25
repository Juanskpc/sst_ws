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
//  • contacto_sst.* / contacto_empresa.* anidados → *_nombre/_cargo/... planos
//  • value null/undefined → ''  ·  números → String
//  • confidence 1:1  ·  overall_confidence NO se propaga (lo recalcula el pipeline)
function aFieldsPlanos(data) {
  const s = (v) => (v === null || v === undefined ? '' : String(v));
  const campo = (f) => ({ value: s(f.value), confidence: f.confidence });
  const cs = data.contacto_sst;
  const ce = data.contacto_empresa;
  return {
    numero_orden:          campo(data.numero_orden),
    codigo_cronograma:     campo(data.codigo_cronograma),
    secuencia:             campo(data.secuencia),
    nro_afiliacion:        campo(data.nro_afiliacion),
    nit_nic:               campo(data.nit_nic),
    empresa_nombre:        campo(data.empresa_nombre),
    actividad_economica:   campo(data.actividad_economica),
    tipo_actividad:        campo(data.tipo_actividad),
    modalidad:             campo(data.modalidad),
    horas_asignadas:       campo(data.horas_asignadas),
    valor_unitario:        campo(data.valor_unitario),
    valor_total:           campo(data.valor_total),
    fecha_orden:           campo(data.fecha_orden),
    fecha_vencimiento:     campo(data.fecha_vencimiento),
    ciudad_ejecucion:      campo(data.ciudad_ejecucion),
    direccion:             campo(data.direccion),
    contacto_empresa_nombre:   campo(ce.nombre),
    contacto_empresa_cargo:    campo(ce.cargo),
    contacto_empresa_telefono: campo(ce.telefono),
    contacto_sst_nombre:   campo(cs.nombre),
    contacto_sst_telefono: campo(cs.telefono),
    contacto_sst_correo:   campo(cs.correo),
    descripcion:           campo(data.descripcion),
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
