import { pool } from '../../config/db.js';
import { notFound } from '../../utils/httpError.js';
import { storage } from '../../services/storage.service.js';
import { generateFormatoPdf } from '../../services/pdf.service.js';

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

/**
 * M4/FOR · Genera los formatos PDF auto-diligenciados para la OS a partir de
 * las plantillas de su ARL. Persiste en generated_documents y devuelve la lista.
 */
export async function generateOrderDocuments(orderId, client = pool) {
  const order = await getOrderExpanded(orderId, client);
  const professional = order.profesional_asignado_id
    ? (await client.query(`SELECT * FROM sst.profesionales WHERE id=$1`, [order.profesional_asignado_id])).rows[0]
    : null;

  const tpls = await client.query(
    // CFG-03 · `orden` deja al administrador decidir en qué secuencia salen los
    // formatos de una ARL (el correo de asignación los adjunta en este orden).
    `SELECT * FROM sst.plantillas WHERE activo AND (arl_id = $1 OR arl_id IS NULL)
      ORDER BY orden, nombre`,
    [order.arl_id]
  );

  const created = [];
  for (const template of tpls.rows) {
    const buffer = await generateFormatoPdf({ template, order, professional });
    const key = await storage.put('documents', `${order.codigo || order.id}_${template.tipo}.pdf`, buffer);
    const doc = await client.query(
      `INSERT INTO sst.documentos_generados (orden_id, plantilla_id, tipo, url_pdf)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [orderId, template.id, template.tipo, key]
    );
    created.push({ ...doc.rows[0], _buffer: buffer, _filename: `${template.tipo}.pdf` });
  }
  return created;
}
