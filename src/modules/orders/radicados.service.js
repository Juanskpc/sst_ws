import { pool, withTransaction } from '../../config/db.js';
import { badRequest, notFound } from '../../utils/httpError.js';
import { esBolivar } from '../../utils/bolivar.js';

/**
 * 7-oct-2026 (reunión con JD&D) · Radicados de una orden ante la ARL.
 *
 * Cada radicado tiene número, fecha y un visto bueno (la ARL lo aceptó). Una orden
 * puede tener varios: si la ARL la devuelve, se radica de nuevo y el anterior queda
 * en el historial (se puede eliminar si fue un error). El VIGENTE es el más reciente,
 * y la orden guarda una copia para que la bandeja lo pinte sin otra consulta.
 *
 * Solo aplica a Bolívar, como el número de radicado del 1-oct-2026.
 */

const numeroLimpio = (v) => {
  const n = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (!n) throw badRequest('Escriba el n.º de radicado.');
  if (n.length > 40) throw badRequest('El n.º de radicado no puede pasar de 40 caracteres.');
  return n;
};

const fechaLimpia = (v) => {
  if (v == null || v === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v)) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
    throw badRequest('La fecha del radicado no es válida.');
  }
  return String(v);
};

async function exigirOrdenBolivar(db, ordenId) {
  const o = (await db.query(
    `SELECT o.id, a.nombre AS arl FROM sst.ordenes_servicio o LEFT JOIN sst.arls a ON a.id = o.arl_id WHERE o.id = $1 FOR UPDATE OF o`,
    [ordenId],
  )).rows[0];
  if (!o) throw notFound('Orden no encontrada.');
  if (!esBolivar(o.arl)) throw badRequest('El radicado solo aplica a las órdenes de Bolívar.');
  return o;
}

/** Copia el radicado vigente (el más reciente) a la orden; sin radicados, la deja limpia. */
async function sincronizarOrden(db, ordenId) {
  await db.query(
    `UPDATE sst.ordenes_servicio o
        SET numero_radicado     = v.numero,
            radicado_fecha      = v.fecha,
            radicado_aprobado   = COALESCE(v.aprobado, false),
            numero_radicado_en  = v.creado_en,
            numero_radicado_por = v.creado_por,
            actualizado_en      = now()
       FROM (SELECT $1::uuid AS orden_id) base
       LEFT JOIN LATERAL (
         SELECT numero, fecha, aprobado, creado_en, creado_por
           FROM sst.orden_radicados WHERE orden_id = $1 ORDER BY creado_en DESC, id DESC LIMIT 1
       ) v ON true
      WHERE o.id = base.orden_id`,
    [ordenId],
  );
}

/** El vigente primero y, después, los anteriores (del más reciente al más antiguo). */
export async function listarRadicados(ordenId, db = pool) {
  const r = await db.query(
    `SELECT r.id, r.numero, to_char(r.fecha, 'YYYY-MM-DD') AS fecha, r.aprobado, r.creado_en, u.nombre AS creado_por_nombre
       FROM sst.orden_radicados r LEFT JOIN sst.usuarios u ON u.id = r.creado_por
      WHERE r.orden_id = $1 ORDER BY r.creado_en DESC, r.id DESC`,
    [ordenId],
  );
  return r.rows.map((x, i) => ({ ...x, vigente: i === 0 }));
}

/** Registra un radicado NUEVO: pasa a ser el vigente y el anterior queda en el historial. */
export async function crearRadicado(ordenId, b = {}, usuarioId = null) {
  return withTransaction(async (db) => {
    await exigirOrdenBolivar(db, ordenId);
    await db.query(
      `INSERT INTO sst.orden_radicados (orden_id, numero, fecha, aprobado, creado_por) VALUES ($1, $2, $3, $4, $5)`,
      [ordenId, numeroLimpio(b.numero), fechaLimpia(b.fecha), b.aprobado === true, usuarioId],
    );
    await sincronizarOrden(db, ordenId);
    return listarRadicados(ordenId, db);
  });
}

/** Corrige un radicado ya guardado (número, fecha o visto bueno). */
export async function actualizarRadicado(ordenId, radicadoId, b = {}) {
  return withTransaction(async (db) => {
    await exigirOrdenBolivar(db, ordenId);
    const actual = (await db.query(
      `SELECT numero, to_char(fecha, 'YYYY-MM-DD') AS fecha, aprobado FROM sst.orden_radicados WHERE id = $1 AND orden_id = $2`,
      [radicadoId, ordenId],
    )).rows[0];
    if (!actual) throw notFound('Ese radicado no existe.');
    await db.query(
      `UPDATE sst.orden_radicados SET numero = $3, fecha = $4, aprobado = $5, actualizado_en = now() WHERE id = $1 AND orden_id = $2`,
      [radicadoId, ordenId,
        b.numero !== undefined ? numeroLimpio(b.numero) : actual.numero,
        b.fecha !== undefined ? fechaLimpia(b.fecha) : actual.fecha,
        b.aprobado !== undefined ? b.aprobado === true : actual.aprobado],
    );
    await sincronizarOrden(db, ordenId);
    return listarRadicados(ordenId, db);
  });
}

/** Elimina un radicado (vigente o del historial). Si era el vigente, pasa a serlo el anterior. */
export async function eliminarRadicado(ordenId, radicadoId) {
  return withTransaction(async (db) => {
    await exigirOrdenBolivar(db, ordenId);
    const r = await db.query(`DELETE FROM sst.orden_radicados WHERE id = $1 AND orden_id = $2 RETURNING id`, [radicadoId, ordenId]);
    if (!r.rows[0]) throw notFound('Ese radicado no existe.');
    await sincronizarOrden(db, ordenId);
    return listarRadicados(ordenId, db);
  });
}
