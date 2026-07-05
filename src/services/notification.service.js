import { pool } from '../config/db.js';

/** Crea una notificación interna (campanita) para un usuario (M11). */
export async function notify({ userId, tipo, titulo, mensaje, datos = null }) {
  if (!userId) return null;
  const r = await pool.query(
    `INSERT INTO sst.notificaciones (usuario_id, tipo, titulo, mensaje, datos)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [userId, tipo, titulo, mensaje, datos]
  );
  return r.rows[0];
}

/** Notifica a todos los administradores (p.ej. soporte cargado). */
export async function notifyAdmins({ tipo, titulo, mensaje, datos = null }) {
  const admins = await pool.query(`SELECT id FROM sst.usuarios WHERE rol='admin' AND activo`);
  await Promise.all(
    admins.rows.map((a) => notify({ userId: a.id, tipo, titulo, mensaje, datos }))
  );
}
