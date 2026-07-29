import { Router } from 'express';
import { pool } from '../../config/db.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authRequired, requireRole } from '../../middleware/auth.js';
import { enviarEncuesta, obtenerPreguntas, urlEncuesta } from './surveys.service.js';

const router = Router();
router.use(authRequired);

/**
 * Filtros comunes del módulo (ENC-05/07): ARL, profesional y rango de fechas
 * sobre el mes de la encuesta. Devuelve el WHERE y sus parámetros para que el
 * listado y las estadísticas apliquen exactamente el mismo recorte.
 */
function construirFiltros(q) {
  const clauses = [];
  const params = [];
  if (q.arl_id) { params.push(q.arl_id); clauses.push(`arl_id = $${params.length}`); }
  if (q.profesional_id) { params.push(q.profesional_id); clauses.push(`profesional_id = $${params.length}`); }
  if (q.desde) { params.push(q.desde); clauses.push(`mes >= date_trunc('month', $${params.length}::date)`); }
  if (q.hasta) { params.push(q.hasta); clauses.push(`mes <= date_trunc('month', $${params.length}::date)`); }
  if (q.respondida === 'true') clauses.push(`respondido_en IS NOT NULL`);
  if (q.respondida === 'false') clauses.push(`respondido_en IS NULL`);
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

// ENC-05/07 · Listado de encuestas (base del dashboard y de la exportación).
router.get('/', asyncHandler(async (req, res) => {
  const { where, params } = construirFiltros(req.query);
  const r = await pool.query(
    `SELECT * FROM sst.vw_encuestas ${where}
      ORDER BY COALESCE(respondido_en, enviado_en) DESC NULLS LAST LIMIT 500`,
    params
  );
  res.json({ data: r.rows });
}));

/**
 * ENC-05 · Dashboard de satisfacción: totales, y promedios por profesional, por
 * ARL y por mes.
 *
 * Los promedios se calculan solo sobre encuestas RESPONDIDAS (las enviadas sin
 * responder no son un 0, son un dato ausente), mientras que la tasa de respuesta
 * sí se mide contra las enviadas.
 */
router.get('/stats', asyncHandler(async (req, res) => {
  const { where, params } = construirFiltros(req.query);

  const [totales, porProfesional, porArl, porMes, distribucion] = await Promise.all([
    pool.query(
      `SELECT count(*)::int                                   AS enviadas,
              count(*) FILTER (WHERE respondida)::int         AS respondidas,
              round(avg(satisfaccion)  FILTER (WHERE respondida)::numeric, 2) AS promedio_satisfaccion,
              round(avg(recomendacion) FILTER (WHERE respondida)::numeric, 2) AS promedio_recomendacion
         FROM sst.vw_encuestas ${where}`, params),
    pool.query(
      `SELECT profesional_id, COALESCE(profesional_nombre, 'Sin profesional') AS profesional_nombre,
              count(*)::int AS enviadas, count(*) FILTER (WHERE respondida)::int AS respondidas,
              round(avg(satisfaccion)  FILTER (WHERE respondida)::numeric, 2) AS promedio_satisfaccion,
              round(avg(recomendacion) FILTER (WHERE respondida)::numeric, 2) AS promedio_recomendacion
         FROM sst.vw_encuestas ${where}
        GROUP BY 1, 2 ORDER BY promedio_satisfaccion DESC NULLS LAST`, params),
    pool.query(
      `SELECT arl_id, COALESCE(arl_nombre, 'Sin ARL') AS arl_nombre,
              count(*)::int AS enviadas, count(*) FILTER (WHERE respondida)::int AS respondidas,
              round(avg(satisfaccion)  FILTER (WHERE respondida)::numeric, 2) AS promedio_satisfaccion
         FROM sst.vw_encuestas ${where}
        GROUP BY 1, 2 ORDER BY arl_nombre`, params),
    pool.query(
      `SELECT to_char(mes, 'YYYY-MM') AS mes,
              count(*)::int AS enviadas, count(*) FILTER (WHERE respondida)::int AS respondidas,
              round(avg(satisfaccion)  FILTER (WHERE respondida)::numeric, 2) AS promedio_satisfaccion
         FROM sst.vw_encuestas ${where}
        GROUP BY 1 ORDER BY 1`, params),
    // Cuántos 1, 2, 3… para poder pintar la distribución de notas.
    pool.query(
      `SELECT satisfaccion AS nota, count(*)::int AS total
         FROM sst.vw_encuestas ${where}${where ? ' AND' : ' WHERE'} respondida
        GROUP BY 1 ORDER BY 1`, params),
  ]);

  res.json({
    data: {
      totales: totales.rows[0],
      por_profesional: porProfesional.rows,
      por_arl: porArl.rows,
      por_mes: porMes.rows,
      distribucion: distribucion.rows,
    },
  });
}));

// ENC-03 · Enunciados vigentes (la vista pública los recibe con la encuesta).
router.get('/preguntas', asyncHandler(async (_req, res) => {
  res.json({ data: await obtenerPreguntas() });
}));

/**
 * ENC-01 · Reenvío manual del correo. Existe porque el envío automático al
 * cerrar la OS puede fallar (SMTP caído, contacto sin correo en ese momento) y
 * el administrador necesita reintentarlo sin tocar la base.
 */
router.post('/:ordenId/send', requireRole('admin'), asyncHandler(async (req, res) => {
  const r = await enviarEncuesta(req.params.ordenId, { reenviar: true });
  res.status(r.enviada ? 200 : 409).json({
    message: r.enviada ? 'Encuesta enviada al contacto de la empresa.' : r.motivo,
    data: r.encuesta ? { ...r.encuesta, url: urlEncuesta(r.encuesta.token) } : null,
  });
}));

export default router;
