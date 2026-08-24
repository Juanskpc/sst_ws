import { pool } from '../../config/db.js';
import { notFound } from '../../utils/httpError.js';
import { storage } from '../../services/storage.service.js';
import { generateFormatoPdf } from '../../services/pdf.service.js';
import {
  ALIADO_POR_DEFECTO, generarFormatosArl, tieneFormatosPropios,
} from '../../services/formatos-arl.service.js';

/** Carga una OS expandida (con nombres de ARL/profesional) o lanza 404. */
export async function getOrderExpanded(id, client = pool) {
  const r = await client.query(`SELECT * FROM sst.vw_ordenes_expandidas WHERE id=$1`, [id]);
  if (!r.rows[0]) throw notFound('OS no encontrada');
  return r.rows[0];
}

/**
 * ASG-08 · Ficha de profesional que corresponde a una cuenta de acceso.
 *
 * Se resuelve primero por `usuario_id` —el enlace explícito, que es el que deja
 * el backfill del seed y el alta desde /profesionales— y solo si no hay, por
 * correo. El segundo intento existe porque las fichas y las cuentas se crearon
 * en pantallas distintas durante meses y nada las cruzaba: sin él, un
 * profesional dado de alta antes que su cuenta vería el dashboard vacío.
 *
 * El respaldo por correo exige correspondencia 1-a-1, igual que el backfill:
 * hay fichas que comparten buzón, y con `LIMIT 1` el profesional acabaría
 * viendo las órdenes de un compañero. Ante ambigüedad se devuelve null y la
 * vista pide que un administrador enlace la ficha.
 */
export async function profesionalDeUsuario(usuario, client = pool) {
  // El JWT trae el id del usuario en `sub`; se acepta `id` también para poder
  // llamar a esta función con una fila de sst.usuarios recién leída.
  const usuarioId = usuario?.sub || usuario?.id;
  if (!usuarioId) return null;
  const porEnlace = await client.query(
    `SELECT * FROM sst.profesionales WHERE usuario_id = $1 LIMIT 1`,
    [usuarioId]
  );
  if (porEnlace.rows[0]) return porEnlace.rows[0];

  if (!usuario.correo) return null;
  const porCorreo = await client.query(
    `SELECT * FROM sst.profesionales
      WHERE lower(btrim(correo)) = lower(btrim($1))`,
    [usuario.correo]
  );
  return porCorreo.rows.length === 1 ? porCorreo.rows[0] : null;
}

/** Cambia el estado usando la función de dominio (valida transición + auditoría). */
export async function changeStatus({ orderId, newStatus, userId, motivo = null }, client = pool) {
  const r = await client.query(
    `SELECT * FROM sst.cambiar_estado_orden($1, $2::sst.estado_orden, $3, $4)`,
    [orderId, newStatus, userId, motivo]
  );
  return r.rows[0];
}

/** Identidad de JD&D ante las ARL, editable desde `sst.configuracion`. */
async function aliadoEstrategico(client = pool) {
  const r = await client.query(`SELECT valor FROM sst.configuracion WHERE clave='aliado_estrategico'`);
  const guardado = r.rows[0]?.valor;
  return guardado && typeof guardado === 'object' ? { ...ALIADO_POR_DEFECTO, ...guardado } : ALIADO_POR_DEFECTO;
}

/**
 * M4/FOR · Genera los formatos auto-diligenciados de la OS y los archiva en
 * `documentos_generados`. Devuelve la lista, con el contenido en `_buffer` para
 * que el correo de asignación los adjunte sin volver a bajarlos del storage.
 *
 * Hay dos orígenes posibles y NO se mezclan:
 *
 *  1. El formato oficial de la ARL (`assets/formatos-arl/`), cuando existe. Es
 *     el que la ARL acepta radicado, así que manda sobre cualquier otra cosa.
 *  2. Las plantillas genéricas de `sst.plantillas` (CFG-03), para las ARL cuyos
 *     formatos todavía no están cargados.
 *
 * Adjuntar los dos a la vez dejaría al profesional eligiendo entre dos hojas
 * parecidas sin saber cuál vale, así que en cuanto una ARL tiene formato propio
 * sus plantillas genéricas dejan de emitirse.
 */
export async function generateOrderDocuments(orderId, client = pool) {
  const order = await getOrderExpanded(orderId, client);
  // ASG · El nombre que va IMPRESO es el del profesional registrado ante la ARL
  // cuando la orden lleva suplente (`profesional_formatos_id`), y el del ejecutor
  // en el caso normal. Es el único sitio donde los dos papeles se separan: el
  // correo, el `.ics`, el enlace de soportes, la agenda, la cuenta de cobro y la
  // encuesta siguen apuntando a `profesional_asignado_id`, que es quien trabaja.
  const firmanteId = order.profesional_formatos_id || order.profesional_asignado_id;
  const professional = firmanteId
    ? (await client.query(`SELECT * FROM sst.profesionales WHERE id=$1`, [firmanteId])).rows[0]
    : null;

  // Se leen aquí y no se reciben por parámetro para que el formato salga con lo
  // que quedó guardado en esta misma transacción, no con lo que traía el body.
  const franjas = (await client.query(
    `SELECT fecha::text AS fecha, hora_inicio::text AS hora_inicio, hora_fin::text AS hora_fin
       FROM sst.franjas_visita WHERE orden_id=$1 ORDER BY fecha, hora_inicio`,
    [orderId]
  )).rows;

  const propios = tieneFormatosPropios(order.arl_nombre)
    ? await generarFormatosArl({
        orden: order, profesional: professional, franjas, aliado: await aliadoEstrategico(client),
      })
    : [];

  const created = [];

  for (const formato of propios) {
    const key = await storage.put('documents', `${order.codigo || order.id}_${formato.filename}`, formato.buffer);
    const doc = await client.query(
      `INSERT INTO sst.documentos_generados (orden_id, plantilla_id, tipo, url_pdf)
       VALUES ($1,NULL,$2,$3) RETURNING *`,
      [orderId, formato.tipo, key]
    );
    // `_etiqueta` y `_prediligenciado` no van a BD: los usa el correo para
    // enumerar lo que ESTA orden lleva adjunto, con el nombre de la ARL.
    created.push({
      ...doc.rows[0], _buffer: formato.buffer, _filename: formato.filename,
      _etiqueta: formato.etiqueta, _prediligenciado: formato.prediligenciado,
    });
  }
  if (created.length) return created;

  const tpls = await client.query(
    // CFG-03 · `orden` deja al administrador decidir en qué secuencia salen los
    // formatos de una ARL (el correo de asignación los adjunta en este orden).
    `SELECT * FROM sst.plantillas WHERE activo AND (arl_id = $1 OR arl_id IS NULL)
      ORDER BY orden, nombre`,
    [order.arl_id]
  );

  for (const template of tpls.rows) {
    const buffer = await generateFormatoPdf({ template, order, professional });
    const key = await storage.put('documents', `${order.codigo || order.id}_${template.tipo}.pdf`, buffer);
    const doc = await client.query(
      `INSERT INTO sst.documentos_generados (orden_id, plantilla_id, tipo, url_pdf)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [orderId, template.id, template.tipo, key]
    );
    created.push({
      ...doc.rows[0], _buffer: buffer, _filename: `${template.tipo}.pdf`,
      _etiqueta: template.nombre || template.tipo, _prediligenciado: true,
    });
  }
  return created;
}
