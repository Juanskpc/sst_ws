import { Router } from 'express';
import { pool } from '../../config/db.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authRequired, requireRole } from '../../middleware/auth.js';
import { badRequest } from '../../utils/httpError.js';

const router = Router();
router.use(authRequired);

// Catálogo de ARLs
router.get('/arls', asyncHandler(async (_req, res) => {
  const r = await pool.query(`SELECT * FROM sst.arls ORDER BY nombre`);
  res.json({ data: r.rows });
}));

// Plantillas de formatos precargadas (M4)
router.get('/templates', asyncHandler(async (_req, res) => {
  const r = await pool.query(
    `SELECT t.*, a.nombre AS arl_nombre FROM sst.plantillas t
     LEFT JOIN sst.arls a ON a.id = t.arl_id WHERE t.activo ORDER BY t.nombre`
  );
  res.json({ data: r.rows });
}));

// Configuración (tabla configuracion)
router.get('/settings', asyncHandler(async (_req, res) => {
  const r = await pool.query(`SELECT clave, valor, descripcion FROM sst.configuracion ORDER BY clave`);
  const map = Object.fromEntries(r.rows.map((row) => [row.clave, row.valor]));
  res.json({ data: map, raw: r.rows });
}));

// Config · Umbral de confianza de la IA (default 70). Admin.
router.put('/settings/confidence-threshold', requireRole('admin'), asyncHandler(async (req, res) => {
  const { value } = req.body || {};
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw badRequest('El umbral debe estar entre 0 y 100');
  const r = await pool.query(
    `INSERT INTO sst.configuracion (clave, valor, descripcion)
     VALUES ('confidence_threshold', $1::jsonb, 'Umbral mínimo de confianza de la IA (%).')
     ON CONFLICT (clave) DO UPDATE SET valor=EXCLUDED.valor, actualizado_en=now()
     RETURNING clave, valor`,
    [JSON.stringify(n)]
  );
  res.json({ data: r.rows[0] });
}));

export default router;
