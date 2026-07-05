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

export default router;
