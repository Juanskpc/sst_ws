import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { badRequest } from '../../utils/httpError.js';
import { authRequired, requireRole } from '../../middleware/auth.js';
import { storage } from '../../services/storage.service.js';
import { uploadImport } from '../../middleware/upload.js';
import { importarSoportes, plantillaSoportes } from './soporte-importar.service.js';
import { numeroCompleto } from './emision.service.js';
import {
  CAUSALES_NOTA_AJUSTE, corregirSoporte, crearDesdePrecuenta, crearNotaAjuste, crearSoporteManual, eliminarSoporte, emitirSoporte, listarPorGenerar,
  listarSoportes, obtenerSoporte, reconciliarSoporte,
} from './soporte.service.js';

/**
 * A4-01 · Documentos soporte (pantalla «Documentos soporte» de Finanzas).
 * Mismo reparto que Facturación: admin, contador y auditor leen; admin y
 * contador operan.
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

router.get('/', LEER, asyncHandler(async (req, res) => {
  res.json({ data: await listarSoportes({ estado: req.query.estado, periodo: req.query.periodo, tipo: req.query.tipo || undefined }) });
}));

// A4-03 · Motivos DIAN de la nota de ajuste (para el selector de la pantalla).
router.get('/notas/causales', LEER, (_req, res) => {
  res.json({ data: Object.entries(CAUSALES_NOTA_AJUSTE).map(([codigo, nombre]) => ({ codigo, nombre })) });
});

// A4-02 · Documento soporte manual (sin cuenta de cobro): { tercero_id, observaciones?, lineas: [{ descripcion, cantidad, valor_unitario, cuenta_id }] }.
router.post('/manual', OPERAR, asyncHandler(async (req, res) => {
  const data = await crearSoporteManual(req.body || {}, req.user.sub);
  res.status(201).json({ message: 'Documento soporte creado en borrador.', data });
}));

// A4-02 · Carga masiva: plantilla y revisión/importación (crea borradores; todo o nada).
router.get('/plantilla.xlsx', LEER, asyncHandler(async (_req, res) => {
  const buf = await plantillaSoportes();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="plantilla-documentos-soporte.xlsx"');
  res.send(Buffer.from(buf));
}));
router.post('/importar', OPERAR, uploadImport.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('Adjunte el Excel de documentos soporte.');
  res.json({ data: await importarSoportes(req.file.buffer, { usuarioId: req.user.sub, simular: req.query.simular === 'true' }) });
}));

// Cuentas de cobro aceptadas que todavía no tienen documento soporte.
router.get('/por-generar', LEER, asyncHandler(async (_req, res) => {
  res.json({ data: await listarPorGenerar() });
}));

// Crea el borrador desde una cuenta de cobro aceptada. Cuerpo: { precuenta_id }.
router.post('/', OPERAR, asyncHandler(async (req, res) => {
  const data = await crearDesdePrecuenta(uuid(req.body?.precuenta_id, 'precuenta_id'), req.user.sub);
  res.status(201).json({ message: 'Documento soporte creado en borrador.', data });
}));

router.get('/:id', LEER, asyncHandler(async (req, res) => {
  res.json({ data: await obtenerSoporte(uuid(req.params.id)) });
}));

router.delete('/:id', OPERAR, asyncHandler(async (req, res) => {
  res.json({ message: 'Borrador eliminado.', data: await eliminarSoporte(uuid(req.params.id)) });
}));

router.post('/:id/emitir', OPERAR, asyncHandler(async (req, res) => {
  const r = await emitirSoporte(uuid(req.params.id), req.user.sub);
  if (r?.pendiente) return res.status(202).json({ message: r.aviso, data: r });
  const mensaje = r.estado === 'RECHAZADO'
    ? 'La DIAN rechazó el documento soporte. Revise el motivo, corrija y vuelva a emitir.'
    : `${r.tipo === 'NOTA_AJUSTE_DS' ? 'Nota de ajuste' : 'Documento soporte'} validado: ${numeroCompleto(r.prefijo, r.numero) ?? ''}.`;
  res.json({ message: mensaje, data: r });
}));

router.post('/:id/consultar-estado', OPERAR, asyncHandler(async (req, res) => {
  const r = await reconciliarSoporte(uuid(req.params.id), req.user.sub);
  if (r?.pendiente) return res.status(202).json({ message: 'Sigue en proceso; inténtelo de nuevo en unos minutos.', data: r });
  res.json({ message: r.estado === 'RECHAZADO' ? 'La DIAN rechazó el documento soporte.' : 'Documento soporte validado.', data: r });
}));

/**
 * A4-03 · Nota de ajuste (en BORRADOR) sobre un documento soporte VALIDADO. Cuerpo:
 * { causal: '1'..'5', lineas?: [{ item_id, cantidad }], observaciones? }. Sin
 * `lineas`, o con la causal 2 (anulación), ajusta el documento completo.
 */
router.post('/:id/nota-ajuste', OPERAR, asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (b.lineas != null && !Array.isArray(b.lineas)) throw badRequest('"lineas" debe ser una lista.');
  const lineas = (b.lineas ?? []).map((l) => ({ item_id: uuid(l?.item_id, 'item_id'), cantidad: Number(l?.cantidad) }));
  const data = await crearNotaAjuste(uuid(req.params.id), { causal: b.causal, lineas, observaciones: b.observaciones ?? null }, req.user.sub);
  res.status(201).json({ message: 'Nota de ajuste creada en borrador.', data });
}));

router.post('/:id/corregir', OPERAR, asyncHandler(async (req, res) => {
  res.json({ message: 'El documento soporte vuelve a borrador.', data: await corregirSoporte(uuid(req.params.id), req.user.sub) });
}));

// PDF o XML tal como los devolvió el proveedor al validar (exige sesión: datos tributarios).
router.get('/:id/archivo/:tipo', LEER, asyncHandler(async (req, res) => {
  const tipo = String(req.params.tipo).toLowerCase();
  if (!['pdf', 'xml'].includes(tipo)) throw badRequest('El archivo es "pdf" o "xml".');
  const doc = await obtenerSoporte(uuid(req.params.id));
  const ruta = tipo === 'pdf' ? doc.pdf_path : doc.xml_path;
  if (!ruta) throw badRequest(`Este documento soporte todavía no tiene ${tipo.toUpperCase()}: solo lo tienen los validados.`);
  res.setHeader('Content-Type', tipo === 'pdf' ? 'application/pdf' : 'application/xml');
  res.setHeader('Content-Disposition', `inline; filename="${numeroCompleto(doc.prefijo, doc.numero) ?? doc.reference_code}.${tipo}"`);
  res.send(await storage.get(ruta));
}));

export default router;
