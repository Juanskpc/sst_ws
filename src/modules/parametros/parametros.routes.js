import { Router } from 'express';
import { pool } from '../../config/db.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { badRequest, notFound } from '../../utils/httpError.js';
import { authRequired, requireRole } from '../../middleware/auth.js';
import { estadoProveedor, guardarEmisor, obtenerEmisor, validarEmisor } from './emisor.service.js';
import { listarResoluciones, sincronizarResoluciones } from './resoluciones.service.js';
import { revisarVencimientos } from './alertas.service.js';
import {
  actualizarProducto, crearProducto, crearTarifa, listarProductos, listarTarifas,
  setProductoActivo, setTarifaActiva,
} from './productos.service.js';
import {
  actualizarRetencion, crearRetencion, guardarCondicion, guardarUvt, listarCondiciones,
  listarRetenciones, listarUvt, obtenerCondicion, setRetencionActiva,
} from './retenciones.service.js';

const router = Router();
router.use(authRequired);

/**
 * Parametrización de la Fase A (emisor, catálogos DIAN, resoluciones…).
 *
 * De momento solo admin y contador; la matriz de permisos por vista y la pantalla
 * llegan con A0-10. Los catálogos son datos de referencia públicos de la DIAN y los
 * lee también el auditor (para poder abrir las fichas de terceros).
 */
const OPERAR = requireRole('admin', 'contador');
const CONSULTAR = requireRole('admin', 'contador', 'auditor');

// ─── A0-04 · Catálogos DIAN ─────────────────────────────────────────────────────────────────

/** Nombre público del catálogo → tabla. Es una lista blanca: el nombre nunca se interpola sin pasar por aquí. */
const CATALOGOS = {
  paises: 'paises',
  departamentos: 'departamentos',
  municipios: 'municipios',
  'formas-pago': 'formas_pago',
  'medios-pago': 'medios_pago',
  'tipos-documento-identidad': 'tipos_documento_identidad',
  'unidades-medida': 'unidades_medida',
  tributos: 'tributos',
  'responsabilidades-fiscales': 'responsabilidades_fiscales',
};

// ?q= busca por nombre o código; ?activo=false incluye los inactivos; ?limit= acota.
// Los municipios admiten ?departamento_id= (son 1.122: se piden de a departamento).
router.get('/catalogos/:nombre', CONSULTAR, asyncHandler(async (req, res) => {
  // Acepta 'formas-pago' y 'formas_pago': el nombre de la tabla también es válido.
  const tabla = CATALOGOS[req.params.nombre.replace(/_/g, '-')];
  if (!tabla) throw notFound(`No existe el catálogo "${req.params.nombre}". Disponibles: ${Object.keys(CATALOGOS).join(', ')}.`);

  const params = [];
  const filtros = [];
  if (req.query.activo !== 'false') filtros.push('c.activo');
  if (req.query.q && String(req.query.q).trim()) {
    params.push(`%${String(req.query.q).trim()}%`);
    filtros.push(`(c.nombre ILIKE $${params.length} OR c.codigo_dian ILIKE $${params.length})`);
  }
  const esMunicipio = tabla === 'municipios';
  if (esMunicipio && req.query.departamento_id) {
    params.push(req.query.departamento_id);
    filtros.push(`c.departamento_id = $${params.length}`);
  }
  const limit = Math.min(Number.parseInt(req.query.limit, 10) || 2000, 2000);
  params.push(limit);

  const r = await pool.query(
    `SELECT c.id, c.codigo_dian, c.nombre, c.factus_id, c.activo
            ${esMunicipio ? ', c.departamento_id, c.codigo_postal, d.nombre AS departamento_nombre, d.codigo_dian AS departamento_codigo' : ''}
       FROM sst.${tabla} c
       ${esMunicipio ? 'JOIN sst.departamentos d ON d.id = c.departamento_id' : ''}
      ${filtros.length ? `WHERE ${filtros.join(' AND ')}` : ''}
      ORDER BY c.nombre
      LIMIT $${params.length}`,
    params,
  );
  res.json({ data: r.rows, total: r.rowCount });
}));

// ─── A0-09 · Ficha del emisor ───────────────────────────────────────────────────────────────

// Sin ficha guardada devuelve `data: null`: la pantalla la muestra vacía para llenarla.
router.get('/emisor', OPERAR, asyncHandler(async (_req, res) => {
  const emisor = await obtenerEmisor();
  revisarVencimientos().catch(() => {});
  res.json({ data: emisor, proveedor: estadoProveedor(emisor) });
}));

// Sustituye la ficha completa (o la crea). El DV del NIT se calcula, no se recibe.
router.put('/emisor', OPERAR, asyncHandler(async (req, res) => {
  const campos = await validarEmisor(req.body);
  const emisor = await guardarEmisor(campos, req.user.sub);
  await revisarVencimientos();
  res.json({ data: emisor, proveedor: estadoProveedor(emisor) });
}));

// ─── A0-08 · Resoluciones de numeración ─────────────────────────────────────────────────────

router.get('/resoluciones', OPERAR, asyncHandler(async (_req, res) => {
  revisarVencimientos().catch(() => {});
  res.json({ data: await listarResoluciones() });
}));

// "Sincronizar con el proveedor": trae GET /v2/numbering-ranges y hace upsert. Sin
// credenciales de Factus responde 503 "Proveedor de facturación no configurado".
router.post('/resoluciones/sincronizar', OPERAR, asyncHandler(async (_req, res) => {
  const resumen = await sincronizarResoluciones();
  await revisarVencimientos();
  res.json({ data: await listarResoluciones(), resumen });
}));

// Apagar/encender una resolución (p. ej. la vieja cuando llega la nueva).
router.patch('/resoluciones/:id/activa', OPERAR, asyncHandler(async (req, res) => {
  if (typeof req.body?.activa !== 'boolean') throw badRequest('activa (boolean) es obligatorio');
  const r = await pool.query(
    `UPDATE sst.resoluciones_numeracion SET activa = $2 WHERE id = $1 RETURNING id`,
    [req.params.id, req.body.activa],
  );
  if (!r.rows[0]) throw notFound('Resolución no encontrada');
  res.json({ data: await listarResoluciones() });
}));

// ─── A0-06 · Productos ──────────────────────────────────────────────────────────────────────

router.get('/productos', CONSULTAR, asyncHandler(async (req, res) => {
  res.json({ data: await listarProductos({ soloActivos: req.query.activo === 'true' }) });
}));
router.post('/productos', OPERAR, asyncHandler(async (req, res) => {
  res.status(201).json({ data: await crearProducto(req.body) });
}));
router.put('/productos/:id', OPERAR, asyncHandler(async (req, res) => {
  res.json({ data: await actualizarProducto(req.params.id, req.body) });
}));
router.patch('/productos/:id/estado', OPERAR, asyncHandler(async (req, res) => {
  if (typeof req.body?.activo !== 'boolean') throw badRequest('activo (boolean) es obligatorio');
  res.json({ data: await setProductoActivo(req.params.id, req.body.activo) });
}));

// ─── A0-06 · Tarifas de venta ───────────────────────────────────────────────────────────────

// ?pagador_id= acota a un solo pagador (la ficha del tercero solo pide las suyas).
router.get('/tarifas-venta', CONSULTAR, asyncHandler(async (req, res) => {
  res.json({ data: await listarTarifas({ pagadorId: req.query.pagador_id }) });
}));
router.post('/tarifas-venta', OPERAR, asyncHandler(async (req, res) => {
  res.status(201).json({ data: await crearTarifa(req.body) });
}));
router.patch('/tarifas-venta/:id/estado', OPERAR, asyncHandler(async (req, res) => {
  if (typeof req.body?.activo !== 'boolean') throw badRequest('activo (boolean) es obligatorio');
  res.json({ data: await setTarifaActiva(req.params.id, req.body.activo) });
}));

// ─── A0-07 · UVT ────────────────────────────────────────────────────────────────────────────

router.get('/uvt', CONSULTAR, asyncHandler(async (_req, res) => {
  res.json({ data: await listarUvt() });
}));
router.put('/uvt', OPERAR, asyncHandler(async (req, res) => {
  res.json({ data: await guardarUvt(req.body) });
}));

// ─── A0-07 · Retenciones ────────────────────────────────────────────────────────────────────

router.get('/retenciones', CONSULTAR, asyncHandler(async (req, res) => {
  res.json({ data: await listarRetenciones({ soloActivas: req.query.activo === 'true' }) });
}));
router.post('/retenciones', OPERAR, asyncHandler(async (req, res) => {
  res.status(201).json({ data: await crearRetencion(req.body) });
}));
router.put('/retenciones/:id', OPERAR, asyncHandler(async (req, res) => {
  res.json({ data: await actualizarRetencion(req.params.id, req.body) });
}));
router.patch('/retenciones/:id/estado', OPERAR, asyncHandler(async (req, res) => {
  if (typeof req.body?.activa !== 'boolean') throw badRequest('activa (boolean) es obligatorio');
  res.json({ data: await setRetencionActiva(req.params.id, req.body.activa) });
}));

// ─── A0-07 · Condiciones por pagador ────────────────────────────────────────────────────────

router.get('/condiciones-pagador', CONSULTAR, asyncHandler(async (_req, res) => {
  res.json({ data: await listarCondiciones() });
}));
router.get('/condiciones-pagador/:terceroId', CONSULTAR, asyncHandler(async (req, res) => {
  // Sin condición guardada aún, `data: null`: la ficha del tercero la muestra vacía.
  res.json({ data: await obtenerCondicion(req.params.terceroId) });
}));
router.put('/condiciones-pagador/:terceroId', OPERAR, asyncHandler(async (req, res) => {
  res.json({ data: await guardarCondicion(req.params.terceroId, req.body) });
}));

export default router;
