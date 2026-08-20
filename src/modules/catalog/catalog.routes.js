import { Router } from 'express';
import { pool } from '../../config/db.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authRequired, requireRole, requireMaestro } from '../../middleware/auth.js';
import { badRequest, conflict, notFound } from '../../utils/httpError.js';
import { tieneFormatosPropios } from '../../services/formatos-arl.service.js';

const router = Router();
router.use(authRequired);

// Catálogo de ARLs.
//
// `formatos_propios` dice si la ARL trae sus formatos oficiales cargados
// (`assets/formatos-arl/`). Va aquí porque quien asigna necesita saberlo: sin
// este dato la vista avisaría de que "la ARL no tiene formatos configurados"
// justo para las dos ARL cuyos formatos son los buenos, los de la ARL misma.
router.get('/arls', asyncHandler(async (_req, res) => {
  const r = await pool.query(`SELECT * FROM sst.arls ORDER BY nombre`);
  res.json({
    data: r.rows.map((a) => ({ ...a, formatos_propios: tieneFormatosPropios(a.nombre) })),
  });
}));

// ---------------------------------------------------------------------------
// CFG-03 · Plantillas de formatos (M4)
//
// El PDF se dibuja con pdf-lib a partir de la OS; no se rellena un archivo base.
// Por eso "editar la plantilla" significa editar lo que sale impreso —título,
// encabezado y nota al pie— y qué formatos se generan para cada ARL, no subir un
// documento que nadie consumiría.
// ---------------------------------------------------------------------------

/** Tipos que contempla el FRS (FOR-01..04). Fija el nombre del archivo generado. */
const TIPOS_FORMATO = ['acta_visita', 'asistencia', 'ficha_gestion'];

const PLANTILLA_COLS = `t.id, t.arl_id, t.nombre, t.tipo, t.descripcion, t.encabezado,
                        t.nota_pie, t.orden, t.activo, t.creado_en, t.actualizado_en`;

const limpiar = (v) => {
  const s = v == null ? '' : String(v).trim();
  return s === '' ? null : s;
};

/**
 * Plantillas de formatos. Por defecto solo las activas (es lo que necesita
 * cualquier consumidor operativo); `?todas=true` agrega las desactivadas para la
 * pantalla de configuración, que tiene que poder reactivarlas.
 */
router.get('/templates', asyncHandler(async (req, res) => {
  const todas = req.query.todas === 'true';
  const r = await pool.query(
    `SELECT ${PLANTILLA_COLS}, a.nombre AS arl_nombre,
            (SELECT count(*)::int FROM sst.documentos_generados d WHERE d.plantilla_id = t.id) AS documentos_generados
       FROM sst.plantillas t
       LEFT JOIN sst.arls a ON a.id = t.arl_id
      ${todas ? '' : 'WHERE t.activo'}
      ORDER BY a.nombre NULLS FIRST, t.orden, t.nombre`
  );
  res.json({ data: r.rows });
}));

// CFG-03 · Alta de un formato (admin).
router.post('/templates', requireRole('admin'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  const nombre = limpiar(b.nombre);
  const tipo = limpiar(b.tipo);
  if (!nombre) throw badRequest('El nombre del formato es obligatorio');
  if (!TIPOS_FORMATO.includes(tipo)) {
    throw badRequest(`El tipo debe ser uno de: ${TIPOS_FORMATO.join(', ')}`);
  }
  const r = await pool.query(
    `INSERT INTO sst.plantillas (arl_id, nombre, tipo, descripcion, encabezado, nota_pie, orden, activo)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,0),TRUE)
     RETURNING *`,
    [limpiar(b.arl_id), nombre, tipo, limpiar(b.descripcion), limpiar(b.encabezado),
      limpiar(b.nota_pie), Number.isFinite(Number(b.orden)) ? Number(b.orden) : 0]
  );
  res.status(201).json({ data: r.rows[0] });
}));

// CFG-03 · Edición (admin). Los campos ausentes conservan su valor.
router.put('/templates/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (b.nombre !== undefined && !limpiar(b.nombre)) throw badRequest('El nombre no puede quedar vacío');
  if (b.tipo !== undefined && !TIPOS_FORMATO.includes(limpiar(b.tipo))) {
    throw badRequest(`El tipo debe ser uno de: ${TIPOS_FORMATO.join(', ')}`);
  }
  // Los campos de texto (y la ARL) se envían siempre desde el formulario, y ahí
  // '' significa "déjalo en blanco". Por eso van con un booleano "¿vino en el
  // cuerpo?" en vez de COALESCE, que no sabría distinguir vaciar de no tocar.
  const r = await pool.query(
    `UPDATE sst.plantillas SET
       arl_id      = CASE WHEN $2::boolean THEN $3::uuid ELSE arl_id END,
       nombre      = COALESCE($4, nombre),
       tipo        = COALESCE($5, tipo),
       descripcion = CASE WHEN $6::boolean  THEN $7  ELSE descripcion END,
       encabezado  = CASE WHEN $8::boolean  THEN $9  ELSE encabezado END,
       nota_pie    = CASE WHEN $10::boolean THEN $11 ELSE nota_pie END,
       orden       = COALESCE($12, orden),
       actualizado_en = now()
     WHERE id = $1
     RETURNING *`,
    [
      req.params.id,
      b.arl_id !== undefined, limpiar(b.arl_id),
      limpiar(b.nombre), limpiar(b.tipo),
      b.descripcion !== undefined, limpiar(b.descripcion),
      b.encabezado !== undefined, limpiar(b.encabezado),
      b.nota_pie !== undefined, limpiar(b.nota_pie),
      b.orden === undefined || !Number.isFinite(Number(b.orden)) ? null : Number(b.orden),
    ]
  );
  if (!r.rows[0]) throw notFound('Formato no encontrado');
  res.json({ data: r.rows[0] });
}));

// CFG-03 · Activar / desactivar (admin). Un formato inactivo deja de generarse
// en las asignaciones nuevas, pero los PDF ya emitidos siguen intactos.
router.patch('/templates/:id/estado', requireRole('admin'), asyncHandler(async (req, res) => {
  const r = await pool.query(
    `UPDATE sst.plantillas SET activo = NOT activo, actualizado_en = now()
      WHERE id=$1 RETURNING *`,
    [req.params.id]
  );
  if (!r.rows[0]) throw notFound('Formato no encontrado');
  res.json({ data: r.rows[0] });
}));

/**
 * CFG-03 · Baja definitiva (admin). Si ya se emitieron PDF con esta plantilla se
 * rechaza: `documentos_generados` la referencia y borrarla dejaría sin origen a
 * documentos que están en manos de los profesionales y las ARL.
 */
router.delete('/templates/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const usos = await pool.query(
    `SELECT count(*)::int AS c FROM sst.documentos_generados WHERE plantilla_id=$1`, [req.params.id]
  );
  if (usos.rows[0].c > 0) {
    throw conflict(
      `Este formato ya generó ${usos.rows[0].c} documento(s). Desactívelo en lugar de eliminarlo.`
    );
  }
  const r = await pool.query(`DELETE FROM sst.plantillas WHERE id=$1 RETURNING id`, [req.params.id]);
  if (!r.rows[0]) throw notFound('Formato no encontrado');
  res.json({ data: { id: r.rows[0].id } });
}));

// ---------------------------------------------------------------------------
// Configuración (tabla configuracion)
// ---------------------------------------------------------------------------

router.get('/settings', asyncHandler(async (_req, res) => {
  const r = await pool.query(`SELECT clave, valor, descripcion FROM sst.configuracion ORDER BY clave`);
  const map = Object.fromEntries(r.rows.map((row) => [row.clave, row.valor]));
  res.json({ data: map, raw: r.rows });
}));

/** Guarda una clave de configuración con su descripción (upsert). */
async function guardarConfig(clave, valor, descripcion) {
  const r = await pool.query(
    `INSERT INTO sst.configuracion (clave, valor, descripcion)
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = now()
     RETURNING clave, valor`,
    [clave, JSON.stringify(valor), descripcion]
  );
  return r.rows[0];
}

// Config · Umbral de confianza de la IA (default 70). Solo Administrador Maestro:
// el umbral es un parámetro global del pipeline de IA (afecta qué campos se marcan
// para revisión manual en TODAS las órdenes), no una preferencia por usuario.
// La lectura (GET /settings) queda abierta a cualquier sesión autenticada.
router.put('/settings/confidence-threshold', requireMaestro, asyncHandler(async (req, res) => {
  const { value } = req.body || {};
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw badRequest('El umbral debe estar entre 0 y 100');
  res.json({
    data: await guardarConfig('confidence_threshold', n, 'Umbral mínimo de confianza de la IA (%).'),
  });
}));

/**
 * ENC-03 · Enunciados de la encuesta de satisfacción. Son del negocio (los
 * redacta JD&D), así que los edita el administrador y no solo el Maestro.
 *
 * Solo cambia la REDACCIÓN: las dos escalas siguen siendo 1-5 y siguen
 * alimentando el promedio de satisfacción del dashboard (ENC-05). Por eso las
 * claves son fijas y no se aceptan preguntas nuevas.
 */
const CLAVES_ENCUESTA = ['titulo', 'satisfaccion', 'recomendacion', 'comentarios'];

router.put('/settings/encuesta-preguntas', requireRole('admin'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  const preguntas = {};
  for (const clave of CLAVES_ENCUESTA) {
    const texto = limpiar(b[clave]);
    if (!texto) throw badRequest(`El enunciado "${clave}" no puede quedar vacío`);
    if (texto.length > 200) throw badRequest(`El enunciado "${clave}" no puede pasar de 200 caracteres`);
    preguntas[clave] = texto;
  }
  res.json({
    data: await guardarConfig('encuesta_preguntas', preguntas,
      'ENC-03 · Textos del formulario público de satisfacción.'),
  });
}));

/**
 * CFG-05 · Día de corte de las pre-cuentas (M9).
 *
 * Se limita a 28 para que exista en todos los meses (febrero incluido). Guardar
 * el día NO genera nada solo: el despliegue no tiene cron, así que el cierre
 * sigue disparándose a mano y esta fecha es la referencia contra la que la vista
 * de Pre-cuentas avisa de los periodos vencidos sin generar.
 */
router.put('/settings/precuenta-dia-corte', requireRole('admin'), asyncHandler(async (req, res) => {
  const n = Number((req.body || {}).value);
  if (!Number.isInteger(n) || n < 1 || n > 28) {
    throw badRequest('El día de corte debe ser un entero entre 1 y 28');
  }
  res.json({
    data: await guardarConfig('precuenta_dia_corte', n,
      'Día del mes en que se cierran las pre-cuentas del mes anterior (1-28).'),
  });
}));

// ---------------------------------------------------------------------------
// CFG-04 · Tipos de orden y su valor hora ("Valores por hora según actividad")
//
// Es la lista con la que se categoriza CADA orden al cargarla, y de la que sale
// lo que se le paga al profesional por hora. Hasta ahora vivía escrita a mano en
// la pantalla de Configuración y no se guardaba en ninguna parte, así que la
// orden no podía apuntar a nada.
// ---------------------------------------------------------------------------

/** Los tipos que se pueden elegir hoy; los inactivos solo salen si se piden. */
router.get('/tipos-orden', asyncHandler(async (req, res) => {
  const incluirInactivos = req.query.todos === 'true';
  const r = await pool.query(
    `SELECT t.id, t.nombre, t.valor_hora, t.activo, t.creado_en, t.actualizado_en,
            (SELECT count(*)::int FROM sst.ordenes_servicio o WHERE o.tipo_orden_id = t.id) AS ordenes
       FROM sst.tipos_orden t
      ${incluirInactivos ? '' : 'WHERE t.activo'}
      ORDER BY t.activo DESC, t.nombre`
  );
  res.json({ data: r.rows });
}));

router.post('/tipos-orden', requireRole('admin'), asyncHandler(async (req, res) => {
  const nombre = limpiar(req.body?.nombre);
  const valor = Number(req.body?.valor_hora);
  if (!nombre) throw badRequest('El nombre del tipo de orden es obligatorio.');
  if (!Number.isFinite(valor) || valor < 0) throw badRequest('El valor hora debe ser un número mayor o igual que cero.');
  try {
    const r = await pool.query(
      `INSERT INTO sst.tipos_orden (nombre, valor_hora) VALUES ($1,$2)
       RETURNING id, nombre, valor_hora, activo, creado_en, actualizado_en`,
      [nombre, valor]
    );
    res.status(201).json({ data: { ...r.rows[0], ordenes: 0 } });
  } catch (e) {
    // El índice único es sobre el nombre en minúsculas: 'Asesoría' y 'asesoría'
    // son el mismo tipo, y dos filas iguales harían ambigua la elección.
    if (e.code === '23505') throw conflict(`Ya existe un tipo de orden llamado "${nombre}".`);
    throw e;
  }
}));

/**
 * Cambiar el valor hora NO reescribe lo ya trabajado: cada orden se quedó con su
 * copia al asignarse el profesional. Este valor manda sobre las órdenes que se
 * asignen a partir de ahora.
 */
router.put('/tipos-orden/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const nombre = req.body?.nombre === undefined ? null : limpiar(req.body.nombre);
  if (req.body?.nombre !== undefined && !nombre) throw badRequest('El nombre no puede quedar vacío.');
  const valor = req.body?.valor_hora === undefined ? null : Number(req.body.valor_hora);
  if (valor !== null && (!Number.isFinite(valor) || valor < 0)) {
    throw badRequest('El valor hora debe ser un número mayor o igual que cero.');
  }
  const activo = req.body?.activo === undefined ? null : Boolean(req.body.activo);

  try {
    const r = await pool.query(
      `UPDATE sst.tipos_orden
          SET nombre     = COALESCE($2, nombre),
              valor_hora = COALESCE($3, valor_hora),
              activo     = COALESCE($4, activo),
              actualizado_en = now()
        WHERE id = $1
        RETURNING id, nombre, valor_hora, activo, creado_en, actualizado_en`,
      [req.params.id, nombre, valor, activo]
    );
    if (!r.rows[0]) throw notFound('Tipo de orden no encontrado');
    res.json({ data: r.rows[0] });
  } catch (e) {
    if (e.code === '23505') throw conflict(`Ya existe un tipo de orden llamado "${nombre}".`);
    throw e;
  }
}));

/**
 * "Eliminar" es desactivar. Un tipo con órdenes detrás no se puede borrar sin
 * dejar sin explicación su historial —ni el valor hora con el que se cobraron—,
 * así que sale de la lista de elección y se queda en la base.
 */
router.delete('/tipos-orden/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const r = await pool.query(
    `UPDATE sst.tipos_orden SET activo = FALSE, actualizado_en = now()
      WHERE id = $1 RETURNING id, nombre`,
    [req.params.id]
  );
  if (!r.rows[0]) throw notFound('Tipo de orden no encontrado');
  res.json({ message: `"${r.rows[0].nombre}" ya no se puede elegir en órdenes nuevas.` });
}));

export default router;
