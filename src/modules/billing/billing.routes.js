import { Router } from 'express';
import { pool } from '../../config/db.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authRequired, requireRole } from '../../middleware/auth.js';
import { badRequest } from '../../utils/httpError.js';
import { generatePrecuentaPdf } from '../../services/pdf.service.js';
import {
  ESTADOS_PRECUENTA, enviarPrecuenta, generarPrecuentas, obtenerPrecuenta, urlPrecuenta,
} from './billing.service.js';

const router = Router();
router.use(authRequired);

/**
 * PRE-08 · Histórico de pre-cuentas por profesional, periodo y estado.
 * Contador y auditor consultan; solo admin genera y envía.
 */
router.get('/', asyncHandler(async (req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.periodo) { params.push(req.query.periodo); clauses.push(`periodo = $${params.length}`); }
  if (req.query.profesional_id) { params.push(req.query.profesional_id); clauses.push(`profesional_id = $${params.length}`); }
  if (req.query.estado) { params.push(req.query.estado); clauses.push(`estado = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const r = await pool.query(
    `SELECT * FROM sst.vw_precuentas ${where} ORDER BY periodo DESC, profesional_nombre LIMIT 500`,
    params
  );
  res.json({ data: r.rows });
}));

/** Periodos con pre-cuentas + periodos con horas ejecutadas aún sin generar. */
router.get('/periodos', asyncHandler(async (_req, res) => {
  const r = await pool.query(
    `SELECT periodo,
            count(*)::int                       AS ordenes,
            sum(horas)::numeric                 AS horas,
            count(DISTINCT profesional_id)::int AS profesionales
       FROM sst.vw_horas_ejecutadas
      GROUP BY periodo ORDER BY periodo DESC LIMIT 24`
  );
  res.json({ data: r.rows });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  res.json({ data: await obtenerPrecuenta(req.params.id) });
}));

/** PRE-03 · Documento PDF (se abre o descarga desde la vista). */
router.get('/:id/pdf', asyncHandler(async (req, res) => {
  const pc = await obtenerPrecuenta(req.params.id);
  const pdf = await generatePrecuentaPdf(pc);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="precuenta_${pc.periodo}.pdf"`);
  res.send(pdf);
}));

/**
 * PRE-01 · Cierre de mes: calcula las pre-cuentas del periodo.
 *
 * Se dispara a mano (no hay cron en el despliegue actual) y es idempotente, así
 * que repetirla el mismo mes recalcula en vez de duplicar.
 */
router.post('/generate', requireRole('admin'), asyncHandler(async (req, res) => {
  const { periodo, profesional_id: profesionalId } = req.body || {};
  const r = await generarPrecuentas({ periodo, profesionalId: profesionalId || null, userId: req.user.sub });
  res.status(201).json({
    message: r.generadas.length
      ? `Se generaron ${r.generadas.length} pre-cuenta(s) para ${periodo}.`
      : `No hay horas ejecutadas sin facturar en ${periodo}.`,
    data: r,
  });
}));

/** PRE-04 · Envía la pre-cuenta al profesional (PDF + enlace de aceptación). */
router.post('/:id/send', requireRole('admin'), asyncHandler(async (req, res) => {
  const r = await enviarPrecuenta(req.params.id);
  res.status(r.enviada ? 200 : 409).json({
    message: r.enviada ? 'Pre-cuenta enviada al profesional.' : r.motivo,
    data: r.precuenta ? { ...r.precuenta, url: urlPrecuenta(r.precuenta.token) } : null,
  });
}));

/**
 * Corrección manual del estado (admin). Existe para PRE-07: tras un rechazo,
 * alguien revisa y decide; y para reabrir una pre-cuenta enviada por error.
 */
router.patch('/:id/estado', requireRole('admin'), asyncHandler(async (req, res) => {
  const { estado, observaciones } = req.body || {};
  if (!ESTADOS_PRECUENTA.includes(estado)) {
    throw badRequest(`Estado inválido. Use uno de: ${ESTADOS_PRECUENTA.join(', ')}`);
  }
  const r = await pool.query(
    `UPDATE sst.precuentas SET estado=$2, observaciones=COALESCE($3, observaciones), actualizado_en=now()
      WHERE id=$1 RETURNING id`,
    [req.params.id, estado, observaciones ?? null]
  );
  if (!r.rows[0]) throw badRequest('Pre-cuenta no encontrada');
  res.json({ data: await obtenerPrecuenta(req.params.id) });
}));

export default router;
