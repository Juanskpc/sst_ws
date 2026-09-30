import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authRequired, requireRole } from '../../middleware/auth.js';
import { anularCompra, crearCompra, listarCompras, obtenerCompra } from './compras.service.js';

const router = Router();
router.use(authRequired);

/** B5-01 · Compras y gastos (CYG-01..03). Admin y contador operan; el auditor consulta. */
const LEER = requireRole('admin', 'contador', 'auditor');
const OPERAR = requireRole('admin', 'contador');

// ?tercero_id=&desde=&hasta=&tipo=COMPRA|SERVICIO|SERVICIO_PROFESIONAL|GASTO_INTERNO
router.get('/', LEER, asyncHandler(async (req, res) => {
  const data = await listarCompras({
    terceroId: req.query.tercero_id || null, desde: req.query.desde || null, hasta: req.query.hasta || null, tipo: req.query.tipo || null,
  });
  res.json({ data, total: data.length });
}));

router.get('/:id', LEER, asyncHandler(async (req, res) => {
  res.json({ data: await obtenerCompra(req.params.id) });
}));

// Registra y contabiliza (FC, o CG si es gasto interno); a crédito abre la cuenta por pagar.
router.post('/', OPERAR, asyncHandler(async (req, res) => {
  res.status(201).json({ data: await crearCompra(req.body, req.user.sub) });
}));

router.post('/:id/anular', OPERAR, asyncHandler(async (req, res) => {
  res.json({ data: await anularCompra(req.params.id, req.body?.motivo, req.user.sub) });
}));

export default router;
