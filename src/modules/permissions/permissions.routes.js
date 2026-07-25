import { Router } from 'express';
import { pool } from '../../config/db.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authRequired, requireRole } from '../../middleware/auth.js';
import { badRequest } from '../../utils/httpError.js';
import { VISTAS_SISTEMA } from '../auth/auth.service.js';

const ROLES = ['admin', 'profesional', 'contador', 'auditor'];

const router = Router();
router.use(authRequired, requireRole('admin'));

// Configuración → Roles y permisos: matriz completa (rol × vista).
router.get('/', asyncHandler(async (_req, res) => {
  const r = await pool.query(`SELECT rol, vista, permitido FROM sst.permisos_rol ORDER BY rol, vista`);
  res.json({ data: r.rows, roles: ROLES, vistas: VISTAS_SISTEMA });
}));

// Alterna el acceso de un rol a una vista puntual (upsert).
router.put('/:rol/:vista', asyncHandler(async (req, res) => {
  const { rol, vista } = req.params;
  const { permitido } = req.body || {};
  if (!ROLES.includes(rol)) throw badRequest('Rol inválido');
  if (!VISTAS_SISTEMA.includes(vista)) throw badRequest('Vista inválida');
  if (typeof permitido !== 'boolean') throw badRequest('permitido (boolean) es obligatorio');
  // Salvaguarda anti-bloqueo: si el rol admin pierde Configuración, ningún
  // administrador podría volver a esta pantalla para revertirlo y el sistema
  // quedaría solo en manos del Administrador Maestro.
  if (rol === 'admin' && vista === 'configuracion' && !permitido) {
    throw badRequest('El rol Administrador no puede perder el acceso a Configuración.');
  }
  const r = await pool.query(
    `INSERT INTO sst.permisos_rol (rol, vista, permitido)
     VALUES ($1,$2,$3)
     ON CONFLICT (rol, vista) DO UPDATE SET permitido = EXCLUDED.permitido, actualizado_en = now()
     RETURNING rol, vista, permitido`,
    [rol, vista, permitido]
  );
  res.json({ data: r.rows[0] });
}));

export default router;
