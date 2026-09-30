import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { badRequest } from '../../utils/httpError.js';
import { authRequired, requireRole } from '../../middleware/auth.js';
import { uploadImport } from '../../middleware/upload.js';
import {
  actualizarCuenta, cambiarActiva, crearCuenta, importarCuentas, leerExcelCuentas, listarCuentas, obtenerCuenta,
} from './cuentas.service.js';

const router = Router();
router.use(authRequired);

/**
 * Fase B · Contabilidad. Mismo reparto que el resto de Finanzas: admin y contador
 * operan; el auditor consulta.
 */
const LEER = requireRole('admin', 'contador', 'auditor');
const OPERAR = requireRole('admin', 'contador');

// ─── B0-01 · Plan de cuentas (CNT-01) ────────────────────────────────────────

// ?q= código (prefijo) o nombre; ?activas=true; ?movimiento=true (solo las que reciben asientos).
router.get('/cuentas', LEER, asyncHandler(async (req, res) => {
  const data = await listarCuentas({
    q: req.query.q,
    soloActivas: req.query.activas === 'true',
    soloMovimiento: req.query.movimiento === 'true',
  });
  res.json({ data, total: data.length });
}));

router.get('/cuentas/:id', LEER, asyncHandler(async (req, res) => {
  res.json({ data: await obtenerCuenta(req.params.id) });
}));

router.post('/cuentas', OPERAR, asyncHandler(async (req, res) => {
  res.status(201).json({ data: await crearCuenta(req.body, req.user.sub) });
}));

router.put('/cuentas/:id', OPERAR, asyncHandler(async (req, res) => {
  res.json({ data: await actualizarCuenta(req.params.id, req.body, req.user.sub) });
}));

// Inactivar/reactivar. No hay DELETE: una cuenta no se borra (CNT-01).
router.patch('/cuentas/:id/activa', OPERAR, asyncHandler(async (req, res) => {
  if (typeof req.body?.activa !== 'boolean') throw badRequest('Indique "activa": true o false.');
  res.json({ data: await cambiarActiva(req.params.id, req.body.activa, req.user.sub) });
}));

// Importa el PUC desde Excel. ?simular=true corre todo y deshace: es la vista previa.
router.post('/cuentas/importar', OPERAR, uploadImport.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('Adjunte el Excel del plan de cuentas.');
  const lista = leerExcelCuentas(req.file.buffer);
  const resumen = await importarCuentas(lista, { usuarioId: req.user.sub, simular: req.query.simular === 'true' });
  res.json({ data: { ...resumen, leidas: lista.length } });
}));

export default router;
