import { Router } from 'express';
import { pool } from '../../config/db.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { badRequest, notFound } from '../../utils/httpError.js';
import { authRequired, requireRole } from '../../middleware/auth.js';

const router = Router();
router.use(authRequired);

// CFG-01 · Listado (con buscador rápido opcional ?q=)
router.get('/', asyncHandler(async (req, res) => {
  const { q } = req.query;
  const params = [];
  let where = '';
  if (q) {
    params.push(`%${q}%`);
    where = `WHERE nombre ILIKE $1 OR correo ILIKE $1 OR especialidad ILIKE $1`;
  }
  const r = await pool.query(
    `SELECT * FROM sst.profesionales ${where} ORDER BY nombre`, params
  );
  res.json({ data: r.rows });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const r = await pool.query(`SELECT * FROM sst.profesionales WHERE id=$1`, [req.params.id]);
  if (!r.rows[0]) throw notFound('Profesional no encontrado');
  res.json({ data: r.rows[0] });
}));

// CFG-01 · Crear (admin)
router.post('/', requireRole('admin'), asyncHandler(async (req, res) => {
  const { nombre, telefono, especialidad, valor_hora = 0, estado = 'Activo' } = req.body || {};
  const correo = req.body?.correo || req.body?.email;
  if (!nombre || !correo) throw badRequest('nombre y correo son obligatorios');
  if (!['Activo', 'Inactivo'].includes(estado)) throw badRequest('estado inválido');
  const r = await pool.query(
    `INSERT INTO sst.profesionales (nombre, correo, telefono, especialidad, valor_hora, estado)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [nombre, correo, telefono, especialidad, valor_hora, estado]
  );
  res.status(201).json({ data: r.rows[0] });
}));

// CFG-01 · Editar (admin)
router.put('/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const { nombre, telefono, especialidad, valor_hora, estado } = req.body || {};
  const correo = req.body?.correo ?? req.body?.email ?? null;
  const r = await pool.query(
    `UPDATE sst.profesionales SET
       nombre = COALESCE($2, nombre),
       correo = COALESCE($3, correo),
       telefono = COALESCE($4, telefono),
       especialidad = COALESCE($5, especialidad),
       valor_hora = COALESCE($6, valor_hora),
       estado = COALESCE($7, estado)
     WHERE id=$1 RETURNING *`,
    [req.params.id, nombre, correo, telefono, especialidad, valor_hora, estado]
  );
  if (!r.rows[0]) throw notFound('Profesional no encontrado');
  res.json({ data: r.rows[0] });
}));

// CFG-01 · Alternar estado Activo/Inactivo (admin)
router.patch('/:id/estado', requireRole('admin'), asyncHandler(async (req, res) => {
  const r = await pool.query(
    `UPDATE sst.profesionales
       SET estado = CASE WHEN estado='Activo' THEN 'Inactivo'::sst.estado_profesional
                         ELSE 'Activo'::sst.estado_profesional END
     WHERE id=$1 RETURNING *`,
    [req.params.id]
  );
  if (!r.rows[0]) throw notFound('Profesional no encontrado');
  res.json({ data: r.rows[0] });
}));

// ===== Ocupaciones (agenda) del profesional — calendario de disponibilidad =====

async function ensureProfessional(id) {
  const r = await pool.query(`SELECT id FROM sst.profesionales WHERE id=$1`, [id]);
  if (!r.rows[0]) throw notFound('Profesional no encontrado');
}

// SELECT con fecha/hora ya formateadas como texto para el frontend.
const OCUPACION_COLS = `
  id, profesional_id,
  to_char(fecha, 'YYYY-MM-DD') AS fecha,
  to_char(hora_inicio, 'HH24:MI') AS hora_inicio,
  to_char(hora_fin, 'HH24:MI') AS hora_fin,
  motivo, creado_en`;

// Listar franjas ocupadas del profesional.
router.get('/:id/ocupaciones', asyncHandler(async (req, res) => {
  await ensureProfessional(req.params.id);
  const r = await pool.query(
    `SELECT ${OCUPACION_COLS}
     FROM sst.ocupaciones_profesional
     WHERE profesional_id=$1
     ORDER BY fecha, hora_inicio`,
    [req.params.id]
  );
  res.json({ data: r.rows });
}));

// Registrar una franja de ocupación (admin).
router.post('/:id/ocupaciones', requireRole('admin'), asyncHandler(async (req, res) => {
  await ensureProfessional(req.params.id);
  const { fecha, hora_inicio, hora_fin, motivo = null } = req.body || {};
  if (!fecha || !hora_inicio || !hora_fin) {
    throw badRequest('fecha, hora_inicio y hora_fin son obligatorios');
  }
  if (hora_fin <= hora_inicio) throw badRequest('hora_fin debe ser mayor que hora_inicio');
  const ins = await pool.query(
    `INSERT INTO sst.ocupaciones_profesional (profesional_id, fecha, hora_inicio, hora_fin, motivo, creado_por)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [req.params.id, fecha, hora_inicio, hora_fin, motivo, req.user.sub]
  );
  const r = await pool.query(
    `SELECT ${OCUPACION_COLS} FROM sst.ocupaciones_profesional WHERE id=$1`,
    [ins.rows[0].id]
  );
  res.status(201).json({ data: r.rows[0] });
}));

// Eliminar una franja de ocupación (admin).
router.delete('/:id/ocupaciones/:slotId', requireRole('admin'), asyncHandler(async (req, res) => {
  const r = await pool.query(
    `DELETE FROM sst.ocupaciones_profesional WHERE id=$1 AND profesional_id=$2 RETURNING id`,
    [req.params.slotId, req.params.id]
  );
  if (!r.rows[0]) throw notFound('Ocupación no encontrada');
  res.json({ data: { id: r.rows[0].id } });
}));

export default router;
