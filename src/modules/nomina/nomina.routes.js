import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { badRequest } from '../../utils/httpError.js';
import { authRequired, requireRole } from '../../middleware/auth.js';
import { catalogosNomina } from './catalogos.js';
import { actualizarEmpleado, cambiarEstadoEmpleado, crearEmpleado, listarEmpleados, obtenerEmpleado } from './empleados.service.js';
import {
  actualizarLiquidacion, anularLiquidacion, crearLiquidacion, eliminarLiquidacion, emitirLiquidacion,
  listarLiquidaciones, obtenerLiquidacion, previaLiquidacion,
} from './liquidaciones.service.js';

/**
 * A5-01 · Nómina electrónica (pantalla «Nómina» de Finanzas). Mismo reparto que
 * Facturación: admin, contador y auditor leen; admin y contador operan.
 */
const router = Router();
router.use(authRequired);

const LEER = requireRole('admin', 'contador', 'auditor');
const OPERAR = requireRole('admin', 'contador');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v, nombre = 'id') => {
  if (!UUID.test(String(v ?? ''))) throw badRequest(`"${nombre}" no es un identificador válido.`);
  return String(v);
};

// Tablas para los selectores (tipos de contrato, de hora extra, de licencia…) y las cifras del año.
router.get('/catalogos', LEER, (_req, res) => res.json({ data: catalogosNomina() }));

// ─── Empleados ──────────────────────────────────────────────────────────────
router.get('/empleados', LEER, asyncHandler(async (_req, res) => {
  res.json({ data: await listarEmpleados() });
}));
router.get('/empleados/:id', LEER, asyncHandler(async (req, res) => {
  res.json({ data: await obtenerEmpleado(uuid(req.params.id)) });
}));
router.post('/empleados', OPERAR, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const data = await crearEmpleado({ ...b, tercero_id: uuid(b.tercero_id, 'tercero_id') }, req.user.sub);
  res.status(201).json({ message: 'Empleado creado.', data });
}));
router.put('/empleados/:id', OPERAR, asyncHandler(async (req, res) => {
  res.json({ message: 'Empleado actualizado.', data: await actualizarEmpleado(uuid(req.params.id), req.body || {}, req.user.sub) });
}));
router.patch('/empleados/:id/estado', OPERAR, asyncHandler(async (req, res) => {
  res.json({ message: 'Estado actualizado.', data: await cambiarEstadoEmpleado(uuid(req.params.id), req.body?.activo, req.user.sub) });
}));

// ─── Liquidaciones ──────────────────────────────────────────────────────────
// Liquida sin guardar: lo que la pantalla muestra mientras se escriben las novedades.
router.post('/liquidaciones/previa', OPERAR, asyncHandler(async (req, res) => {
  const b = req.body || {};
  res.json({ data: await previaLiquidacion({ ...b, empleado_id: uuid(b.empleado_id, 'empleado_id') }) });
}));
router.get('/liquidaciones', LEER, asyncHandler(async (req, res) => {
  res.json({ data: await listarLiquidaciones({ anio: req.query.anio, mes: req.query.mes }) });
}));
router.get('/liquidaciones/:id', LEER, asyncHandler(async (req, res) => {
  res.json({ data: await obtenerLiquidacion(uuid(req.params.id)) });
}));
router.post('/liquidaciones', OPERAR, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const data = await crearLiquidacion({ ...b, empleado_id: uuid(b.empleado_id, 'empleado_id') }, req.user.sub);
  res.status(201).json({ message: 'Nómina guardada como borrador.', data });
}));
router.put('/liquidaciones/:id', OPERAR, asyncHandler(async (req, res) => {
  res.json({ message: 'Nómina actualizada.', data: await actualizarLiquidacion(uuid(req.params.id), req.body || {}, req.user.sub) });
}));
router.delete('/liquidaciones/:id', OPERAR, asyncHandler(async (req, res) => {
  await eliminarLiquidacion(uuid(req.params.id));
  res.json({ message: 'Nómina eliminada.' });
}));

/**
 * Emite ante la DIAN. 200 si quedó VALIDADO o RECHAZADO (`data.estado` dice cuál); 202 si
 * el proveedor no respondió del todo: queda ENVIANDO y se retoma volviendo a emitir.
 */
router.post('/liquidaciones/:id/emitir', OPERAR, asyncHandler(async (req, res) => {
  const data = await emitirLiquidacion(uuid(req.params.id), req.user.sub);
  if (data.pendiente) return res.status(202).json({ message: 'La DIAN todavía no responde. Pulse «Emitir» de nuevo en unos minutos: se retoma el mismo envío, no se duplica.', data });
  res.json({
    message: data.estado === 'VALIDADO' ? `Nómina validada: ${data.numero}.` : 'La DIAN rechazó la nómina. Revise el motivo, corrija y vuelva a emitir.',
    data,
  });
}));

// Anula una nómina validada (nota de ajuste de eliminación). Para corregirla: anular y volver a liquidar.
router.post('/liquidaciones/:id/anular', OPERAR, asyncHandler(async (req, res) => {
  const data = await anularLiquidacion(uuid(req.params.id), req.user.sub);
  res.json({ message: `Nómina anulada con la nota de ajuste ${data.nota_numero}.`, data });
}));

export default router;
