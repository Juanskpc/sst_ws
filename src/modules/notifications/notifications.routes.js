import { Router } from 'express';
import { pool } from '../../config/db.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authRequired } from '../../middleware/auth.js';
import { notFound } from '../../utils/httpError.js';

const router = Router();
router.use(authRequired);

// M11 · Campanita: notificaciones del usuario autenticado.
router.get('/', asyncHandler(async (req, res) => {
  const r = await pool.query(
    `SELECT * FROM sst.notificaciones WHERE usuario_id=$1 ORDER BY creado_en DESC LIMIT 50`,
    [req.user.sub]
  );
  res.json({ data: r.rows });
}));

router.get('/unread-count', asyncHandler(async (req, res) => {
  const r = await pool.query(
    `SELECT count(*)::int AS count FROM sst.notificaciones WHERE usuario_id=$1 AND leido_en IS NULL`,
    [req.user.sub]
  );
  res.json({ data: r.rows[0] });
}));

router.patch('/:id/read', asyncHandler(async (req, res) => {
  const r = await pool.query(
    `UPDATE sst.notificaciones SET leido_en=now() WHERE id=$1 AND usuario_id=$2 RETURNING *`,
    [req.params.id, req.user.sub]
  );
  if (!r.rows[0]) throw notFound('Notificación no encontrada');
  res.json({ data: r.rows[0] });
}));

router.post('/read-all', asyncHandler(async (req, res) => {
  await pool.query(
    `UPDATE sst.notificaciones SET leido_en=now() WHERE usuario_id=$1 AND leido_en IS NULL`,
    [req.user.sub]
  );
  res.json({ message: 'Todas marcadas como leídas' });
}));

export default router;
