import { Router } from 'express';
import { pool, withTransaction } from '../../config/db.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authRequired, requireRole } from '../../middleware/auth.js';
import { badRequest, notFound, conflict } from '../../utils/httpError.js';
import { computeOverallConfidence } from '../../services/extraction.service.js';
import { CANONICAL_FIELDS } from '../../services/gemini.service.js';

const router = Router();
router.use(authRequired);

/** "588.560,00" | "$ 58.856" | 588560 → 588560. Devuelve number o null. */
function parseNumeroCO(raw) {
  if (raw == null || raw === '') return null;
  let s = String(raw).trim().replace(/[^\d.,-]/g, '');
  if (!s) return null;
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) s = s.replace(/\./g, '').replace(',', '.'); // CO: . miles, , decimal
  else if (hasComma) s = s.replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/** "26/06/2026" | "2026-06-26" → "YYYY-MM-DD". Devuelve string ISO o null. */
function parseFechaCO(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

// SELECT base con nombres legibles (ARL, archivo del lote y profesional asignado).
//
// Se trae también el estado de la OS materializada (`os_estado`/`os_codigo`): la
// vista Órdenes muestra en la misma fila el borrador y, una vez validado, el
// ciclo de vida real de la orden (SIN PROGRAMAR → … → EJECUTADA). Es NULL
// mientras el borrador siga pendiente de validar.
// La asignación real (M5) vive en la OS, no en el borrador: por eso se traen
// también su profesional y su fecha programada, que son los que valen una vez
// materializada la orden.
const DRAFT_SELECT = `
  SELECT d.*, a.nombre AS arl_nombre, b.nombre_archivo, b.tipo_mime,
         p.nombre AS profesional_nombre,
         o.estado::text AS os_estado, o.codigo AS os_codigo,
         o.fecha_programada AS os_fecha_programada,
         o.profesional_asignado_id AS os_profesional_id,
         po.nombre AS os_profesional_nombre
  FROM sst.borradores_extraccion d
  LEFT JOIN sst.arls a ON a.id = d.arl_id
  LEFT JOIN sst.lotes_importacion b ON b.id = d.lote_importacion_id
  LEFT JOIN sst.profesionales p ON p.id = d.profesional_asignado_id
  LEFT JOIN sst.ordenes_servicio o ON o.id = d.orden_servicio_id
  LEFT JOIN sst.profesionales po ON po.id = o.profesional_asignado_id`;

// Vista "Órdenes" (M3). Filtrable por estado y por soft-delete.
//   ?estado=PENDIENTE_VALIDACION | VALIDADA | ... | ALL
//   Admite varios separados por coma: ?estado=PENDIENTE_VALIDACION,VALIDADA.
//   La vista Órdenes los necesita juntos: una orden validada ya no está
//   pendiente, pero sigue viviendo en la bandeja con otro estado.
//   ?deshabilitado=false (por defecto) | true | all
router.get('/', asyncHandler(async (req, res) => {
  const estado = req.query.estado || req.query.status || 'PENDIENTE_VALIDACION';
  const desh = String(req.query.deshabilitado ?? 'false').toLowerCase();

  const estados = String(estado).split(',').map((s) => s.trim()).filter(Boolean);
  const params = [estados];
  let filtroDesh = 'AND d.deshabilitado = false';
  if (desh === 'true') filtroDesh = 'AND d.deshabilitado = true';
  else if (desh === 'all') filtroDesh = '';

  // Comparación como texto (no como enum): un estado inexistente simplemente no
  // devuelve filas, en vez de romper la consulta con un error de casteo.
  const r = await pool.query(
    `${DRAFT_SELECT}
     WHERE ('ALL' = ANY($1::text[]) OR d.estado::text = ANY($1::text[]))
     ${filtroDesh}
     ORDER BY d.creado_en DESC`,
    params
  );
  res.json({ data: r.rows });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const r = await pool.query(`${DRAFT_SELECT} WHERE d.id=$1`, [req.params.id]);
  if (!r.rows[0]) throw notFound('Borrador no encontrado');
  res.json({ data: r.rows[0] });
}));

/** Recarga un borrador expandido (helper para respuestas tras un cambio). */
async function loadDraftExpanded(id, client = pool) {
  const r = await client.query(`${DRAFT_SELECT} WHERE d.id=$1`, [id]);
  return r.rows[0] || null;
}

// ASG · Asignar profesional al borrador (asignación ligera antes de materializar).
router.post('/:id/assign', requireRole('admin'), asyncHandler(async (req, res) => {
  const profesionalId = req.body?.profesional_id || req.body?.professional_id;
  const fechaProgramada = req.body?.fecha_programada || req.body?.scheduled_at || null;
  if (!profesionalId) throw badRequest('profesional_id es obligatorio');

  const prof = await pool.query(`SELECT id, estado FROM sst.profesionales WHERE id=$1`, [profesionalId]);
  if (!prof.rows[0]) throw badRequest('Profesional no existe');
  if (prof.rows[0].estado !== 'Activo') throw badRequest('El profesional está Inactivo');

  const upd = await pool.query(
    `UPDATE sst.borradores_extraccion
       SET profesional_asignado_id=$2, fecha_programada=$3
     WHERE id=$1 AND deshabilitado=false
     RETURNING id`,
    [req.params.id, profesionalId, fechaProgramada]
  );
  if (!upd.rows[0]) throw notFound('Borrador no encontrado o deshabilitado');

  res.json({ message: 'Profesional asignado a la orden.', data: await loadDraftExpanded(req.params.id) });
}));

// SOFT-DELETE · Deshabilitar (inactivar) el borrador sin borrarlo físicamente.
router.patch('/:id/disable', requireRole('admin'), asyncHandler(async (req, res) => {
  const r = await pool.query(
    `UPDATE sst.borradores_extraccion
       SET deshabilitado=true, deshabilitado_en=now(), deshabilitado_por=$2
     WHERE id=$1 AND deshabilitado=false
     RETURNING id`,
    [req.params.id, req.user.sub]
  );
  if (!r.rows[0]) throw notFound('Borrador no encontrado o ya deshabilitado');
  res.json({ message: 'Orden deshabilitada.', data: await loadDraftExpanded(req.params.id) });
}));

// Restaurar un borrador deshabilitado.
router.patch('/:id/enable', requireRole('admin'), asyncHandler(async (req, res) => {
  const r = await pool.query(
    `UPDATE sst.borradores_extraccion
       SET deshabilitado=false, deshabilitado_en=NULL, deshabilitado_por=NULL
     WHERE id=$1 AND deshabilitado=true
     RETURNING id`,
    [req.params.id]
  );
  if (!r.rows[0]) throw notFound('Borrador no encontrado o ya activo');
  res.json({ message: 'Orden restaurada.', data: await loadDraftExpanded(req.params.id) });
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
    `UPDATE sst.borradores_extraccion
       SET metadatos_extraccion=$2, confianza_general=$3, actualizado_en=now()
     WHERE id=$1 RETURNING id`,
    [req.params.id, merged, merged.overall_confidence]
  );
  if (!r.rows[0]) throw notFound('Borrador no encontrado');
  // Se devuelve expandido (arl_nombre, archivo, profesional) para que el cliente
  // pueda reemplazar la fila sin perder los campos derivados del JOIN.
  res.json({ data: await loadDraftExpanded(req.params.id) });
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
    const numeroOrden = val('numero_orden');
    const cron = val('codigo_cronograma');
    const sec = val('secuencia');

    // Identidad por ARL: Bolívar usa cronograma+secuencia; AXA/Colmena, numero_orden.
    if (!numeroOrden && !(cron && sec)) {
      throw badRequest('La OS necesita numero_orden, o bien codigo_cronograma + secuencia');
    }

    // Dedup IMP-09 según la identidad disponible (defensa adicional al índice UNIQUE).
    if (numeroOrden) {
      const dup = await client.query(
        `SELECT id FROM sst.ordenes_servicio WHERE arl_id=$1 AND numero_orden=$2`,
        [draft.arl_id, numeroOrden]
      );
      if (dup.rows[0]) throw conflict('OS duplicada por (ARL + número de orden)');
    } else {
      const dup = await client.query(
        `SELECT id FROM sst.ordenes_servicio WHERE arl_id=$1 AND codigo_cronograma=$2 AND secuencia=$3`,
        [draft.arl_id, cron, sec]
      );
      if (dup.rows[0]) throw conflict('OS duplicada por (ARL + cronograma + secuencia)');
    }

    // Código legible OS-YYYY-NNNN.
    const year = new Date().getFullYear();
    const cnt = await client.query(
      `SELECT count(*)::int AS c FROM sst.ordenes_servicio WHERE codigo LIKE $1`, [`OS-${year}-%`]
    );
    const codigo = `OS-${year}-${String(cnt.rows[0].c + 1).padStart(4, '0')}`;

    const ord = await client.query(
      `INSERT INTO sst.ordenes_servicio (
         codigo, arl_id, numero_orden, codigo_cronograma, secuencia, nro_afiliacion,
         nit_nic, empresa_nombre, actividad_economica, tipo_actividad, modalidad,
         horas_asignadas, valor_unitario, valor_total,
         fecha_orden, fecha_vencimiento, ciudad_ejecucion, direccion, descripcion,
         contacto_empresa_nombre, contacto_empresa_cargo, contacto_empresa_telefono,
         contacto_sst_nombre, contacto_sst_telefono, contacto_sst_correo,
         lote_importacion_id, url_archivo_original, metadatos_extraccion, estado)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
               $20,$21,$22,$23,$24,$25,$26,$27,$28,'SIN PROGRAMAR')
       RETURNING *`,
      [
        codigo, draft.arl_id, numeroOrden, cron, sec, val('nro_afiliacion'),
        val('nit_nic'), val('empresa_nombre'), val('actividad_economica'),
        val('tipo_actividad'), val('modalidad'),
        parseNumeroCO(val('horas_asignadas')), parseNumeroCO(val('valor_unitario')),
        parseNumeroCO(val('valor_total')),
        parseFechaCO(val('fecha_orden')), parseFechaCO(val('fecha_vencimiento')),
        val('ciudad_ejecucion'), val('direccion'), val('descripcion'),
        val('contacto_empresa_nombre'), val('contacto_empresa_cargo'), val('contacto_empresa_telefono'),
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
