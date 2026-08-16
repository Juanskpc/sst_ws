import { Router } from 'express';
import { pool, withTransaction } from '../../config/db.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authRequired, requireRole } from '../../middleware/auth.js';
import { badRequest } from '../../utils/httpError.js';
import { getOrderExpanded, changeStatus, generateOrderDocuments, profesionalDeUsuario } from './orders.service.js';
import { randomToken } from '../../utils/security.js';
import { env } from '../../config/env.js';
import { sendEmail } from '../../services/email.service.js';
import { notify } from '../../services/notification.service.js';
import { enviarEncuesta } from '../surveys/surveys.service.js';
import { construirInvitaciones, adjuntosInvitacion } from '../../services/calendar.service.js';
import {
  correoHtml, parrafo, tablaDatos, filaDato, bloqueFranjas, bloqueAviso, boton, enlaceCrudo,
} from '../../services/email-layout.service.js';
import { fechaDiaCO, fechaHoraCO, horaAmPm, horasTexto } from '../../utils/formato.js';

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
 * Fecha/hora legible para el usuario final (correo y auditoría): 'vie 14 ago
 * 2026 · 02:00 PM'. El formato vive en `utils/formato.js` porque el correo, la
 * invitación y los PDF adjuntos tienen que decir la misma hora igual escrita.
 */
function fechaCO(valor) {
  if (!valor) return 'por definir';
  return fechaHoraCO(valor);
}

const FRANJA_COLS = `id, orden_id,
  to_char(fecha, 'YYYY-MM-DD') AS fecha,
  to_char(hora_inicio, 'HH24:MI') AS hora_inicio,
  to_char(hora_fin, 'HH24:MI')    AS hora_fin`;

/**
 * ASG-02 · Valida y ordena las franjas de una visita.
 *
 * Una visita se puede partir (mañana y tarde, o varios días), pero dos franjas
 * de la MISMA orden no pueden solaparse: sería pedirle al profesional estar dos
 * veces en el mismo rato. Tocarse en el borde (08:00–12:00 y 12:00–16:00) sí
 * vale. Devuelve [] si no se mandó nada: asignar sin fecha sigue permitido.
 */
function normalizarFranjas(entrada) {
  if (!Array.isArray(entrada)) return [];
  const franjas = entrada.map((f, i) => {
    const fecha = (f?.fecha || '').toString().trim();
    const ini = (f?.hora_inicio || '').toString().trim().slice(0, 5);
    const fin = (f?.hora_fin || '').toString().trim().slice(0, 5);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !/^\d{2}:\d{2}$/.test(ini) || !/^\d{2}:\d{2}$/.test(fin)) {
      throw badRequest(`Franja ${i + 1}: se esperaba fecha (YYYY-MM-DD) y horas (HH:MM).`);
    }
    if (fin <= ini) throw badRequest(`Franja ${i + 1} (${fecha}): la hora de fin debe ser mayor que la de inicio.`);
    return { fecha, hora_inicio: ini, hora_fin: fin };
  });

  franjas.sort((a, b) => (a.fecha + a.hora_inicio).localeCompare(b.fecha + b.hora_inicio));
  for (let i = 1; i < franjas.length; i++) {
    const prev = franjas[i - 1];
    const act = franjas[i];
    if (prev.fecha === act.fecha && act.hora_inicio < prev.hora_fin) {
      throw badRequest(
        `Las franjas del ${act.fecha} se cruzan (${prev.hora_inicio}–${prev.hora_fin} y ${act.hora_inicio}–${act.hora_fin}).`
      );
    }
  }
  return franjas;
}

/**
 * 'YYYY-MM-DD' + 'HH:MM' de Colombia → instante ISO.
 *
 * El desfase va explícito (-05:00, Colombia no tiene horario de verano) y no
 * por `new Date('...T08:00')`, que usa la zona del PROCESO: en un servidor en
 * UTC esa lectura correría la visita cinco horas.
 */
function instanteCO(fecha, hora) {
  return new Date(`${fecha}T${hora}:00-05:00`).toISOString();
}

/** Franjas de una orden, ya ordenadas. */
async function franjasDeOrden(ordenId, client = pool) {
  const r = await client.query(
    `SELECT ${FRANJA_COLS} FROM sst.franjas_visita
      WHERE orden_id=$1 ORDER BY fecha, hora_inicio`,
    [ordenId]
  );
  return r.rows;
}

/** 'HH:MM' → minutos desde medianoche. */
function aMinutos(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
}

/** Minutos que suman las franjas de una visita. */
function minutosDeFranjas(franjas) {
  return franjas.reduce((t, f) => t + (aMinutos(f.hora_fin) - aMinutos(f.hora_inicio)), 0);
}

/**
 * ASG-02 · ¿Las franjas cubren exactamente las horas contratadas con la ARL?
 *
 * Es la condición para que la OS pase a PROGRAMADA: una visita a medio repartir
 * sigue SIN PROGRAMAR, porque todavía le faltan horas por acordar y sacarla del
 * grupo de pendientes la haría desaparecer de la bandeja de trabajo.
 *
 * `horas_asignadas` llega como texto ("8.00") porque es NUMERIC (ver trampa 18).
 * Si la OS no trae horas no hay objetivo contra el que comparar, así que basta
 * con que haya al menos una franja.
 */
function cuadranLasHoras(franjas, horasAsignadas) {
  const objetivo = Math.round(Number(horasAsignadas ?? 0) * 60);
  if (!Number.isFinite(objetivo) || objetivo <= 0) return franjas.length > 0;
  return minutosDeFranjas(franjas) === objetivo;
}

/** "jue 14 ago 2026, de 08:00 AM a 12:00 PM" — una franja, ya legible. */
function franjaEnTexto(f) {
  return `${fechaDiaCO(f.fecha)}, de ${horaAmPm(f.hora_inicio)} a ${horaAmPm(f.hora_fin)}`;
}

/** La visita franja a franja, con viñeta, para la versión en texto plano. */
function franjasEnTexto(franjas) {
  return franjas.map((f) => `  · ${franjaEnTexto(f)}`).join('\n');
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

/**
 * ASG-08 · "Mis órdenes": las de quien está autenticado, sin poder pedir las de
 * otro.
 *
 * Va deliberadamente ANTES de `/:id`: Express resuelve por orden de
 * declaración y `/orders/mias` encajaría en el comodín, que trataría "mias"
 * como un UUID y respondería un 500 de Postgres.
 *
 * El acote es del servidor, no del cliente: `GET /orders?profesional_id=...`
 * acepta cualquier id, así que un profesional podría listar las órdenes de un
 * compañero cambiando el parámetro. Aquí el id sale de la sesión.
 */
router.get('/mias', asyncHandler(async (req, res) => {
  const profesional = await profesionalDeUsuario(req.user);
  if (!profesional) {
    // 200 y no 404: la cuenta es válida, lo que falta es la ficha enlazada.
    // La vista lo explica y pide que un administrador la enlace.
    return res.json({
      data: [],
      profesional: null,
      motivo: 'Esta cuenta no tiene una ficha de profesional enlazada. Pida a un administrador que la asocie desde Profesionales.',
    });
  }
  const estado = req.query.estado;
  const params = [profesional.id];
  let filtroEstado = '';
  if (estado) {
    params.push(estado);
    filtroEstado = ` AND o.estado = $${params.length}::sst.estado_orden`;
  }
  const r = await pool.query(
    `SELECT o.*,
            -- SUP-07 · Los soportes que YA envió por el enlace público, para que
            -- pueda comprobar qué mandó sin tener que buscar el correo. Va como
            -- subconsulta agregada y no como JOIN para no multiplicar la orden
            -- por cada archivo.
            COALESCE((
              SELECT json_agg(json_build_object(
                       'id', s.id,
                       'nombre', s.nombre_original,
                       'subido_en', s.subido_en
                     ) ORDER BY s.subido_en DESC)
                FROM sst.archivos_soporte s
               WHERE s.orden_id = o.id
            ), '[]'::json) AS soportes,
            -- ASG-02 · Las franjas de la visita: al profesional le sirve más
            -- "jueves de 8 a 12 y viernes de 8 a 12" que un único instante.
            COALESCE((
              SELECT json_agg(json_build_object(
                       'id', v.id,
                       'fecha', to_char(v.fecha, 'YYYY-MM-DD'),
                       'hora_inicio', to_char(v.hora_inicio, 'HH24:MI'),
                       'hora_fin', to_char(v.hora_fin, 'HH24:MI')
                     ) ORDER BY v.fecha, v.hora_inicio)
                FROM sst.franjas_visita v
               WHERE v.orden_id = o.id
            ), '[]'::json) AS franjas
       FROM sst.vw_ordenes_expandidas o
      WHERE o.profesional_asignado_id = $1${filtroEstado}
      -- Primero lo que aún tiene que ejecutar y por fecha de visita: es una
      -- agenda, no un histórico. Las ya cerradas caen al final.
      ORDER BY (o.estado = 'PROGRAMADA') DESC,
               o.fecha_programada ASC NULLS LAST,
               o.fecha_carga DESC
      LIMIT 200`,
    params
  );
  res.json({
    data: r.rows,
    profesional: { id: profesional.id, nombre: profesional.nombre },
  });
}));

// Detalle completo: OS + historial + documentos + soportes + enlace público.
router.get('/:id', asyncHandler(async (req, res) => {
  const orden = await getOrderExpanded(req.params.id);
  const [historial, docs, soportes, enlace, franjas] = await Promise.all([
    pool.query(
      `SELECT h.*, u.nombre AS cambiado_por_nombre FROM sst.historial_estados_orden h
       LEFT JOIN sst.usuarios u ON u.id = h.cambiado_por
       WHERE h.orden_id=$1 ORDER BY h.cambiado_en`, [req.params.id]),
    pool.query(`SELECT * FROM sst.documentos_generados WHERE orden_id=$1 ORDER BY generado_en`, [req.params.id]),
    pool.query(`SELECT * FROM sst.archivos_soporte WHERE orden_id=$1 ORDER BY subido_en`, [req.params.id]),
    pool.query(`SELECT * FROM sst.enlaces_publicos WHERE orden_id=$1 AND activo ORDER BY creado_en DESC LIMIT 1`, [req.params.id]),
    franjasDeOrden(req.params.id),
  ]);
  res.json({
    data: {
      ...orden,
      historial: historial.rows,
      documentos: docs.rows,
      soportes: soportes.rows,
      franjas,
      enlace_publico: enlace.rows[0]
        ? { ...enlace.rows[0], url: `${env.publicAppUrl}/soporte?token=${enlace.rows[0].token}` }
        : null,
    },
  });
}));

/**
 * ASG-02 · Franjas en que se ejecuta la visita. Endpoint propio (y no dentro
 * del detalle) porque el modal de asignación se abre desde el listado de
 * borradores, sin haber pedido la OS completa.
 */
router.get('/:id/franjas', asyncHandler(async (req, res) => {
  res.json({ data: await franjasDeOrden(req.params.id) });
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
  if (!profesionalId) throw badRequest('profesional_id es obligatorio');

  // ASG-02 · La visita puede venir partida en franjas (mañana y tarde, o varios
  // días). `fecha_programada` sigue siendo el INICIO de la primera: de ella
  // cuelgan el periodo de la pre-cuenta, la cartera, los reportes y el orden de
  // los listados, así que se deriva aquí en vez de confiar en el cliente.
  const franjas = normalizarFranjas(req.body?.franjas);
  const fechaProgramada = franjas.length
    ? instanteCO(franjas[0].fecha, franjas[0].hora_inicio)
    : req.body?.fecha_programada || req.body?.scheduled_at || null;

  const result = await withTransaction(async (client) => {
    const prof = await client.query(`SELECT * FROM sst.profesionales WHERE id=$1`, [profesionalId]);
    if (!prof.rows[0]) throw badRequest('Profesional no existe');
    if (prof.rows[0].estado !== 'Activo') throw badRequest('El profesional está Inactivo');

    // Se bloquea la fila para que dos asignaciones simultáneas no se pisen.
    const actual = await client.query(
      `SELECT estado::text AS estado, profesional_asignado_id, fecha_programada, horas_asignadas
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

    // ASG-02 · Nunca más horas de las contratadas con la ARL. La pre-cuenta (M9)
    // valora `horas_asignadas`, así que programar de más es trabajo que no se
    // factura; el modal ya lo impide, esto cierra la puerta por si acaso.
    const horasOrden = actual.rows[0].horas_asignadas;
    const objetivoMin = Math.round(Number(horasOrden ?? 0) * 60);
    if (franjas.length && objetivoMin > 0 && minutosDeFranjas(franjas) > objetivoMin) {
      throw badRequest(
        `Las franjas suman ${horasTexto(minutosDeFranjas(franjas) / 60)} y la orden tiene ` +
        `${horasTexto(horasOrden)} asignadas. Quite horas antes de guardar.`
      );
    }
    // Solo se programa cuando la visita está repartida por completo.
    const completa = cuadranLasHoras(franjas, horasOrden);

    // ASG-05 · La secuencia sube en el mismo UPDATE que la fecha: si se llevara
    // aparte, dos reprogramaciones seguidas podrían mandar el mismo SEQUENCE y
    // el calendario del profesional ignoraría la segunda.
    const guardada = await client.query(
      `UPDATE sst.ordenes_servicio
          SET profesional_asignado_id=$2,
              fecha_programada=$3,
              secuencia_calendario = secuencia_calendario + 1
        WHERE id=$1
      RETURNING secuencia_calendario`,
      [req.params.id, profesionalId, fechaProgramada]
    );

    // ASG-02 · Las franjas se reemplazan en bloque: reprogramar es volver a
    // decidir toda la visita, y conservar las viejas dejaría horas fantasma en
    // la agenda del profesional. Solo se tocan si el cliente mandó franjas, para
    // no borrar las de una asignación que solo cambia de profesional.
    let franjasPrevias = 0;
    if (franjas.length) {
      const antes = await client.query(
        `DELETE FROM sst.franjas_visita WHERE orden_id=$1 RETURNING id`,
        [req.params.id]
      );
      franjasPrevias = antes.rowCount;
      for (const f of franjas) {
        await client.query(
          `INSERT INTO sst.franjas_visita (orden_id, fecha, hora_inicio, hora_fin, creado_por)
           VALUES ($1,$2,$3,$4,$5)`,
          [req.params.id, f.fecha, f.hora_inicio, f.hora_fin, req.user.sub]
        );
      }
    }

    // EST · El estado lo decide si la visita está COMPLETA, no el hecho de haber
    // elegido profesional: una orden de 10 h con 6 h repartidas sigue teniendo
    // trabajo pendiente y debe seguir apareciendo entre las que hay que programar.
    if (esReprogramacion && completa) {
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
    } else if (esReprogramacion && !completa) {
      // Se le quitaron horas a una visita ya programada: vuelve a la bandeja.
      await changeStatus({
        orderId: req.params.id, newStatus: 'SIN PROGRAMAR', userId: req.user.sub,
        motivo: `Reprogramación incompleta: ${horasTexto(minutosDeFranjas(franjas) / 60)} de ` +
                `${horasTexto(horasOrden)} repartidas.`,
      }, client);
    } else if (completa) {
      // EST · SIN PROGRAMAR → PROGRAMADA (valida transición + auditoría).
      await changeStatus({ orderId: req.params.id, newStatus: 'PROGRAMADA', userId: req.user.sub }, client);
    }
    // Caso restante (SIN PROGRAMAR + visita incompleta): se guardan profesional y
    // franjas, y la OS se queda donde está a la espera de las horas que faltan.

    // FOR · genera formatos auto-diligenciados (al reprogramar salen con los
    // datos nuevos). Solo si la visita está completa: un formato con media
    // agenda impresa habría que rehacerlo, y quedaría archivado en
    // `documentos_generados` como si fuera bueno.
    const docs = completa ? await generateOrderDocuments(req.params.id, client) : [];

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
    return {
      orden, profesional: prof.rows[0], docs, token, esReprogramacion, completa,
      secuenciaCalendario: guardada.rows[0].secuencia_calendario,
      franjas: await franjasDeOrden(req.params.id, client),
      franjasPrevias,
    };
  });

  // Visita a medio repartir: se guarda el avance, pero no se avisa a nadie. Un
  // correo con media agenda mandaría al profesional a una visita que todavía se
  // está armando, y el .ics le ocuparía unas horas que aún pueden cambiar.
  if (!result.completa) {
    return res.json({
      message: 'Se guardó el avance de la programación. La orden sigue SIN PROGRAMAR hasta ' +
               'repartir todas sus horas; el profesional no ha sido notificado.',
      data: {
        orden: result.orden,
        franjas: result.franjas,
        completa: false,
        correo_enviado: false,
        formatos_generados: 0,
      },
    });
  }

  // ASG-03/04/07 · correo al profesional con PDFs + notificación interna.
  //
  // Va FUERA de la transacción, así que a esta altura la asignación ya está
  // confirmada en BD: si el correo falla, la respuesta no puede ser un error —
  // el administrador creería que no se asignó y lo intentaría de nuevo. Se
  // responde 200 avisando que el envío quedó pendiente.
  const supportUrl = `${env.publicAppUrl}/soporte?token=${result.token}`;
  const fecha = fechaCO(result.orden.fecha_programada);

  // ASG-05 · Invitaciones de calendario, UNA POR FRANJA. Arreglo vacío si la OS
  // se asignó sin fecha, que está permitido: se puede decidir el profesional
  // antes que el día.
  const invitaciones = adjuntosInvitacion(construirInvitaciones({
    orden: result.orden,
    profesional: result.profesional,
    organizador: { nombre: req.user.nombre, correo: req.user.correo },
    secuencia: result.secuenciaCalendario,
    franjas: result.franjas,
    previas: result.franjasPrevias,
  }));

  const o = result.orden;
  const esRepro = result.esReprogramacion;
  const varias = result.franjas.length > 1;
  const lugar = [o.direccion, o.ciudad_ejecucion].filter(Boolean).join(', ');
  const contacto = [o.contacto_sst_nombre, o.contacto_sst_telefono].filter(Boolean).join(' · ');
  const sinFormatos = !result.docs.length;

  let correoEnviado = true;
  let correoError = null;
  try {
    await sendEmail({
      to: result.profesional.correo,
      // El administrador que asigna va en copia para que la invitación entre
      // también en SU calendario: el requisito pide los dos, no solo el asesor.
      cc: req.user.correo || undefined,
      subject: esRepro
        ? `OS reprogramada · ${o.codigo} · ${o.empresa_nombre || ''}`
        : `Nueva OS asignada · ${o.codigo} · ${o.empresa_nombre || ''}`,
      // La versión en texto se conserva íntegra: es lo que ve quien lee en texto
      // plano y lo que queda en los registros del driver 'console'.
      text:
        `Hola ${result.profesional.nombre},\n\n` +
        (esRepro
          ? `La OS ${o.codigo} (${o.arl_nombre}) para ${o.empresa_nombre} fue REPROGRAMADA.\n`
          : `Se te asignó la OS ${o.codigo} (${o.arl_nombre}) para ${o.empresa_nombre}.\n`) +
        // Con la visita partida, una sola "fecha programada" se queda corta: lo
        // que el profesional necesita saber es cada franja.
        (varias
          ? `La visita se realiza en ${result.franjas.length} franjas:\n${franjasEnTexto(result.franjas)}\n`
          : `Fecha programada: ${fecha}\n`) +
        `Horas: ${horasTexto(o.horas_asignadas)}\n` +
        (lugar ? `Lugar: ${lugar}\n` : '') +
        (contacto ? `Contacto SST: ${contacto}\n` : '') +
        '\n' +
        // Sin plantillas activas para la ARL no hay PDFs que adjuntar (CFG-03):
        // prometer unos formatos que no van deja al profesional buscándolos.
        (sinFormatos
          ? `Los formatos de esta ARL todavía no están cargados en la plataforma; ` +
            `te los haremos llegar aparte.\n\n`
          : `Adjuntamos los formatos para diligenciar y firmar.\n\n`) +
        `Al terminar, sube los soportes firmados aquí (sin login):\n${supportUrl}\n` +
        (invitaciones.length
          ? `\nAdjuntamos ${invitaciones.length === 1 ? 'la invitación' : `${invitaciones.length} invitaciones`} para tu calendario.\n`
          : ''),
      html: correoHtml({
        titulo: esRepro ? 'Visita reprogramada' : 'Nueva orden de servicio asignada',
        subtitulo: `${o.codigo} · ${o.empresa_nombre || ''}`,
        pie: 'JD&D Consultores · Seguridad y Salud en el Trabajo',
        cuerpo: [
          parrafo(`Hola ${result.profesional.nombre},`),
          parrafo(
            esRepro
              ? `La visita de esta orden cambió de programación. Estos son los datos vigentes; ` +
                `los anteriores ya no aplican.`
              : `Te asignamos la siguiente orden de servicio. Abajo tienes los formatos y el ` +
                `enlace para subir los soportes al terminar.`,
          ),
          tablaDatos([
            filaDato('Orden', o.codigo),
            filaDato('ARL', o.arl_nombre),
            filaDato('Empresa', o.empresa_nombre),
            filaDato('Horas', horasTexto(o.horas_asignadas)),
            filaDato('Lugar', lugar),
            filaDato('Contacto SST', contacto),
          ]),
          // Con una sola franja el bloque igual se usa: es donde el ojo va a
          // buscar el cuándo, y mantenerlo evita dos maquetas distintas.
          bloqueFranjas(
            varias ? `La visita se realiza en ${result.franjas.length} franjas` : 'Fecha de la visita',
            result.franjas.length ? result.franjas.map(franjaEnTexto) : [fecha],
          ),
          sinFormatos
            ? bloqueAviso(
                'Los formatos de esta ARL todavía no están cargados en la plataforma. ' +
                'Te los haremos llegar aparte.',
              )
            : parrafo('Adjuntamos los formatos para diligenciar y firmar.'),
          parrafo('Cuando termines la visita, sube los soportes firmados desde aquí (no necesitas iniciar sesión):'),
          boton('Subir soportes firmados', supportUrl),
          enlaceCrudo(supportUrl),
        ].join(''),
      }),
      attachments: [
        ...result.docs.map((d) => ({ filename: d._filename, content: d._buffer })),
        ...invitaciones,
      ],
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
    // CFG-03 · Cuántos formatos salieron adjuntos. En cero el correo llegó sin
    // documentos porque la ARL no tiene plantillas activas, y eso hay que
    // decírselo a quien asigna: es un vacío de configuración, no del envío.
    formatos_generados: result.docs.length,
    data: {
      ...result.orden,
      support_url: supportUrl,
      documentos: result.docs.map(({ _buffer, ...d }) => d),
      franjas: result.franjas,
    },
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

/**
 * M7 · Verificación — Aceptar los soportes.
 *
 * Ya no cambia el estado: al eliminarse EN VERIFICACIÓN, la OS quedó EJECUTADA
 * en cuanto el profesional subió los archivos. Lo que hace este paso es dejar
 * constancia de que un administrador los REVISÓ y los da por buenos, y recién
 * ahí se le manda la encuesta al cliente (ENC-01) — antes de la revisión sería
 * preguntarle por una visita que todavía nadie ha comprobado.
 */
router.post('/:id/verify', requireRole('admin'), asyncHandler(async (req, res) => {
  const r = await pool.query(
    `SELECT estado::text AS estado FROM sst.ordenes_servicio WHERE id=$1`, [req.params.id]
  );
  if (!r.rows[0]) throw badRequest('OS no encontrada');
  if (r.rows[0].estado !== 'EJECUTADA') {
    throw badRequest(
      `Solo se pueden aceptar los soportes de una OS EJECUTADA; esta está ${r.rows[0].estado}.`
    );
  }

  // EST-03 · La aceptación es un hecho auditable aunque no mueva el estado.
  await pool.query(
    `INSERT INTO sst.historial_estados_orden (orden_id, estado_anterior, estado_nuevo, cambiado_por, motivo)
     VALUES ($1,'EJECUTADA','EJECUTADA',$2,'Soportes revisados y aceptados')`,
    [req.params.id, req.user.sub]
  );

  const orden = await getOrderExpanded(req.params.id);
  const encuesta = await encuestaAlCerrar(orden); // ENC-01
  res.json({
    message: encuesta?.enviada
      ? 'Soportes aceptados. Se envió la encuesta de satisfacción al cliente.'
      : 'Soportes aceptados.',
    encuesta_enviada: !!encuesta?.enviada,
    encuesta_error: encuesta?.enviada ? null : encuesta?.motivo ?? null,
    data: orden,
  });
}));

/**
 * M7 · Verificación — Rechazar los soportes: EJECUTADA → PROGRAMADA.
 *
 * Es la única transición que retrocede, y por eso existe: sin ella, eliminar
 * EN VERIFICACIÓN dejaría al administrador sin forma de devolverle el trabajo al
 * profesional. Diverge de EST-06 (que prohibía salir de EJECUTADA) a propósito.
 */
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

// La ruta POST /:id/cancel se eliminó junto con el estado CANCELADA. Una orden
// que la ARL anula se DESHABILITA desde la bandeja (soft-delete del borrador),
// que es lo que el cliente pidió: un solo sitio donde sacar órdenes de circulación.

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
