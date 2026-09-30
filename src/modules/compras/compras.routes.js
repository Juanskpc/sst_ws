import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authRequired, requireRole } from '../../middleware/auth.js';
import { anularCompra, crearCompra, listarCompras, obtenerCompra } from './compras.service.js';
import { importarCompras, plantillaExcel } from './importar.service.js';
import { uploadImport } from '../../middleware/upload.js';
import { badRequest } from '../../utils/httpError.js';

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

// Carga masiva (antes de /:id, que si no la capturaría). Plantilla con encabezados y un ejemplo.
router.get('/plantilla.xlsx', LEER, asyncHandler(async (_req, res) => {
  const buf = await plantillaExcel();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="plantilla-compras.xlsx"');
  res.send(Buffer.from(buf));
}));

// ?simular=true revisa sin guardar. Sin simular, guarda solo si ninguna compra falla (todo o nada).
router.post('/importar', OPERAR, uploadImport.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('Adjunte el Excel de compras.');
  res.json({ data: await importarCompras(req.file.buffer, { usuarioId: req.user.sub, simular: req.query.simular === 'true' }) });
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
