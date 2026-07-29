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
import { enviarEncuesta } from '../surveys/surveys.service.js';

const router = Router();
router.use(authRequired);

/**
 * ENC-01 · Dispara la encuesta de satisfacción cuando una OS queda EJECUTADA.
 *
 * Se llama DESPUÉS de cerrar el cambio de estado y nunca lanza: el correo al
 * cliente es un efecto secundario del cierre, no parte de él. Si el SMTP falla,
 * la OS igual queda verificada y el administrador puede reintentar con
 * `POST /surveys/:ordenId/send`.
 */
async function encuestaAlCerrar(orden) {
  if (orden?.estado !== 'EJECUTADA') return null;
  const r = await enviarEncuesta(orden.id);
  if (!r.enviada) console.warn(`[encuesta] ${orden.codigo}: ${r.motivo}`);
  return r;
}

/**
 * Fecha/hora legible para el usuario final (correo y auditoría).
 *
 * La zona va fija en Colombia a propósito: `toLocaleString` usa la zona del
 * proceso, así que un despliegue en un VPS en UTC le enviaría al profesional
 * una hora de visita corrida cinco horas.
 */
function fechaCO(valor) {
  if (!valor) return 'por definir';
  return new Date(valor).toLocaleString('es-CO', { timeZone: 'America/Bogota' });
}

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

/**
 * M5 · Asignar profesional + fecha/hora → PROGRAMADA + genera PDFs + correo.
 *
 * ASG-07 · La misma ruta reprograma: si la OS ya está PROGRAMADA se admite
 * cambiar profesional y/o fecha, se regeneran los formatos y se reenvía todo.
 * En ese caso no hay transición de estado que registrar (sigue PROGRAMADA), así
 * que la trazabilidad se escribe a mano en el historial.
 */
router.post('/:id/assign', requireRole('admin'), asyncHandler(async (req, res) => {
  const profesionalId = req.body?.profesional_id || req.body?.professional_id;
  const fechaProgramada = req.body?.fecha_programada || req.body?.scheduled_at || null;
  if (!profesionalId) throw badRequest('profesional_id es obligatorio');

  const result = await withTransaction(async (client) => {
    const prof = await client.query(`SELECT * FROM sst.profesionales WHERE id=$1`, [profesionalId]);
    if (!prof.rows[0]) throw badRequest('Profesional no existe');
    if (prof.rows[0].estado !== 'Activo') throw badRequest('El profesional está Inactivo');

    // Se bloquea la fila para que dos asignaciones simultáneas no se pisen.
    const actual = await client.query(
      `SELECT estado::text AS estado, profesional_asignado_id, fecha_programada
         FROM sst.ordenes_servicio WHERE id=$1 FOR UPDATE`,
      [req.params.id]
    );
    if (!actual.rows[0]) throw badRequest('OS no encontrada');
    const estadoPrevio = actual.rows[0].estado;
    const esReprogramacion = estadoPrevio === 'PROGRAMADA';
    if (estadoPrevio !== 'SIN PROGRAMAR' && !esReprogramacion) {
      throw badRequest(
        `Una OS en estado ${estadoPrevio} no se puede asignar ni reprogramar.`
      );
    }

    await client.query(
      `UPDATE sst.ordenes_servicio SET profesional_asignado_id=$2, fecha_programada=$3 WHERE id=$1`,
      [req.params.id, profesionalId, fechaProgramada]
    );

    if (esReprogramacion) {
      // EST-03 · La reprogramación no cambia el estado, pero sí debe quedar en
      // la auditoría: sin esto, mover la visita de fecha sería invisible.
      const cambioProf = actual.rows[0].profesional_asignado_id !== profesionalId;
      await client.query(
        `INSERT INTO sst.historial_estados_orden (orden_id, estado_anterior, estado_nuevo, cambiado_por, motivo)
         VALUES ($1,'PROGRAMADA','PROGRAMADA',$2,$3)`,
        [
          req.params.id, req.user.sub,
          `Reprogramación: ${cambioProf ? 'cambio de profesional y ' : ''}nueva fecha ` +
          `${fechaCO(fechaProgramada)}.`,
        ]
      );
    } else {
      // EST · SIN PROGRAMAR → PROGRAMADA (valida transición + auditoría).
      await changeStatus({ orderId: req.params.id, newStatus: 'PROGRAMADA', userId: req.user.sub }, client);
    }

    // FOR · genera formatos auto-diligenciados (al reprogramar salen con los datos nuevos).
    const docs = await generateOrderDocuments(req.params.id, client);

    // Enlace público de soportes (M6). Al reprogramar se conserva el enlace
    // vigente: emitir uno nuevo invalidaría el que ya se le envió al profesional.
    const vigente = await client.query(
      `SELECT token FROM sst.enlaces_publicos WHERE orden_id=$1 AND activo ORDER BY creado_en DESC LIMIT 1`,
      [req.params.id]
    );
    let token = vigente.rows[0]?.token;
    if (!token) {
      token = randomToken(24);
      await client.query(
        `INSERT INTO sst.enlaces_publicos (orden_id, token) VALUES ($1,$2)`,
        [req.params.id, token]
      );
    }

    const orden = await getOrderExpanded(req.params.id, client);
    return { orden, profesional: prof.rows[0], docs, token, esReprogramacion };
  });

  // ASG-03/04/07 · correo al profesional con PDFs + notificación interna.
  //
  // Va FUERA de la transacción, así que a esta altura la asignación ya está
  // confirmada en BD: si el correo falla, la respuesta no puede ser un error —
  // el administrador creería que no se asignó y lo intentaría de nuevo. Se
  // responde 200 avisando que el envío quedó pendiente.
  const supportUrl = `${env.publicAppUrl}/soporte?token=${result.token}`;
  const fecha = fechaCO(result.orden.fecha_programada);
  let correoEnviado = true;
  let correoError = null;
  try {
    await sendEmail({
      to: result.profesional.correo,
      subject: result.esReprogramacion
        ? `OS reprogramada · ${result.orden.codigo} · ${result.orden.empresa_nombre || ''}`
        : `Nueva OS asignada · ${result.orden.codigo} · ${result.orden.empresa_nombre || ''}`,
      text:
        `Hola ${result.profesional.nombre},\n\n` +
        (result.esReprogramacion
          ? `La OS ${result.orden.codigo} (${result.orden.arl_nombre}) para ${result.orden.empresa_nombre} ` +
            `fue REPROGRAMADA.\n`
          : `Se te asignó la OS ${result.orden.codigo} (${result.orden.arl_nombre}) para ` +
            `${result.orden.empresa_nombre}.\n`) +
        `Fecha programada: ${fecha}\n` +
        `Horas: ${result.orden.horas_asignadas || '—'}\n\n` +
        `Adjuntamos los formatos para diligenciar y firmar.\n\n` +
        `Al terminar, sube los soportes firmados aquí (sin login):\n${supportUrl}\n`,
      attachments: result.docs.map((d) => ({ filename: d._filename, content: d._buffer })),
    });
  } catch (e) {
    correoEnviado = false;
    correoError = e?.message || 'No fue posible entregar el correo.';
    console.error('[assign] correo no enviado:', correoError);
  }

  // La campanita es informativa: tampoco debe tumbar una asignación válida.
  if (result.profesional.usuario_id) {
    try {
      await notify({
        userId: result.profesional.usuario_id,
        tipo: result.esReprogramacion ? 'REPROGRAMACION' : 'ASIGNACION',
        titulo: result.esReprogramacion ? 'OS reprogramada' : 'Nueva OS asignada',
        mensaje: `${result.orden.codigo} · ${result.orden.empresa_nombre || ''} · ${fecha}`,
        datos: { orden_id: result.orden.id },
      });
    } catch (e) {
      console.error('[assign] notificación interna no creada:', e?.message);
    }
  }

  const accion = result.esReprogramacion ? 'reprogramada' : 'asignada';
  res.json({
    message: correoEnviado
      ? `OS ${accion}, formatos generados y correo enviado.`
      : `OS ${accion} y formatos generados, pero el correo al profesional no salió.`,
    correo_enviado: correoEnviado,
    correo_error: correoError,
    data: { ...result.orden, support_url: supportUrl, documentos: result.docs.map(({ _buffer, ...d }) => d) },
  });
}));

/**
 * RPT-06 · Marca (o desmarca) la facturación y la validación de la ARL.
 *
 * Es un dato que entra de afuera —lo confirma quien factura o quien habla con
 * la ARL—, así que se registra a mano. Ambos campos son opcionales: se actualiza
 * solo el que venga en el cuerpo, para poder marcar uno sin pisar el otro.
 */
router.patch('/:id/cartera', requireRole('admin', 'contador'), asyncHandler(async (req, res) => {
  const { facturado, validado_arl: validadoArl } = req.body || {};
  if (facturado === undefined && validadoArl === undefined) {
    throw badRequest('Indique "facturado" y/o "validado_arl" (true o false)');
  }
  const sets = ['cartera_marcada_por = $2'];
  const params = [req.params.id, req.user.sub];
  if (facturado !== undefined) sets.push(`facturado_en = ${facturado ? 'now()' : 'NULL'}`);
  if (validadoArl !== undefined) sets.push(`validado_arl_en = ${validadoArl ? 'now()' : 'NULL'}`);

  const r = await pool.query(
    `UPDATE sst.ordenes_servicio SET ${sets.join(', ')} WHERE id=$1
     RETURNING id, codigo, facturado_en, validado_arl_en`,
    params
  );
  if (!r.rows[0]) throw badRequest('OS no encontrada');
  res.json({ data: r.rows[0] });
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
  const encuesta = await encuestaAlCerrar(orden); // ENC-01
  res.json({
    message: encuesta?.enviada
      ? 'OS verificada y cerrada (EJECUTADA). Se envió la encuesta de satisfacción al cliente.'
      : 'OS verificada y cerrada (EJECUTADA).',
    encuesta_enviada: !!encuesta?.enviada,
    encuesta_error: encuesta?.enviada ? null : encuesta?.motivo ?? null,
    data: orden,
  });
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
  // ENC-01 · Cerrar la OS a mano también dispara la encuesta: el disparador es
  // el estado EJECUTADA, no la pantalla desde la que se llegó a él.
  const encuesta = await encuestaAlCerrar(orden);
  res.json({
    encuesta_enviada: !!encuesta?.enviada,
    encuesta_error: encuesta && !encuesta.enviada ? encuesta.motivo : null,
    data: orden,
  });
}));

export default router;
