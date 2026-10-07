import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { badRequest } from '../../utils/httpError.js';
import { authRequired, requireRole } from '../../middleware/auth.js';
import { storage } from '../../services/storage.service.js';
import { numeroCompleto } from './emision.service.js';
import {
  corregirSoporte, crearDesdePrecuenta, eliminarSoporte, emitirSoporte, listarPorGenerar, listarSoportes, obtenerSoporte, reconciliarSoporte,
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
  res.json({ data: await listarSoportes({ estado: req.query.estado, periodo: req.query.periodo }) });
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
    : `Documento soporte validado: ${numeroCompleto(r.prefijo, r.numero) ?? ''}.`;
  res.json({ message: mensaje, data: r });
}));

router.post('/:id/consultar-estado', OPERAR, asyncHandler(async (req, res) => {
  const r = await reconciliarSoporte(uuid(req.params.id), req.user.sub);
  if (r?.pendiente) return res.status(202).json({ message: 'Sigue en proceso; inténtelo de nuevo en unos minutos.', data: r });
  res.json({ message: r.estado === 'RECHAZADO' ? 'La DIAN rechazó el documento soporte.' : 'Documento soporte validado.', data: r });
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
