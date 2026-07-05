import { Router } from 'express';
import { pool, withTransaction } from '../../config/db.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authRequired, requireRole } from '../../middleware/auth.js';
import { badRequest } from '../../utils/httpError.js';
import { getOrderExpanded, changeStatus, generateOrderDocuments } from './orders.service.js';
import { randomToken } from '../../utils/security.js';
import { env } from '../../config/env.js';
import { sendEmail } from '../../services/email.service.js';
import { notify } from '../../services/notification.service.js';

const router = Router();
router.use(authRequired);

// M3 · Listado filtrable (EST-05): estado, arl_id, profesional_id, q.
router.get('/', asyncHandler(async (req, res) => {
  const estado = req.query.estado || req.query.status;
  const { arl_id, profesional_id, q } = req.query;
  const clauses = [];
  const params = [];
  if (estado) { params.push(estado); clauses.push(`estado = $${params.length}::sst.estado_orden`); }
  if (arl_id) { params.push(arl_id); clauses.push(`arl_id = $${params.length}`); }
  if (profesional_id) { params.push(profesional_id); clauses.push(`profesional_asignado_id = $${params.length}`); }
  if (q) {
    params.push(`%${q}%`);
    const p = `$${params.length}`;
    clauses.push(`(empresa_nombre ILIKE ${p} OR codigo ILIKE ${p} OR nit_nic ILIKE ${p})`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const r = await pool.query(
    `SELECT * FROM sst.vw_ordenes_expandidas ${where} ORDER BY fecha_carga DESC LIMIT 200`,
    params
  );
  res.json({ data: r.rows });
}));

// Detalle completo: OS + historial + documentos + soportes + enlace público.
router.get('/:id', asyncHandler(async (req, res) => {
  const orden = await getOrderExpanded(req.params.id);
  const [historial, docs, soportes, enlace] = await Promise.all([
    pool.query(
      `SELECT h.*, u.nombre AS cambiado_por_nombre FROM sst.historial_estados_orden h
       LEFT JOIN sst.usuarios u ON u.id = h.cambiado_por
       WHERE h.orden_id=$1 ORDER BY h.cambiado_en`, [req.params.id]),
    pool.query(`SELECT * FROM sst.documentos_generados WHERE orden_id=$1 ORDER BY generado_en`, [req.params.id]),
    pool.query(`SELECT * FROM sst.archivos_soporte WHERE orden_id=$1 ORDER BY subido_en`, [req.params.id]),
    pool.query(`SELECT * FROM sst.enlaces_publicos WHERE orden_id=$1 AND activo ORDER BY creado_en DESC LIMIT 1`, [req.params.id]),
  ]);
  res.json({
    data: {
      ...orden,
      historial: historial.rows,
      documentos: docs.rows,
      soportes: soportes.rows,
      enlace_publico: enlace.rows[0]
        ? { ...enlace.rows[0], url: `${env.publicAppUrl}/soporte?token=${enlace.rows[0].token}` }
        : null,
    },
  });
}));

router.get('/:id/history', asyncHandler(async (req, res) => {
  const r = await pool.query(
    `SELECT h.*, u.nombre AS cambiado_por_nombre FROM sst.historial_estados_orden h
     LEFT JOIN sst.usuarios u ON u.id = h.cambiado_por
     WHERE h.orden_id=$1 ORDER BY h.cambiado_en`, [req.params.id]);
  res.json({ data: r.rows });
}));

// M5 · Asignar profesional + fecha/hora → PROGRAMADA + genera PDFs + correo.
router.post('/:id/assign', requireRole('admin'), asyncHandler(async (req, res) => {
  const profesionalId = req.body?.profesional_id || req.body?.professional_id;
  const fechaProgramada = req.body?.fecha_programada || req.body?.scheduled_at || null;
  if (!profesionalId) throw badRequest('profesional_id es obligatorio');

  const result = await withTransaction(async (client) => {
    const prof = await client.query(`SELECT * FROM sst.profesionales WHERE id=$1`, [profesionalId]);
    if (!prof.rows[0]) throw badRequest('Profesional no existe');
    if (prof.rows[0].estado !== 'Activo') throw badRequest('El profesional está Inactivo');

    await client.query(
      `UPDATE sst.ordenes_servicio SET profesional_asignado_id=$2, fecha_programada=$3 WHERE id=$1`,
      [req.params.id, profesionalId, fechaProgramada]
    );
    // EST: SIN PROGRAMAR → PROGRAMADA (valida transición + auditoría).
    await changeStatus({ orderId: req.params.id, newStatus: 'PROGRAMADA', userId: req.user.sub }, client);

    // FOR · genera formatos auto-diligenciados.
    const docs = await generateOrderDocuments(req.params.id, client);

    // Enlace público de soportes (M6) listo desde ya.
    const token = randomToken(24);
    await client.query(
      `INSERT INTO sst.enlaces_publicos (orden_id, token) VALUES ($1,$2)`,
      [req.params.id, token]
    );

    const orden = await getOrderExpanded(req.params.id, client);
    return { orden, profesional: prof.rows[0], docs, token };
  });

  // ASG-03/NOT · correo al profesional con PDFs + notificación interna (fuera de la tx).
  const supportUrl = `${env.publicAppUrl}/soporte?token=${result.token}`;
  await sendEmail({
    to: result.profesional.correo,
    subject: `Nueva OS asignada · ${result.orden.codigo} · ${result.orden.empresa_nombre || ''}`,
    text:
      `Hola ${result.profesional.nombre},\n\n` +
      `Se te asignó la OS ${result.orden.codigo} (${result.orden.arl_nombre}) para ` +
      `${result.orden.empresa_nombre}.\n` +
      `Fecha programada: ${result.orden.fecha_programada ? new Date(result.orden.fecha_programada).toLocaleString('es-CO') : 'por definir'}\n` +
      `Horas: ${result.orden.horas_asignadas || '—'}\n\n` +
      `Adjuntamos los formatos para diligenciar y firmar.\n\n` +
      `Al terminar, sube los soportes firmados aquí (sin login):\n${supportUrl}\n`,
    attachments: result.docs.map((d) => ({ filename: d._filename, content: d._buffer })),
  });
  if (result.profesional.usuario_id) {
    await notify({
      userId: result.profesional.usuario_id, tipo: 'ASIGNACION',
      titulo: 'Nueva OS asignada', mensaje: `${result.orden.codigo} · ${result.orden.empresa_nombre || ''}`,
      datos: { orden_id: result.orden.id },
    });
  }

  res.json({
    message: 'OS asignada, formatos generados y correo enviado.',
    data: { ...result.orden, support_url: supportUrl, documentos: result.docs.map(({ _buffer, ...d }) => d) },
  });
}));

// M4 · (Re)generar formatos manualmente
router.post('/:id/documents', requireRole('admin'), asyncHandler(async (req, res) => {
  const docs = await generateOrderDocuments(req.params.id);
  res.status(201).json({ data: docs.map(({ _buffer, ...d }) => d) });
}));

router.get('/:id/documents', asyncHandler(async (req, res) => {
  const r = await pool.query(`SELECT * FROM sst.documentos_generados WHERE orden_id=$1 ORDER BY generado_en`, [req.params.id]);
  res.json({ data: r.rows });
}));

router.get('/:id/supports', asyncHandler(async (req, res) => {
  const r = await pool.query(`SELECT * FROM sst.archivos_soporte WHERE orden_id=$1 ORDER BY subido_en`, [req.params.id]);
  res.json({ data: r.rows });
}));

// M7 · Verificación — Aceptar → EJECUTADA
router.post('/:id/verify', requireRole('admin'), asyncHandler(async (req, res) => {
  const orden = await changeStatus({ orderId: req.params.id, newStatus: 'EJECUTADA', userId: req.user.sub });
  res.json({ message: 'OS verificada y cerrada (EJECUTADA).', data: orden });
}));

// M7 · Verificación — Rechazar → PROGRAMADA (motivo obligatorio)
router.post('/:id/reject', requireRole('admin'), asyncHandler(async (req, res) => {
  const { motivo } = req.body || {};
  if (!motivo || !motivo.trim()) throw badRequest('El motivo del rechazo es obligatorio');
  const orden = await changeStatus({ orderId: req.params.id, newStatus: 'PROGRAMADA', userId: req.user.sub, motivo });
  // Reabrir enlace público para re-cargar soportes.
  await pool.query(`UPDATE sst.enlaces_publicos SET activo=true WHERE orden_id=$1`, [req.params.id]);
  if (orden.profesional_asignado_id) {
    const prof = await pool.query(`SELECT usuario_id FROM sst.profesionales WHERE id=$1`, [orden.profesional_asignado_id]);
    if (prof.rows[0]?.usuario_id) {
      await notify({ userId: prof.rows[0].usuario_id, tipo: 'RECHAZO', titulo: 'Soportes rechazados', mensaje: motivo, datos: { orden_id: orden.id } });
    }
  }
  res.json({ message: 'Soportes rechazados; OS vuelve a PROGRAMADA.', data: orden });
}));

// EST-04 · Cancelar (motivo obligatorio)
router.post('/:id/cancel', requireRole('admin'), asyncHandler(async (req, res) => {
  const { motivo } = req.body || {};
  if (!motivo || !motivo.trim()) throw badRequest('El motivo de cancelación es obligatorio');
  const orden = await changeStatus({ orderId: req.params.id, newStatus: 'CANCELADA', userId: req.user.sub, motivo });
  res.json({ message: 'OS cancelada.', data: orden });
}));

// EST-02 · Cambio de estado genérico (admin) — respeta la matriz de transiciones.
router.post('/:id/status', requireRole('admin'), asyncHandler(async (req, res) => {
  const estado = req.body?.estado || req.body?.status;
  const { motivo } = req.body || {};
  if (!estado) throw badRequest('estado es obligatorio');
  const orden = await changeStatus({ orderId: req.params.id, newStatus: estado, userId: req.user.sub, motivo });
  res.json({ data: orden });
}));

export default router;
