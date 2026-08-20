/**
 * IMP-09 · ¿Este archivo trae una orden que YA está en el sistema?
 *
 * La pregunta se respondía después de procesar: el archivo entraba, la IA
 * extraía sus campos, y recién ahí el pipeline comparaba la identidad contra
 * `ordenes_servicio` y marcaba el borrador como DUPLICADA. El resultado era
 * correcto pero caro — cada reintento del mismo documento gastaba una petición
 * de IA completa para acabar en "esta orden ya existe", y en la bandeja actual
 * hay un PDF que se cargó cuatro veces.
 *
 * Aquí se responde ANTES, y sin IA, por dos caminos independientes:
 *
 *  1. **Huella del archivo** (`sha256`). Exacto: si estos bytes ya se
 *     procesaron y aquel lote dejó órdenes en el sistema, es el mismo
 *     documento. Funciona incluso con PDFs escaneados, que no tienen texto que
 *     leer.
 *  2. **Identidad en el texto**. Se extrae la capa de texto del PDF (pdfjs, ya
 *     instalado) y se pregunta a la BD si alguna orden registrada tiene su
 *     número —o su par cronograma+secuencia— dentro de ese texto. La dirección
 *     importa: no se adivina el número con una expresión regular y luego se
 *     busca en la BD, sino que se parte de los números que REALMENTE existen.
 *     Así el falso positivo exige que el documento contenga el identificador
 *     literal de otra orden, no que se parezca a uno.
 *
 * Para Excel no hace falta ninguno de los dos: el SIPAB de Bolívar se lee de
 * forma determinista (sin IA), así que solo se descarta cuando TODAS sus filas
 * ya están registradas — un archivo con órdenes nuevas mezcladas tiene que
 * entrar.
 *
 * Ninguna de las dos vías es infalible, y por eso el resultado no se impone: la
 * vista de Importar deja volver a meter el archivo a mano ("Procesar de todos
 * modos"). Un falso positivo cuesta un clic; un falso negativo, una petición de
 * IA — que es exactamente lo que ya pasaba antes.
 */
import crypto from 'node:crypto';
import { pool } from '../config/db.js';
import { parseExcelSipab } from './extraction.service.js';

/** Identificadores más cortos que esto no se buscan en el texto: colisionan. */
const LARGO_MINIMO_IDENTIDAD = 7;

export function hashArchivo(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** ¿El archivo es una hoja de cálculo? Mismo criterio que `runExtraction`. */
export function esExcel(mime, filename) {
  return /sheet|excel/.test(mime || '') || /\.(xlsx|xls)$/i.test(filename || '');
}

/** Solo alfanuméricos en mayúscula: '71 - 0002200107' → '710002200107'. */
function compactar(texto) {
  return String(texto ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/**
 * Ficha de la OS que ya existe, con lo que hace falta para decidir qué hacer:
 * el estado manda (una EJECUTADA no se recarga) y `deshabilitado` explica por
 * qué una orden "que existe" no aparece en la bandeja.
 */
const SELECT_ORDEN = `
  SELECT o.id, o.codigo, o.estado::text AS estado, o.empresa_nombre,
         o.numero_orden, o.codigo_cronograma, o.secuencia,
         o.fecha_programada, o.fecha_carga,
         a.nombre AS arl_nombre,
         p.nombre AS profesional_nombre,
         COALESCE((SELECT bd.deshabilitado
                     FROM sst.borradores_extraccion bd
                    WHERE bd.orden_servicio_id = o.id
                    ORDER BY bd.creado_en LIMIT 1), false) AS deshabilitado
    FROM sst.ordenes_servicio o
    JOIN sst.arls a ON a.id = o.arl_id
    LEFT JOIN sst.profesionales p ON p.id = o.profesional_asignado_id`;

/** Cómo se nombra la orden en pantalla: su número, o cronograma + secuencia. */
export function identidadDeOrden(o) {
  if (o.numero_orden) return o.numero_orden;
  if (o.codigo_cronograma || o.secuencia) {
    return [o.codigo_cronograma, o.secuencia].filter(Boolean).join(' · ');
  }
  return o.codigo || 'OS registrada';
}

/** Vía 1 · Bytes idénticos a un lote anterior que sí dejó órdenes. */
async function porHuella(hash, client) {
  const r = await client.query(
    `${SELECT_ORDEN}
      WHERE o.id IN (
        SELECT d.orden_servicio_id
          FROM sst.borradores_extraccion d
          JOIN sst.lotes_importacion l ON l.id = d.lote_importacion_id
         WHERE l.hash_archivo = $1 AND d.orden_servicio_id IS NOT NULL
        UNION
        SELECT d.duplicado_de
          FROM sst.borradores_extraccion d
          JOIN sst.lotes_importacion l ON l.id = d.lote_importacion_id
         WHERE l.hash_archivo = $1 AND d.duplicado_de IS NOT NULL
      )
      ORDER BY o.fecha_carga`,
    [hash]
  );
  return r.rows;
}

/**
 * Vía 2 · La identidad de una orden registrada aparece literalmente en el texto.
 *
 * El texto se compacta (fuera espacios, guiones y saltos) porque el número
 * viaja partido en el documento: en los PDF de AXA, '71 - 0002200107' llega
 * como dos fragmentos separados por el maquetado del propio PDF.
 */
async function porTextoDelDocumento(texto, client) {
  const compacto = compactar(texto);
  if (compacto.length < LARGO_MINIMO_IDENTIDAD) return [];
  const r = await client.query(
    `${SELECT_ORDEN}
      WHERE (
        o.numero_orden IS NOT NULL
        AND length(upper(regexp_replace(o.numero_orden, '[^0-9A-Za-z]', '', 'g'))) >= $2
        AND position(upper(regexp_replace(o.numero_orden, '[^0-9A-Za-z]', '', 'g')) IN $1) > 0
      ) OR (
        o.codigo_cronograma IS NOT NULL AND o.secuencia IS NOT NULL
        AND length(upper(regexp_replace(o.codigo_cronograma, '[^0-9A-Za-z]', '', 'g'))) >= $2
        AND position(upper(regexp_replace(o.codigo_cronograma, '[^0-9A-Za-z]', '', 'g')) IN $1) > 0
        AND position(upper(regexp_replace(o.secuencia, '[^0-9A-Za-z]', '', 'g')) IN $1) > 0
      )
      ORDER BY o.fecha_carga`,
    [compacto, LARGO_MINIMO_IDENTIDAD]
  );
  return r.rows;
}

/** Vía 3 · Excel SIPAB: se descarta solo si TODAS sus filas ya están cargadas. */
async function porFilasDelExcel(buffer, client) {
  const filas = await parseExcelSipab(buffer);
  if (!filas.length) return { ordenes: [], todas: false, total: 0 };

  const ordenes = [];
  for (const fila of filas) {
    const cron = fila.fields?.codigo_cronograma?.value || null;
    const sec = fila.fields?.secuencia?.value || null;
    if (!cron || !sec) continue;
    const r = await client.query(
      `${SELECT_ORDEN} WHERE o.codigo_cronograma = $1 AND o.secuencia = $2 LIMIT 1`,
      [cron, sec]
    );
    if (r.rows[0]) ordenes.push(r.rows[0]);
  }
  return { ordenes, todas: ordenes.length === filas.length, total: filas.length };
}

let _extractor = null;
async function textoDelPdf(buffer) {
  try {
    if (!_extractor) {
      const { PdfExtractor } = await import('../infrastructure/text/pdf-extractor.js');
      _extractor = new PdfExtractor();
    }
    return await _extractor.extraerTexto(new Uint8Array(buffer));
  } catch {
    // Un PDF que no se deja leer no es un duplicado: es un archivo que tendrá
    // que pasar por el pipeline normal, que sabe dar un error con sentido.
    return '';
  }
}

/**
 * ¿Vale la pena procesar este archivo?
 *
 * @returns {{ existe: boolean, via: 'huella'|'texto'|'excel'|null,
 *             ordenes: object[], total_filas?: number }}
 *   `existe` en false significa "adelante": puede seguir habiendo duplicados
 *   que solo la extracción detecte (un PDF escaneado y nunca visto), y para eso
 *   sigue estando el dedup del pipeline.
 */
export async function detectarOrdenExistente({ buffer, mime, filename, client = pool }) {
  const porHash = await porHuella(hashArchivo(buffer), client);
  if (porHash.length) return { existe: true, via: 'huella', ordenes: porHash };

  if (esExcel(mime, filename)) {
    const { ordenes, todas, total } = await porFilasDelExcel(buffer, client);
    return { existe: todas && ordenes.length > 0, via: 'excel', ordenes, total_filas: total };
  }

  const texto = await textoDelPdf(buffer);
  if (!texto) return { existe: false, via: null, ordenes: [] };
  const encontradas = await porTextoDelDocumento(texto, client);
  return { existe: encontradas.length > 0, via: 'texto', ordenes: encontradas };
}
