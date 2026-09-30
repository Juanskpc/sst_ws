import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { badRequest } from '../../utils/httpError.js';
import { authRequired, requireRole } from '../../middleware/auth.js';
import { uploadImport } from '../../middleware/upload.js';
import {
  actualizarCuenta, cambiarActiva, crearCuenta, importarCuentas, leerExcelCuentas, listarCuentas, obtenerCuenta,
} from './cuentas.service.js';
import {
  actualizarBorrador, anularComprobante, cerrarPeriodo, contabilizarComprobante, crearComprobante, eliminarBorrador,
  listarComprobantes, listarPeriodos, listarTiposComprobante, obtenerComprobante, reabrirPeriodo,
} from './comprobantes.service.js';

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

// ─── B1-01 · Comprobantes (CNT-02, CNT-03) ───────────────────────────────────

router.get('/tipos-comprobante', LEER, asyncHandler(async (_req, res) => {
  res.json({ data: await listarTiposComprobante() });
}));

// ?tipo=NI&estado=BORRADOR,CONTABILIZADO&desde=&hasta=&cuenta_id=&tercero_id=&q=&limit=
router.get('/comprobantes', LEER, asyncHandler(async (req, res) => {
  const data = await listarComprobantes({
    tipo: req.query.tipo, estado: req.query.estado, desde: req.query.desde, hasta: req.query.hasta,
    cuentaId: req.query.cuenta_id, terceroId: req.query.tercero_id, q: req.query.q, limit: req.query.limit,
  });
  res.json({ data, total: data.length });
}));

router.get('/comprobantes/:id', LEER, asyncHandler(async (req, res) => {
  res.json({ data: await obtenerComprobante(req.params.id) });
}));

// A mano solo se crean los tipos manuales (notas internas); el resto nace de su documento.
router.post('/comprobantes', OPERAR, asyncHandler(async (req, res) => {
  res.status(201).json({ data: await crearComprobante(req.body, req.user.sub, { soloManual: true }) });
}));

router.put('/comprobantes/:id', OPERAR, asyncHandler(async (req, res) => {
  res.json({ data: await actualizarBorrador(req.params.id, req.body, req.user.sub) });
}));

router.post('/comprobantes/:id/contabilizar', OPERAR, asyncHandler(async (req, res) => {
  res.json({ data: await contabilizarComprobante(req.params.id, req.user.sub) });
}));

router.post('/comprobantes/:id/anular', OPERAR, asyncHandler(async (req, res) => {
  res.json({ data: await anularComprobante(req.params.id, req.body?.motivo, req.user.sub) });
}));

router.delete('/comprobantes/:id', OPERAR, asyncHandler(async (req, res) => {
  await eliminarBorrador(req.params.id);
  res.status(204).end();
}));

// ─── B1-01 · Periodos contables ──────────────────────────────────────────────

router.get('/periodos', LEER, asyncHandler(async (req, res) => {
  const anio = Number(req.query.anio) || new Date().getFullYear();
  res.json({ data: { anio, meses: await listarPeriodos(anio) } });
}));

router.post('/periodos/:anio/:mes/cerrar', OPERAR, asyncHandler(async (req, res) => {
  res.json({ data: await cerrarPeriodo(req.params.anio, req.params.mes, req.user.sub) });
}));

// Reabrir un mes cerrado es excepcional: solo el administrador, y con motivo.
router.post('/periodos/:anio/:mes/reabrir', requireRole('admin'), asyncHandler(async (req, res) => {
  res.json({ data: await reabrirPeriodo(req.params.anio, req.params.mes, req.body?.motivo, req.user.sub) });
}));

export default router;
