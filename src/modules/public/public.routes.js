import { Router } from 'express';
import { pool, withTransaction } from '../../config/db.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { uploadSupports } from '../../middleware/upload.js';
import { badRequest, notFound } from '../../utils/httpError.js';
import { storage } from '../../services/storage.service.js';
import { changeStatus } from '../orders/orders.service.js';
import { notifyAdmins } from '../../services/notification.service.js';
import { registrarRespuesta, resolverToken as resolverEncuesta } from '../surveys/surveys.service.js';
import {
  enPesos, periodoLargo, resolverToken as resolverPrecuenta, responderPrecuenta,
} from '../billing/billing.service.js';
import { notify } from '../../services/notification.service.js';

const router = Router();

// Resuelve un token de enlace público activo → OS asociada.
async function resolveToken(token, client = pool) {
  const r = await client.query(
    `SELECT pl.id AS enlace_id, pl.activo, pl.expira_en, o.*
     FROM sst.enlaces_publicos pl JOIN sst.ordenes_servicio o ON o.id = pl.orden_id
     WHERE pl.token=$1`, [token]
  );
  const row = r.rows[0];
  if (!row) throw notFound('Enlace inválido');
  if (!row.activo) throw badRequest('El enlace ya no está activo');
  if (row.expira_en && new Date(row.expira_en) < new Date()) throw badRequest('El enlace expiró');
  return row;
}

// M6 · Resumen de la OS para el portal público (SIN login).
router.get('/support/:token', asyncHandler(async (req, res) => {
  const row = await resolveToken(req.params.token);
  const arl = await pool.query(`SELECT nombre FROM sst.arls WHERE id=$1`, [row.arl_id]);
  const files = await pool.query(
    `SELECT id, nombre_original, mime, subido_en FROM sst.archivos_soporte WHERE orden_id=$1 ORDER BY subido_en`,
    [row.id]
  );
  res.json({
    data: {
      codigo: row.codigo,
      empresa_nombre: row.empresa_nombre,
      arl_nombre: arl.rows[0]?.nombre,
      actividad_economica: row.actividad_economica,
      horas_asignadas: row.horas_asignadas,
      fecha_programada: row.fecha_programada,
      estado: row.estado,
      soportes_cargados: files.rows,
    },
  });
}));

// M6 · Subir soportes firmados (SIN login). Múltiples archivos. → EJECUTADA.
//
// SUP-05 hablaba de EN VERIFICACIÓN, un estado intermedio que se eliminó: la
// visita ya se hizo y los soportes están, así que la orden queda EJECUTADA. La
// revisión del administrador (VER-01/02) no desaparece — sigue pudiendo abrir
// los soportes y rechazarlos, y el rechazo devuelve la OS a PROGRAMADA.
router.post('/support/:token/files', uploadSupports.array('files', 10), asyncHandler(async (req, res) => {
  if (!req.files?.length) throw badRequest('Adjunta al menos un archivo en "files"');

  const result = await withTransaction(async (client) => {
    const row = await resolveToken(req.params.token, client);
    // EJECUTADA sigue admitiendo archivos: el profesional puede haber olvidado
    // uno y volver por el mismo enlace a completarlo.
    if (!['PROGRAMADA', 'EJECUTADA'].includes(row.estado)) {
      throw badRequest(`No se pueden subir soportes en estado ${row.estado}`);
    }
    const saved = [];
    for (const f of req.files) {
      const key = await storage.put(`supports/${row.id}`, f.originalname, f.buffer);
      const sf = await client.query(
        `INSERT INTO sst.archivos_soporte (orden_id, enlace_publico_id, url_archivo, nombre_original, mime, tamano_bytes, via_enlace_publico)
         VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING id, nombre_original, mime`,
        [row.id, row.enlace_id, key, f.originalname, f.mimetype, f.size]
      );
      saved.push(sf.rows[0]);
    }
    // SUP-05 · al subir, la OS queda EJECUTADA (si estaba PROGRAMADA).
    if (row.estado === 'PROGRAMADA') {
      await changeStatus(
        { orderId: row.id, newStatus: 'EJECUTADA', userId: null, motivo: 'Soportes cargados por el profesional' },
        client
      );
    }
    return { orden: row, saved };
  });

  // SUP-06 · avisar a administradores. El aviso sigue siendo necesario aunque ya
  // no haya estado intermedio: alguien tiene que mirar los soportes.
  await notifyAdmins({
    tipo: 'SOPORTE_CARGADO',
    titulo: 'Soportes recibidos',
    mensaje: `${result.orden.codigo} · ${result.orden.empresa_nombre || ''} quedó EJECUTADA · revise los soportes`,
    datos: { orden_id: result.orden.id },
  });

  res.status(201).json({ message: 'Soportes cargados. La OS quedó ejecutada.', data: result.saved });
}));

// ---------------------------------------------------------------------------
// M8 · Encuesta de satisfacción (ENC-02/03/06) — formulario público, SIN login.
// ---------------------------------------------------------------------------

/**
 * Datos del formulario. Devuelve también `respondida` para que la vista muestre
 * el agradecimiento en vez del formulario cuando el cliente ya contestó
 * (ENC-06); no se responde 404/409 porque volver a abrir el enlace del correo
 * es un gesto normal, no un error.
 */
router.get('/survey/:token', asyncHandler(async (req, res) => {
  const e = await resolverEncuesta(req.params.token);
  res.json({
    data: {
      orden_codigo: e.orden_codigo,
      empresa_nombre: e.empresa_nombre,
      arl_nombre: e.arl_nombre,
      profesional_nombre: e.profesional_nombre,
      actividad_economica: e.actividad_economica,
      fecha_programada: e.fecha_programada,
      contacto_nombre: e.contacto_nombre,
      preguntas: e.preguntas,
      respondida: e.respondida,
      respondido_en: e.respondido_en,
    },
  });
}));

// ENC-04 · Registrar la respuesta del cliente.
router.post('/survey/:token', asyncHandler(async (req, res) => {
  const { satisfaccion, recomendacion, comentarios } = req.body || {};
  const e = await registrarRespuesta(req.params.token, { satisfaccion, recomendacion, comentarios });

  // El administrador se entera de la calificación sin tener que ir a buscarla;
  // una nota baja es justamente lo que conviene ver temprano.
  await notifyAdmins({
    tipo: 'ENCUESTA_RESPONDIDA',
    titulo: 'Encuesta respondida',
    mensaje: `${e.orden_codigo} · ${e.empresa_nombre || ''} calificó ${e.satisfaccion}/5`,
    datos: { orden_id: e.orden_id },
  }).catch((err) => console.error('[encuesta] notificación interna no creada:', err?.message));

  res.status(201).json({
    message: '¡Gracias! Su respuesta quedó registrada.',
    data: { respondido_en: e.respondido_en },
  });
}));

// ---------------------------------------------------------------------------
// M9 · Pre-cuenta de cobro (PRE-05/06/07) — el profesional acepta o rechaza
// desde el enlace del correo, SIN login.
// ---------------------------------------------------------------------------

/** Detalle de la pre-cuenta para revisarla antes de decidir. */
router.get('/precuenta/:token', asyncHandler(async (req, res) => {
  const pc = await resolverPrecuenta(req.params.token);
  res.json({
    data: {
      periodo: pc.periodo,
      periodo_largo: periodoLargo(pc.periodo),
      profesional_nombre: pc.profesional_nombre,
      total_horas: pc.total_horas,
      total_monto: pc.total_monto,
      total_ordenes: pc.total_ordenes,
      estado: pc.estado,
      observaciones: pc.observaciones,
      respondido_en: pc.respondido_en,
      items: pc.items.map((i) => ({
        orden_codigo: i.orden_codigo,
        empresa_nombre: i.empresa_nombre,
        arl_nombre: i.arl_nombre,
        actividad: i.actividad,
        fecha_ejecucion: i.fecha_ejecucion,
        horas: i.horas,
        valor_hora: i.valor_hora_snapshot,
        monto: i.monto,
      })),
    },
  });
}));

/** PRE-06/07 · Aceptar o rechazar (con observaciones obligatorias al rechazar). */
router.post('/precuenta/:token/responder', asyncHandler(async (req, res) => {
  const { decision, observaciones } = req.body || {};
  const pc = await responderPrecuenta(req.params.token, { decision, observaciones });

  // PRE-06 · Enterar a quien tiene que actuar: administradores y contadores.
  // Un rechazo abre trabajo manual, así que se marca como tal en el mensaje.
  const aceptada = pc.estado === 'aceptada';
  const destinatarios = await pool.query(
    `SELECT id FROM sst.usuarios WHERE activo AND rol IN ('admin','contador')`
  );
  await Promise.all(destinatarios.rows.map((u) => notify({
    userId: u.id,
    tipo: aceptada ? 'PRECUENTA_ACEPTADA' : 'PRECUENTA_RECHAZADA',
    titulo: aceptada ? 'Pre-cuenta aceptada' : 'Pre-cuenta rechazada',
    mensaje: aceptada
      ? `${pc.profesional_nombre} aceptó su pre-cuenta de ${periodoLargo(pc.periodo)} por ${enPesos(pc.total_monto)}`
      : `${pc.profesional_nombre} rechazó su pre-cuenta de ${periodoLargo(pc.periodo)}: ${pc.observaciones || 'sin detalle'}`,
    datos: { precuenta_id: pc.id },
  }))).catch((err) => console.error('[precuenta] notificación interna no creada:', err?.message));

  res.json({
    message: aceptada
      ? 'Pre-cuenta aceptada. Gracias por confirmar.'
      : 'Pre-cuenta rechazada. Un administrador revisará sus observaciones.',
    data: { estado: pc.estado, respondido_en: pc.respondido_en },
  });
}));

export default router;
