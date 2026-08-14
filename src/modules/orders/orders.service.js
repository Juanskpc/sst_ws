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
