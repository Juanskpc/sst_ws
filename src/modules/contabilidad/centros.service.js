import { pool } from '../../config/db.js';
import { badRequest, conflict, notFound } from '../../utils/httpError.js';

/**
 * B8-01 (CNT-09) · Centros de costo: para ver los gastos por actividad
 * (honorarios, transporte, materiales…). Van, opcionales, en cada movimiento y
 * en cada compra; son obligatorios solo en las cuentas marcadas «exige centro de
 * costo». Un centro con movimientos no se borra: se inactiva.
 */

const SELECT = `
  c.id, c.codigo, c.nombre, c.activo, c.creado_en, c.actualizado_en, c.arl_id,
  (SELECT a.nombre FROM sst.arls a WHERE a.id = c.arl_id) AS arl_nombre,
  (SELECT count(*)::int FROM sst.movimientos m WHERE m.centro_costo_id = c.id) AS n_movimientos`;

export async function listarCentros({ soloActivos = false } = {}) {
  return (await pool.query(`SELECT ${SELECT} FROM sst.centros_costo c ${soloActivos ? 'WHERE c.activo' : ''} ORDER BY c.codigo`)).rows;
}

function validar(b = {}) {
  const codigo = String(b.codigo ?? '').trim().toUpperCase();
  const nombre = String(b.nombre ?? '').trim();
  if (!codigo) throw badRequest('El código del centro de costo es obligatorio.');
  if (codigo.length > 20) throw badRequest('El código es de máximo 20 caracteres.');
  if (!nombre) throw badRequest('El nombre del centro de costo es obligatorio.');
  return { codigo, nombre: nombre.slice(0, 200), arlId: b.arl_id || null };
}

/** Una ARL tiene a lo sumo UN centro de costo activo (el índice único lo exige; aquí se avisa claro). */
async function validarArl(arlId, exceptoId = null) {
  if (!arlId) return;
  const a = await pool.query(`SELECT nombre FROM sst.arls WHERE id = $1`, [arlId]);
  if (!a.rows[0]) throw badRequest('Esa ARL no existe.');
  const dup = await pool.query(
    `SELECT codigo FROM sst.centros_costo WHERE arl_id = $1 AND activo AND ($2::uuid IS NULL OR id <> $2)`, [arlId, exceptoId],
  );
  if (dup.rows[0]) throw conflict(`${a.rows[0].nombre} ya tiene su centro de costo (${dup.rows[0].codigo}).`);
}

async function cargar(id) {
  const r = (await pool.query(`SELECT ${SELECT} FROM sst.centros_costo c WHERE c.id = $1`, [id])).rows[0];
  if (!r) throw notFound('Ese centro de costo no existe.');
  return r;
}

export async function crearCentro(b) {
  const c = validar(b);
  const dup = await pool.query(`SELECT 1 FROM sst.centros_costo WHERE upper(codigo) = $1`, [c.codigo]);
  if (dup.rows[0]) throw conflict(`Ya existe el centro de costo ${c.codigo}.`);
  await validarArl(c.arlId);
  const r = await pool.query(`INSERT INTO sst.centros_costo (codigo, nombre, arl_id) VALUES ($1, $2, $3) RETURNING id`, [c.codigo, c.nombre, c.arlId]);
  return cargar(r.rows[0].id);
}

export async function actualizarCentro(id, b) {
  const c = validar(b);
  const dup = await pool.query(`SELECT 1 FROM sst.centros_costo WHERE upper(codigo) = $1 AND id <> $2`, [c.codigo, id]);
  if (dup.rows[0]) throw conflict(`Ya existe el centro de costo ${c.codigo}.`);
  await validarArl(c.arlId, id);
  const r = await pool.query(`UPDATE sst.centros_costo SET codigo = $2, nombre = $3, arl_id = $4 WHERE id = $1 RETURNING id`, [id, c.codigo, c.nombre, c.arlId]);
  if (!r.rows[0]) throw notFound('Ese centro de costo no existe.');
  return cargar(id);
}

export async function cambiarActivoCentro(id, activo) {
  let r;
  try {
    r = await pool.query(`UPDATE sst.centros_costo SET activo = $2 WHERE id = $1 RETURNING id`, [id, !!activo]);
  } catch (err) {
    // Reactivar un centro de una ARL que ya tiene otro activo.
    if (err.code === '23505') throw conflict('Esa ARL ya tiene otro centro de costo activo: inactívelo primero.');
    throw err;
  }
  if (!r.rows[0]) throw notFound('Ese centro de costo no existe.');
  return cargar(id);
}
