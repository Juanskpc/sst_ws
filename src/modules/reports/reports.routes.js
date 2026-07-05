import { Router } from 'express';
import { pool } from '../../config/db.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authRequired } from '../../middleware/auth.js';
import { notFound } from '../../utils/httpError.js';
import { getOrderExpanded } from '../orders/orders.service.js';
import { executiveSummary, interpretSearch } from '../../services/gemini.service.js';

const router = Router();
router.use(authRequired);

// RPT-01/02 · KPIs del dashboard + distribución por ARL.
router.get('/dashboard', asyncHandler(async (_req, res) => {
  const [kpis, byArl, monthly] = await Promise.all([
    pool.query(`SELECT * FROM sst.vw_kpis_dashboard`),
    pool.query(`SELECT * FROM sst.vw_ordenes_por_arl`),
    pool.query(`SELECT * FROM sst.vw_estados_mensual WHERE mes = date_trunc('month', now())`),
  ]);
  res.json({
    data: {
      kpis: kpis.rows[0],
      por_arl: byArl.rows,
      estados_mes: monthly.rows,
    },
  });
}));

// Informes · Resumen ejecutivo IA (Gemini/mock) de 3 párrafos por OS.
router.post('/summary/:orderId', asyncHandler(async (req, res) => {
  const order = await getOrderExpanded(req.params.orderId);
  if (!order) throw notFound('OS no encontrada');
  const summary = await executiveSummary(order);
  res.json({ data: { order_id: order.id, summary } });
}));

// Informes · Buscador en lenguaje natural → filtros → resultados.
router.post('/search', asyncHandler(async (req, res) => {
  const { query } = req.body || {};
  const filters = await interpretSearch(query || '');

  const clauses = [];
  const params = [];
  if (filters.arl) { params.push(filters.arl); clauses.push(`arl_nombre = $${params.length}`); }
  if (filters.status) { params.push(filters.status); clauses.push(`estado = $${params.length}::sst.estado_orden`); }
  if (filters.minHoras) { params.push(filters.minHoras); clauses.push(`horas_asignadas >= $${params.length}`); }
  if (filters.bajaConfianza) {
    clauses.push(`(metadatos_extraccion->>'overall_confidence')::numeric <
      (SELECT valor::numeric FROM sst.configuracion WHERE clave='confidence_threshold')`);
  }
  if (filters.texto) {
    params.push(`%${filters.texto}%`);
    clauses.push(`(empresa_nombre ILIKE $${params.length} OR descripcion ILIKE $${params.length})`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const r = await pool.query(
    `SELECT * FROM sst.vw_ordenes_expandidas ${where} ORDER BY fecha_carga DESC LIMIT 100`, params
  );
  res.json({ data: { filters, results: r.rows } });
}));

export default router;
