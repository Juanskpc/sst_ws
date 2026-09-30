import { pool } from '../../config/db.js';
import { badRequest, notFound } from '../../utils/httpError.js';
import { proveedorFE } from './index.js';
import { hoyCO } from '../../utils/formato.js';

/**
 * A1-07 (FEL-12, 19) · Eventos RADIAN de las facturas ya emitidas.
 *
 * Solo consulta y guarda lo que la DIAN ya decidió (acuse, reclamo, recibo,
 * aceptación expresa/tácita): no hay un botón que le "diga" a Factus que algo
 * se aceptó — el endpoint de escritura que documenta Factus
 * (`PATCH /v2/receptions/bills/:id/radian/events/:tipo`) es para facturas que
 * RECIBIMOS de un proveedor (C8-01, Fase C), no para las que emitimos, y su
 * aceptación tácita (034) "ocurre automáticamente pasados 3 días hábiles" del
 * lado de la DIAN (doc. pública de Factus, confirmado 28-sep-2026) — no algo
 * que el emisor registre a mano. Ver la nota completa (y Q-26) en
 * `adaptadores/factus.adaptador.js`.
 *
 * "Aceptación tácita" en Orbita es, por eso, un APUNTE INTERNO (nunca una
 * llamada a Factus): deja constancia de que, a la fecha, el plazo de crédito
 * venció sin que la DIAN haya anotado un reclamo (031) ni una aceptación
 * expresa (033) — información que la Fase B (cartera) va a necesitar. Si más
 * adelante la sincronización de eventos trae un 034 real de la DIAN, ESE es el
 * que manda; el apunte interno solo cubre el hueco mientras tanto.
 */

/** Prefijo con el que se guardan los eventos que vienen de Factus, para distinguirlos de los propios de Orbita. */
const PREFIJO_RADIAN = 'RADIAN_';
const CODIGO_ACEPTACION_INTERNA = 'ACEPTACION_TACITA_INTERNA';

async function cargarDocumentoConNumero(id) {
  const doc = (await pool.query(
    `SELECT id, estado, numero, prefijo FROM sst.documentos_electronicos WHERE id = $1 AND tipo = 'FACTURA'`,
    [id],
  )).rows[0];
  if (!doc) throw notFound('Esa factura no existe.');
  if (!doc.numero) throw badRequest('Esta factura todavía no tiene número (no está VALIDADA).');
  return doc;
}

/**
 * Trae los eventos RADIAN de Factus y guarda los que todavía no estaban (por
 * `codigo` + `fecha`: Factus no da un id propio de evento en la respuesta
 * documentada, así que esa pareja es la clave natural más cercana). No falla
 * si ya se habían consultado antes: simplemente no repite nada.
 */
export async function consultarEventosDocumento(documentoId, usuarioId) {
  const doc = await cargarDocumentoConNumero(documentoId);
  const eventos = await proveedorFE().consultarEventosRadian(doc.numero);

  const existentes = new Set((await pool.query(
    `SELECT codigo, datos->>'fecha' AS fecha FROM sst.documento_eventos WHERE documento_id = $1 AND codigo LIKE $2`,
    [documentoId, `${PREFIJO_RADIAN}%`],
  )).rows.map((r) => `${r.codigo}|${r.fecha ?? ''}`));

  let nuevos = 0;
  for (const e of eventos) {
    const codigo = `${PREFIJO_RADIAN}${e.codigo}`;
    const clave = `${codigo}|${e.fecha ?? ''}`;
    if (existentes.has(clave)) continue;
    await pool.query(
      `INSERT INTO sst.documento_eventos (documento_id, codigo, descripcion, usuario_id, datos)
       VALUES ($1, $2, $3, $4, $5)`,
      [documentoId, codigo, e.descripcion || codigo, usuarioId, JSON.stringify({ fecha: e.fecha, ...e.crudo })],
    );
    existentes.add(clave);
    nuevos++;
  }
  return { consultados: eventos.length, nuevos };
}

/**
 * "Actualizar eventos de las facturas de los últimos N días" (por defecto 60,
 * como pide la ficha): recorre las VALIDADAS de ese rango y consulta cada una.
 * Una factura que falle (red, Factus caído) no detiene a las demás; se lista
 * en `fallidas` con el motivo.
 */
export async function actualizarEventosEnLote({ dias = 60 } = {}, usuarioId) {
  const dd = Number.isFinite(Number(dias)) && Number(dias) > 0 ? Number(dias) : 60;
  const documentos = (await pool.query(
    `SELECT id, numero FROM sst.documentos_electronicos
      WHERE tipo = 'FACTURA' AND estado = 'VALIDADO' AND numero IS NOT NULL
        AND fecha_emision >= CURRENT_DATE - $1::int
      ORDER BY fecha_emision DESC`,
    [dd],
  )).rows;

  let nuevos = 0;
  const fallidas = [];
  for (const d of documentos) {
    try {
      const r = await consultarEventosDocumento(d.id, usuarioId);
      nuevos += r.nuevos;
    } catch (e) {
      fallidas.push({ documento_id: d.id, numero: d.numero, motivo: e.message });
    }
  }
  return { revisadas: documentos.length, nuevos, fallidas };
}

/**
 * Apunte interno de aceptación tácita (ver la nota de cabecera: nunca llama a
 * Factus). Exige crédito, plazo vencido y que no haya ya un reclamo o una
 * aceptación (expresa o ya apuntada) registrados.
 *
 * ⚠️ El plazo legal exacto de la aceptación tácita (3 días hábiles desde el
 * evento "recibo del bien o servicio", según Factus) no es lo mismo que nuestro
 * `fecha_vencimiento` (que es el plazo de PAGO pactado, `plazo_dias` de A0-07):
 * se usa como aproximación razonable mientras no haya un evento 032 (recibo)
 * propio que contar — Q-26 deja la pregunta abierta para la contadora/Factus.
 */
export async function marcarAceptacionTacita(documentoId, usuarioId) {
  const doc = (await pool.query(
    `SELECT d.id, d.estado, d.numero, fp.codigo_dian AS forma_pago_codigo,
            to_char(d.fecha_vencimiento, 'YYYY-MM-DD') AS fecha_vencimiento
       FROM sst.documentos_electronicos d LEFT JOIN sst.formas_pago fp ON fp.id = d.forma_pago_id
      WHERE d.id = $1 AND d.tipo = 'FACTURA'`,
    [documentoId],
  )).rows[0];
  if (!doc) throw notFound('Esa factura no existe.');
  if (doc.estado !== 'VALIDADO') throw badRequest('Solo se puede marcar sobre una factura VALIDADA.');
  if (doc.forma_pago_codigo !== '2') throw badRequest('La aceptación tácita solo aplica a facturas a crédito.');
  const hoy = hoyCO();
  if (!doc.fecha_vencimiento || doc.fecha_vencimiento >= hoy) {
    throw badRequest('Todavía no vence el plazo de pago de esta factura.');
  }

  const bloqueo = (await pool.query(
    `SELECT codigo FROM sst.documento_eventos
      WHERE documento_id = $1 AND (codigo IN ($2, 'RADIAN_031', 'RADIAN_033') OR codigo LIKE 'RADIAN_03%')
      ORDER BY fecha DESC LIMIT 1`,
    [documentoId, CODIGO_ACEPTACION_INTERNA],
  )).rows[0];
  if (bloqueo?.codigo === CODIGO_ACEPTACION_INTERNA) {
    throw badRequest('Ya está marcada como aceptada tácitamente.');
  }
  if (bloqueo) {
    throw badRequest(`La DIAN ya registró un evento (${bloqueo.codigo.replace('RADIAN_', '')}) sobre esta factura; consulte los eventos antes de marcarla.`);
  }

  await pool.query(
    `INSERT INTO sst.documento_eventos (documento_id, codigo, descripcion, usuario_id)
     VALUES ($1, $2, $3, $4)`,
    [
      documentoId, CODIGO_ACEPTACION_INTERNA,
      `Apunte interno de Orbita: venció el plazo de pago (${doc.fecha_vencimiento}) sin reclamo ni aceptación expresa registrados. No es un evento enviado a la DIAN.`,
      usuarioId,
    ],
  );
  return { documento_id: documentoId, marcada: true };
}
