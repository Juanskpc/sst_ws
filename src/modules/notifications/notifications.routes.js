import { Router } from 'express';
import { pool } from '../../config/db.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authRequired } from '../../middleware/auth.js';
import { notFound } from '../../utils/httpError.js';

const router = Router();
router.use(authRequired);

/**
 * NOT-04 · Qué parte de la bandeja se pide.
 *
 * Sin filtro se devuelve la bandeja viva —leídas y sin leer—, NO todo: las
 * eliminadas viven en su propio recorte, igual que la papelera de un correo.
 * Devolverlas mezcladas dejaría el botón de eliminar sin efecto visible, que es
 * lo único que se le pide.
 */
function recorte(estado) {
  switch (estado) {
    case 'no-leidas':  return 'AND eliminado_en IS NULL AND leido_en IS NULL';
    case 'leidas':     return 'AND eliminado_en IS NULL AND leido_en IS NOT NULL';
    case 'eliminadas': return 'AND eliminado_en IS NOT NULL';
    default:           return 'AND eliminado_en IS NULL';
  }
}

// M11 · Campanita: notificaciones del usuario autenticado.
router.get('/', asyncHandler(async (req, res) => {
  const r = await pool.query(
    `SELECT * FROM sst.notificaciones
      WHERE usuario_id=$1 ${recorte(req.query.estado)}
      ORDER BY creado_en DESC LIMIT 50`,
    [req.user.sub]
  );
  // El contador de cada pestaña viaja con la lista: pedirlo aparte sería un
  // viaje más para pintar tres números que ya están en la misma tabla.
  const c = await pool.query(
    `SELECT count(*) FILTER (WHERE eliminado_en IS NULL AND leido_en IS NULL)::int      AS no_leidas,
            count(*) FILTER (WHERE eliminado_en IS NULL AND leido_en IS NOT NULL)::int  AS leidas,
            count(*) FILTER (WHERE eliminado_en IS NOT NULL)::int                       AS eliminadas
       FROM sst.notificaciones WHERE usuario_id=$1`,
    [req.user.sub]
  );
  res.json({ data: r.rows, conteos: c.rows[0] });
}));

router.get('/unread-count', asyncHandler(async (req, res) => {
  // Una eliminada no cuenta aunque nunca se abriera: el badge mide lo que queda
  // por atender, y borrarla es una forma de decir que ya no.
  const r = await pool.query(
    `SELECT count(*)::int AS count FROM sst.notificaciones
      WHERE usuario_id=$1 AND leido_en IS NULL AND eliminado_en IS NULL`,
    [req.user.sub]
  );
  res.json({ data: r.rows[0] });
}));

/**
 * NOT-04 · Eliminar (en blando) una notificación propia.
 *
 * Se marca leída de paso: si estorba lo bastante como para borrarla, no puede
 * seguir sumando al badge. El `usuario_id` en el WHERE es lo que impide borrar
 * la bandeja de otro con solo adivinar un id.
 */
router.delete('/:id', asyncHandler(async (req, res) => {
  const r = await pool.query(
    `UPDATE sst.notificaciones
        SET eliminado_en = now(), leido_en = COALESCE(leido_en, now())
      WHERE id=$1 AND usuario_id=$2 AND eliminado_en IS NULL
      RETURNING *`,
    [req.params.id, req.user.sub]
  );
  if (!r.rows[0]) throw notFound('Notificación no encontrada o ya eliminada');
  res.json({ message: 'Notificación eliminada.', data: r.rows[0] });
}));

/** NOT-04 · Devolver a la bandeja algo borrado por error. */
router.post('/:id/restore', asyncHandler(async (req, res) => {
  const r = await pool.query(
    `UPDATE sst.notificaciones SET eliminado_en = NULL
      WHERE id=$1 AND usuario_id=$2 AND eliminado_en IS NOT NULL
      RETURNING *`,
    [req.params.id, req.user.sub]
  );
  if (!r.rows[0]) throw notFound('Notificación no encontrada');
  res.json({ message: 'Notificación restaurada.', data: r.rows[0] });
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
    `UPDATE sst.notificaciones SET leido_en=now()
      WHERE usuario_id=$1 AND leido_en IS NULL AND eliminado_en IS NULL`,
    [req.user.sub]
  );
  res.json({ message: 'Todas marcadas como leídas' });
}));

export default router;
