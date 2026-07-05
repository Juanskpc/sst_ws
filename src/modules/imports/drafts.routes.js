import { Router } from 'express';
import { pool, withTransaction } from '../../config/db.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authRequired, requireRole } from '../../middleware/auth.js';
import { badRequest, notFound, conflict } from '../../utils/httpError.js';
import { computeOverallConfidence } from '../../services/extraction.service.js';
import { CANONICAL_FIELDS } from '../../services/gemini.service.js';

const router = Router();
router.use(authRequired);

// Bandeja de validación IA (M3). Filtrable por estado del borrador.
router.get('/', asyncHandler(async (req, res) => {
  const estado = req.query.estado || req.query.status || 'PENDIENTE_VALIDACION';
  const r = await pool.query(
    `SELECT d.*, a.nombre AS arl_nombre, b.nombre_archivo, b.tipo_mime
     FROM sst.borradores_extraccion d
     LEFT JOIN sst.arls a ON a.id = d.arl_id
     LEFT JOIN sst.lotes_importacion b ON b.id = d.lote_importacion_id
     WHERE ($1 = 'ALL' OR d.estado = $1::sst.estado_extraccion)
     ORDER BY d.creado_en DESC`,
    [estado]
  );
  res.json({ data: r.rows });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const r = await pool.query(
    `SELECT d.*, a.nombre AS arl_nombre, b.nombre_archivo, b.tipo_mime
     FROM sst.borradores_extraccion d
     LEFT JOIN sst.arls a ON a.id = d.arl_id
     LEFT JOIN sst.lotes_importacion b ON b.id = d.lote_importacion_id
     WHERE d.id=$1`,
    [req.params.id]
  );
  if (!r.rows[0]) throw notFound('Borrador no encontrado');
  res.json({ data: r.rows[0] });
}));

// IMP-03/04 · Guardar correcciones manuales del split-view (sin validar aún).
router.put('/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const { fields } = req.body || {}; // { codigo_cronograma: {value, confidence}, ... }
  if (!fields || typeof fields !== 'object') throw badRequest('Envía "fields" con los campos editados');
  const cur = await pool.query(`SELECT metadatos_extraccion FROM sst.borradores_extraccion WHERE id=$1`, [req.params.id]);
  if (!cur.rows[0]) throw notFound('Borrador no encontrado');

  const merged = { ...cur.rows[0].metadatos_extraccion };
  for (const f of CANONICAL_FIELDS) {
    if (fields[f]) {
      merged[f] = {
        value: fields[f].value ?? merged[f]?.value ?? '',
        // Corregido a mano ⇒ confianza 100 salvo que se envíe otra.
        confidence: fields[f].confidence ?? 100,
      };
    }
  }
  merged.overall_confidence = computeOverallConfidence(merged);
  const r = await pool.query(
    `UPDATE sst.borradores_extraccion SET metadatos_extraccion=$2, confianza_general=$3 WHERE id=$1 RETURNING *`,
    [req.params.id, merged, merged.overall_confidence]
  );
  res.json({ data: r.rows[0] });
}));

// M3 · "Validar y Guardar" → materializa la OS con estado SIN PROGRAMAR (EST-01)
// y escribe la primera entrada en historial_estados_orden.
router.post('/:id/validate', requireRole('admin'), asyncHandler(async (req, res) => {
  const result = await withTransaction(async (client) => {
    const dr = await client.query(
      `SELECT * FROM sst.borradores_extraccion WHERE id=$1 FOR UPDATE`, [req.params.id]
    );
    const draft = dr.rows[0];
    if (!draft) throw notFound('Borrador no encontrado');
    if (draft.estado === 'VALIDADA') throw conflict('El borrador ya fue validado');
    if (!draft.arl_id) throw badRequest('El borrador no tiene ARL detectada');

    const m = draft.metadatos_extraccion || {};
    const val = (f) => (m[f]?.value ?? null) || null;
    const cron = val('codigo_cronograma');
    const sec = val('secuencia');
    if (!cron || !sec) throw badRequest('codigo_cronograma y secuencia son obligatorios');

    // Dedup IMP-09 (defensa adicional a la constraint UNIQUE).
    const dup = await client.query(
      `SELECT id FROM sst.ordenes_servicio WHERE arl_id=$1 AND codigo_cronograma=$2 AND secuencia=$3`,
      [draft.arl_id, cron, sec]
    );
    if (dup.rows[0]) throw conflict('OS duplicada por (ARL + cronograma + secuencia)');

    // Código legible OS-YYYY-NNNN.
    const year = new Date().getFullYear();
    const cnt = await client.query(
      `SELECT count(*)::int AS c FROM sst.ordenes_servicio WHERE codigo LIKE $1`, [`OS-${year}-%`]
    );
    const codigo = `OS-${year}-${String(cnt.rows[0].c + 1).padStart(4, '0')}`;

    const ord = await client.query(
      `INSERT INTO sst.ordenes_servicio (
         codigo, arl_id, codigo_cronograma, secuencia, nit_nic, empresa_nombre,
         actividad_economica, horas_asignadas, descripcion,
         contacto_sst_nombre, contacto_sst_telefono, contacto_sst_correo,
         lote_importacion_id, url_archivo_original, metadatos_extraccion, estado)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'SIN PROGRAMAR')
       RETURNING *`,
      [
        codigo, draft.arl_id, cron, sec, val('nit_nic'), val('empresa_nombre'),
        val('actividad_economica'),
        val('horas_asignadas') ? parseFloat(String(val('horas_asignadas')).replace(',', '.')) : null,
        val('descripcion'),
        val('contacto_sst_nombre'), val('contacto_sst_telefono'), val('contacto_sst_correo'),
        draft.lote_importacion_id, draft.url_archivo_original, m,
      ]
    );
    const orden = ord.rows[0];

    // Primera entrada de auditoría (EST-03): creación → SIN PROGRAMAR.
    await client.query(
      `INSERT INTO sst.historial_estados_orden (orden_id, estado_anterior, estado_nuevo, cambiado_por, motivo)
       VALUES ($1, NULL, 'SIN PROGRAMAR', $2, 'Validación IA — creación de OS')`,
      [orden.id, req.user.sub]
    );

    await client.query(
      `UPDATE sst.borradores_extraccion SET estado='VALIDADA', orden_servicio_id=$2 WHERE id=$1`,
      [draft.id, orden.id]
    );
    return orden;
  });
  res.status(201).json({ message: 'OS validada y guardada', data: result });
}));

// Descartar un borrador
router.post('/:id/discard', requireRole('admin'), asyncHandler(async (req, res) => {
  const r = await pool.query(
    `UPDATE sst.borradores_extraccion SET estado='DESCARTADA'
     WHERE id=$1 AND estado <> 'VALIDADA' RETURNING id, estado`,
    [req.params.id]
  );
  if (!r.rows[0]) throw notFound('Borrador no encontrado o ya validado');
  res.json({ data: r.rows[0] });
}));

export default router;
