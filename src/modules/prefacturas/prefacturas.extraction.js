import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { PdfExtractor } from '../../infrastructure/text/pdf-extractor.js';
import { cargarConfigOpenAIExtraccion } from '../../infrastructure/openai/openai-extraction.config.js';
import { PrefacturaSchema } from './prefacturas.schema.js';
import { SYSTEM_PROMPT_PREFACTURA, construirMensajePrefactura } from './prefacturas.prompt.js';
import { parseFechaCO } from '../../utils/parseo.js';
import { badRequest } from '../../utils/httpError.js';

const NOMBRE_ESQUEMA = 'prefactura_bolivar';

let _pdf = null;
let _client = null;
function deps() {
  if (_pdf === null) _pdf = new PdfExtractor();
  if (_client === null) {
    // Misma config que la extracción de órdenes (OPENAI_API_KEY / OPENAI_MODEL):
    // es la MISMA cuenta de OpenAI, solo cambia el esquema y el prompt.
    const cfg = cargarConfigOpenAIExtraccion(process.env);
    _client = new OpenAI({ apiKey: cfg.apiKey, timeout: cfg.timeoutMs, maxRetries: cfg.maxRetries });
  }
  return { pdf: _pdf, client: _client };
}

/**
 * Redondeo a centavos: los montos vienen de sumar líneas de un PDF y de la
 * respuesta de un modelo, así que pueden traer ruido de coma flotante
 * (142914.000000001). Un peso de diferencia no debe marcar en rojo el control
 * de la suma.
 */
const centavos = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * T0-09 · Extrae una prefactura de Bolívar con OpenAI (Structured Outputs).
 *
 * @returns {{
 *   numero_prefactura: string, plan_codigo: string|null, plan_descripcion: string|null,
 *   fecha_corte: string|null, valor_total: number, nit_proveedor: string|null,
 *   filas: Array<{codigo_cronograma:string, secuencia:string, nit_empresa:string|null,
 *     razon_social:string|null, actividad_programa:string|null, valor_actividad:number,
 *     alimentacion:number, alojamiento:number, transporte:number, material:number,
 *     tiempo_muerto:number, valor_a_facturar:number}>,
 *   suma_filas: number, cuadra: boolean,
 * }}
 * @throws {HttpError} si el PDF no tiene capa de texto o el modelo no responde.
 */
export async function extraerPrefactura(buffer) {
  const { pdf, client } = deps();
  const texto = await pdf.extraerTexto(new Uint8Array(buffer));
  if (!texto.trim()) {
    throw badRequest('El PDF no tiene texto extraíble (parece escaneado); no se puede leer con IA.');
  }

  const cfg = cargarConfigOpenAIExtraccion(process.env);
  let completion;
  try {
    completion = await client.chat.completions.parse({
      model: cfg.modelo,
      temperature: 0,
      max_completion_tokens: cfg.maxTokensRespuesta,
      response_format: zodResponseFormat(PrefacturaSchema, NOMBRE_ESQUEMA),
      messages: [
        { role: 'system', content: SYSTEM_PROMPT_PREFACTURA },
        { role: 'user', content: construirMensajePrefactura(texto) },
      ],
    });
  } catch (causa) {
    throw badRequest(`No se pudo leer la prefactura con IA: ${causa?.message || 'error de OpenAI'}.`);
  }

  const choice = completion.choices[0];
  if (!choice || choice.message.refusal || !choice.message.parsed) {
    throw badRequest('El modelo no devolvió una prefactura interpretable. Revise el PDF e intente de nuevo.');
  }
  const datos = choice.message.parsed;

  // T0-09 · Control determinista DESPUÉS de la IA: la suma de "valor a facturar"
  // debe cuadrar con el total del encabezado. No bloquea —la fila con el dato
  // torcido puede seguir siendo útil— pero la vista previa lo marca en rojo.
  const sumaFilas = centavos(datos.filas.reduce((acc, f) => acc + (Number(f.valor_a_facturar) || 0), 0));
  const valorTotal = centavos(datos.valor_total);

  return {
    numero_prefactura: String(datos.numero_prefactura || '').trim(),
    plan_codigo: datos.plan_codigo,
    plan_descripcion: datos.plan_descripcion,
    fecha_corte: parseFechaCO(datos.fecha_corte),
    valor_total: valorTotal,
    nit_proveedor: datos.nit_proveedor,
    filas: datos.filas.map((f) => ({
      codigo_cronograma: String(f.codigo_cronograma || '').trim(),
      secuencia: String(f.secuencia || '').trim(),
      nit_empresa: f.nit_empresa,
      razon_social: f.razon_social,
      actividad_programa: f.actividad_programa,
      valor_actividad: centavos(f.valor_actividad),
      alimentacion: centavos(f.alimentacion),
      alojamiento: centavos(f.alojamiento),
      transporte: centavos(f.transporte),
      material: centavos(f.material),
      tiempo_muerto: centavos(f.tiempo_muerto),
      valor_a_facturar: centavos(f.valor_a_facturar),
    })),
    suma_filas: sumaFilas,
    cuadra: Math.abs(sumaFilas - valorTotal) < 1,
  };
}
