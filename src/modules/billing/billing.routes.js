import { Router } from 'express';
import { pool } from '../../config/db.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authRequired, requireRole } from '../../middleware/auth.js';
import { badRequest } from '../../utils/httpError.js';
import { generatePrecuentaPdf } from '../../services/pdf.service.js';
import {
  ESTADOS_PRECUENTA, aniosConTrabajo, enviarPrecuenta, generarPrecuentas, obtenerPrecuenta,
  resumenPorMes, urlPrecuenta,
} from './billing.service.js';

const router = Router();
router.use(authRequired);

/**
 * Un filtro de la query solo cuenta si trae valor real. Los clientes que arman
 * la URL con un valor ausente pueden mandar literalmente `?estado=undefined`, y
 * eso no es "sin filtrar": entra al WHERE y, contra una columna uuid, Postgres
 * responde 400 y la pantalla se queda vacía sin poder revisarse.
 */
function filtro(valor) {
  const v = String(valor ?? '').trim();
  return v && v !== 'undefined' && v !== 'null' ? v : null;
}

/**
 * PRE-08 · Histórico de pre-cuentas por profesional, periodo y estado.
 * Contador y auditor consultan; solo admin genera y envía.
 */
router.get('/', asyncHandler(async (req, res) => {
  const clauses = [];
  const params = [];
  const periodo = filtro(req.query.periodo);
  const profesionalId = filtro(req.query.profesional_id);
  const estado = filtro(req.query.estado);
  if (periodo) { params.push(periodo); clauses.push(`periodo = $${params.length}`); }
  if (profesionalId) { params.push(profesionalId); clauses.push(`profesional_id = $${params.length}`); }
  if (estado) { params.push(estado); clauses.push(`estado = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const r = await pool.query(
    `SELECT * FROM sst.vw_precuentas ${where} ORDER BY periodo DESC, profesional_nombre LIMIT 500`,
    params
  );
  res.json({ data: r.rows });
}));

/**
 * PRE-01 · Lo que pinta la vista: una fila por profesional y mes del año pedido,
 * exista o no cuenta de cobro generada. Es lo que permite entrar y ver de un
 * vistazo qué meses quedan por cobrar.
 */
router.get('/resumen', asyncHandler(async (req, res) => {
  const anio = filtro(req.query.anio) ?? String(new Date().getFullYear());
  res.json({ data: await resumenPorMes({ anio }) });
}));

/** Años con trabajo por cobrar, para el selector de la vista. */
router.get('/anios', asyncHandler(async (_req, res) => {
  const anios = await aniosConTrabajo();
  const actual = new Date().getFullYear();
  // El año en curso siempre está, aunque todavía no tenga nada: es el que se
  // muestra al entrar y un selector sin su propio valor se ve roto.
  res.json({ data: anios.includes(actual) ? anios : [actual, ...anios] });
}));

/**
 * Periodos con horas ejecutadas, con cuántas pre-cuentas se generaron ya para
 * cada uno. CFG-05 usa ese contador para avisar de los periodos que pasaron el
 * día de corte y siguen sin cerrarse (el cierre se dispara a mano).
 */
router.get('/periodos', asyncHandler(async (_req, res) => {
  const r = await pool.query(
    `SELECT h.periodo,
            count(*)::int                         AS ordenes,
            sum(h.horas)::numeric                 AS horas,
            count(DISTINCT h.profesional_id)::int AS profesionales,
            (SELECT count(*)::int FROM sst.precuentas p WHERE p.periodo = h.periodo) AS precuentas_generadas
       FROM sst.vw_horas_ejecutadas h
      GROUP BY h.periodo ORDER BY h.periodo DESC LIMIT 24`
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
  res.setHeader('Content-Disposition', `inline; filename="cuenta_cobro_${pc.periodo}.pdf"`);
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
    // Las omitidas importan tanto como las generadas: son las que el usuario
    // esperaba ver y no aparecieron, casi siempre por falta de tarifa.
    message: r.generadas.length
      ? `Se generaron ${r.generadas.length} cuenta(s) de cobro para ${periodo}.`
      : r.omitidas.length
        ? `No se generó ninguna cuenta: ${r.omitidas[0].motivo}`
        : `No hay órdenes con soportes aceptados sin cobrar en ${periodo}.`,
    data: r,
  });
}));

/** PRE-04 · Envía la pre-cuenta al profesional (PDF + enlace de aceptación). */
router.post('/:id/send', requireRole('admin'), asyncHandler(async (req, res) => {
  const r = await enviarPrecuenta(req.params.id);
  res.status(r.enviada ? 200 : 409).json({
    message: r.enviada ? 'Cuenta de cobro enviada al profesional.' : r.motivo,
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
  if (!r.rows[0]) throw badRequest('Cuenta de cobro no encontrada');
  res.json({ data: await obtenerPrecuenta(req.params.id) });
}));

export default router;
