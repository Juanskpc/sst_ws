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
  correoHtml, parrafo, tablaDatos, filaDato, bloqueLista, bloqueAviso, boton, enlaceCrudo,
} from '../../services/email-layout.service.js';
import { fechaDiaCO, fechaHoraCO, horaAmPm, horasTexto } from '../../utils/formato.js';
import { parseNumeroCO, parseFechaCO } from '../../utils/parseo.js';
import { resolverEmpresaId } from '../companies/companies.service.js';
import {
  CATEGORIAS_SOPORTE, esCategoriaValida, listaEtiquetas, normalizarCategoria,
} from '../../services/soportes.service.js';

const router = Router();
router.use(authRequired);

/**
 * PRE-02 · Qué valor hora le corresponde a una orden con este profesional.
 *
 * Orden de resolución, de lo más específico a lo más general:
 *   1. tarifa del PROFESIONAL para ese tipo de orden (la excepción negociada),
 *   2. valor hora del TIPO DE ORDEN (el catálogo de Configuración, el camino
 *      normal desde que la categoría es obligatoria),
 *   3. valor hora base del profesional (lo que había antes de todo esto).
 *
 * Devuelve también el origen para poder explicar la cifra en pantalla — "85.000
 * por ser Capacitación" se entiende; "85.000" a secas, no.
 */
async function valorHoraDeOrden({ ordenId, profesional }, client) {
  const r = await client.query(
    `SELECT t.id, t.nombre, t.valor_hora
       FROM sst.ordenes_servicio o
       LEFT JOIN sst.tipos_orden t ON t.id = o.tipo_orden_id
      WHERE o.id = $1`,
    [ordenId]
  );
  const tipo = r.rows[0];

  if (tipo?.nombre) {
    const propia = await client.query(
      `SELECT valor_hora FROM sst.tarifas_actividad_profesional
        WHERE profesional_id=$1 AND lower(actividad)=lower($2) AND vigente_desde <= CURRENT_DATE
        ORDER BY vigente_desde DESC LIMIT 1`,
      [profesional.id, tipo.nombre]
    );
    if (propia.rows[0]) {
      return { valorHora: Number(propia.rows[0].valor_hora), origen: 'tarifa' };
    }
  }
  if (Number(tipo?.valor_hora) > 0) {
    return { valorHora: Number(tipo.valor_hora), origen: 'tipo' };
  }
  return { valorHora: Number(profesional.valor_hora) || 0, origen: 'profesional' };
}

/**
 * ENC-01 · Dispara la encuesta de satisfacción cuando una OS queda FINALIZADA.
 *
 * El disparador es el cierre REAL del ciclo, no la subida de soportes: mandarla
 * al pasar a EJECUTADA sería preguntarle al cliente por una visita cuyos
 * documentos todavía no ha mirado nadie.
 *
 * Se llama DESPUÉS de cerrar el cambio de estado y nunca lanza: el correo al
 * cliente es un efecto secundario del cierre, no parte de él. Si el SMTP falla,
 * la OS igual queda finalizada y el administrador puede reintentar con
 * `POST /surveys/:ordenId/send`.
 */
async function encuestaAlCerrar(orden) {
  if (orden?.estado !== 'FINALIZADA') return null;
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
 * Columnas de la OS que la vista Órdenes deja corregir, y cómo se convierte
 * cada una antes de guardarla.
 *
 * Es una lista blanca a propósito: el resto de columnas tiene dueño y no se
 * toca por aquí. `estado` se mueve con `POST /:id/status` (que valida la
 * transición y deja auditoría), y el profesional y la fecha programada, con
 * `POST /:id/assign` (que además regenera formatos y reenvía el correo).
 * Dejarlas entrar en un UPDATE plano sería saltarse las dos cosas.
 */
const CAMPOS_EDITABLES = {
  numero_orden: String,
  codigo_cronograma: String,
  secuencia: String,
  nro_afiliacion: String,
  nit_nic: String,
  empresa_nombre: String,
  actividad_economica: String,
  tipo_actividad: String,
  modalidad: String,
  ciudad_ejecucion: String,
  direccion: String,
  descripcion: String,
  contacto_empresa_nombre: String,
  contacto_empresa_cargo: String,
  contacto_empresa_telefono: String,
  contacto_sst_nombre: String,
  contacto_sst_telefono: String,
  contacto_sst_correo: String,
  horas_asignadas: parseNumeroCO,
  valor_unitario: parseNumeroCO,
  valor_total: parseNumeroCO,
  fecha_orden: parseFechaCO,
  fecha_vencimiento: parseFechaCO,
  // CFG-04 · La categoría con la que se cobra. Es un id del catálogo, así que se
  // guarda tal cual (el conversor de String lo dejaría igual, pero nombrarlo
  // aparte deja claro que no es texto libre).
  tipo_orden_id: (v) => (String(v ?? '').trim() || null),
};

/** Texto del formulario → lo que va a la columna ('' se guarda como NULL). */
function valorEditable(campo, bruto) {
  const conversor = CAMPOS_EDITABLES[campo];
  if (conversor !== String) return conversor(bruto);
  const s = String(bruto ?? '').trim();
  return s === '' ? null : s;
}

/**
 * Corrección de los datos de una OS ya materializada, en CUALQUIER estado.
 *
 * Antes solo se podía corregir el borrador y únicamente mientras seguía sin
 * validar: en cuanto la OS existía, el dato malo se quedaba dentro para siempre
 * —el borrador ya no es la fuente de verdad, así que editarlo no cambiaba nada
 * (`PUT /drafts/:id` responde 409 justo por eso)—. Un teléfono mal leído por el
 * OCR se descubre casi siempre DESPUÉS, cuando hay que llamar al contacto.
 *
 * Editar no mueve el ciclo de vida: una OS EJECUTADA sigue EJECUTADA. Lo que sí
 * se rehace es el enlace con el maestro de empresas (CFG-02), porque corregir el
 * NIT o la razón social suele ser precisamente lo que arregla una OS colgada de
 * la ficha equivocada.
 */
router.put('/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const body = req.body || {};
  const campos = Object.keys(CAMPOS_EDITABLES).filter((c) => c in body);
  if (!campos.length) throw badRequest('No se envió ningún campo editable de la orden');

  const orden = await withTransaction(async (client) => {
    const actual = (await client.query(
      `SELECT * FROM sst.ordenes_servicio WHERE id=$1 FOR UPDATE`, [req.params.id]
    )).rows[0];
    if (!actual) throw badRequest('Orden de servicio no encontrada');

    const valores = {};
    for (const campo of campos) valores[campo] = valorEditable(campo, body[campo]);

    // La identidad de la OS no puede quedar vacía: sin ella no hay forma de
    // reconocerla contra el documento de la ARL ni de detectar duplicados
    // (Bolívar usa cronograma+secuencia; AXA y Colmena, numero_orden).
    const tras = (c) => (c in valores ? valores[c] : actual[c]);
    if (!tras('numero_orden') && !(tras('codigo_cronograma') && tras('secuencia'))) {
      throw badRequest('La OS necesita número de orden, o bien código de cronograma + secuencia');
    }

    // CFG-02 · Si cambió la identidad de la empresa, se recalcula a qué ficha
    // del maestro cuelga la orden (creándola si hace falta, igual que al
    // validar). Los textos de la OS se conservan: son lo que decía el documento.
    if ('nit_nic' in valores || 'empresa_nombre' in valores) {
      valores.empresa_id = await resolverEmpresaId({
        nit: tras('nit_nic'),
        nombre: tras('empresa_nombre'),
        actividad_economica: tras('actividad_economica'),
        ciudad: tras('ciudad_ejecucion'),
        direccion: tras('direccion'),
        contacto_nombre: tras('contacto_empresa_nombre'),
        contacto_cargo: tras('contacto_empresa_cargo'),
        contacto_telefono: tras('contacto_empresa_telefono'),
        contacto_sst_nombre: tras('contacto_sst_nombre'),
        contacto_sst_telefono: tras('contacto_sst_telefono'),
        contacto_sst_correo: tras('contacto_sst_correo'),
      }, client);
    }

    const columnas = Object.keys(valores);
    const sets = columnas.map((c, i) => `${c} = $${i + 2}`);
    await client.query(
      `UPDATE sst.ordenes_servicio SET ${sets.join(', ')}, actualizado_en = now() WHERE id = $1`,
      [req.params.id, ...columnas.map((c) => valores[c])]
    );
    return actual;
  });

  res.json({ data: await getOrderExpanded(orden.id) });
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
    // PRE-02 · La orden se queda con el valor hora que le corresponde HOY a este
    // profesional, congelado. Si mañana cambia el catálogo o su tarifa, lo ya
    // asignado sigue valiendo lo mismo: una cuenta de cobro no puede moverse
    // sola por un ajuste de precios posterior.
    //
    // Se recalcula en cada asignación a propósito: cambiar de profesional cambia
    // lo que se paga, y la orden todavía no se ha ejecutado.
    const tarifa = await valorHoraDeOrden(
      { ordenId: req.params.id, profesional: prof.rows[0] }, client,
    );

    const guardada = await client.query(
      `UPDATE sst.ordenes_servicio
          SET profesional_asignado_id=$2,
              fecha_programada=$3,
              valor_hora_cobro=$4,
              valor_hora_origen=$5,
              secuencia_calendario = secuencia_calendario + 1
        WHERE id=$1
      RETURNING secuencia_calendario`,
      [req.params.id, profesionalId, fechaProgramada, tarifa.valorHora, tarifa.origen]
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
    // La forma de la respuesta es la MISMA que la del caso completo —`data` es
    // la orden y los indicadores van arriba—. Cuando divergían, el frontend
    // leía `correo_enviado` en la raíz, lo encontraba `undefined` y anunciaba
    // "el profesional recibió el correo" de un correo que nunca salió.
    // Cuánto falta lo dice QUIEN decide, no el cliente. La app calculaba su
    // propia cuenta y llegó a anunciar "faltan 0 h por repartir" junto a un
    // avance guardado, porque su idea de las horas de la orden no coincidía con
    // la del servidor. Con el dato aquí, el aviso no puede contradecirse.
    const repartidos = minutosDeFranjas(result.franjas);
    const objetivo = Math.round(Number(result.orden.horas_asignadas ?? 0) * 60);
    return res.json({
      message: 'Se guardó el avance de la programación. La orden sigue SIN PROGRAMAR hasta ' +
               'repartir todas sus horas; el profesional no ha sido notificado.',
      completa: false,
      correo_enviado: false,
      formatos_generados: 0,
      minutos_programados: repartidos,
      minutos_orden: objetivo,
      faltan_minutos: Math.max(0, objetivo - repartidos),
      data: { ...result.orden, franjas: result.franjas },
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
          : `Adjuntamos los formatos de ${o.arl_nombre} ya diligenciados con los datos de ` +
            `esta orden: imprímelos y completa en la sesión lo que falta ` +
            `(asistentes, temas desarrollados, observaciones y firmas).\n\n`) +
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
          bloqueLista(
            varias ? `La visita se realiza en ${result.franjas.length} franjas` : 'Fecha de la visita',
            result.franjas.length ? result.franjas.map(franjaEnTexto) : [fecha],
          ),
          sinFormatos
            ? bloqueAviso(
                'Los formatos de esta ARL todavía no están cargados en la plataforma. ' +
                'Te los haremos llegar aparte.',
              )
            : parrafo(
                `Adjuntamos los formatos de ${o.arl_nombre} ya diligenciados con ` +
                `los datos de esta orden. Solo tienes que imprimirlos y completar en la sesión ` +
                `lo que falta: asistentes, temas desarrollados, observaciones y firmas.`,
              ),
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
    completa: true,
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

/**
 * VER-01 · Soportes de la OS, **ordenados por categoría**: primero el acta (es
 * la que decide si la visita se da por buena), luego la asistencia y luego las
 * evidencias. Antes salían por hora de subida, que es el orden en que el
 * profesional los fue eligiendo en el móvil y no le sirve a quien revisa.
 */
router.get('/:id/supports', asyncHandler(async (req, res) => {
  const r = await pool.query(
    `SELECT * FROM sst.archivos_soporte WHERE orden_id=$1
      ORDER BY CASE categoria
                 WHEN 'acta' THEN 1 WHEN 'asistencia' THEN 2 WHEN 'evidencias' THEN 3
                 ELSE 9 END,
               subido_en`,
    [req.params.id]
  );
  res.json({ data: r.rows });
}));

/**
 * M7 · Verificación — Aceptar los soportes: EJECUTADA → FINALIZADA.
 *
 * EJECUTADA la pone el profesional al subir los archivos; este paso es el del
 * ADMINISTRADOR, que los revisa y los da por buenos. Antes no movía el estado y
 * la orden se quedaba en EJECUTADA para siempre: mirando la bandeja no había
 * forma de distinguir lo revisado de lo que nadie había abierto todavía.
 *
 * Al cerrarse el ciclo se le manda la encuesta al cliente (ENC-01) — antes de la
 * revisión sería preguntarle por una visita que todavía nadie ha comprobado.
 */
router.post('/:id/verify', requireRole('admin'), asyncHandler(async (req, res) => {
  const r = await pool.query(
    `SELECT estado::text AS estado FROM sst.ordenes_servicio WHERE id=$1`, [req.params.id]
  );
  if (!r.rows[0]) throw badRequest('OS no encontrada');
  if (r.rows[0].estado !== 'EJECUTADA') {
    throw badRequest(
      r.rows[0].estado === 'FINALIZADA'
        ? 'Los soportes de esta orden ya se aceptaron: la OS está FINALIZADA.'
        : `Solo se pueden aceptar los soportes de una OS EJECUTADA; esta está ${r.rows[0].estado}.`
    );
  }

  // PRE-01 · Queda marcado en la propia orden, que es lo que la hace entrar en
  // la cuenta de cobro del profesional. `soportes_aceptados_en` solo se pone la
  // primera vez: si los soportes se rechazan y se vuelven a aceptar, la fecha
  // que vale para el cobro es la de la primera aceptación.
  //
  // Y se borra el rechazo pendiente si lo había: aceptar los soportes cierra
  // cualquier devolución anterior, así que el portal deja de pedirle al
  // profesional que suba nada.
  await pool.query(
    `UPDATE sst.ordenes_servicio
        SET soportes_aceptados_en  = COALESCE(soportes_aceptados_en, now()),
            soportes_aceptados_por = COALESCE(soportes_aceptados_por, $2),
            soportes_rechazados      = NULL,
            soportes_rechazo_motivo  = NULL,
            soportes_rechazados_en   = NULL,
            actualizado_en = now()
      WHERE id = $1`,
    [req.params.id, req.user.sub]
  );

  // EST-01/03 · Y AHORA sí se mueve el estado: la orden queda FINALIZADA, con su
  // fila de auditoría escrita por la función de dominio (que además comprueba
  // que la transición sea legal). Va después de marcar la aceptación para que,
  // si algo fallara aquí, no quede una OS finalizada sin fecha de aceptación —
  // que es el dato del que cuelga la cuenta de cobro.
  await changeStatus({
    orderId: req.params.id,
    newStatus: 'FINALIZADA',
    userId: req.user.sub,
    motivo: 'Soportes revisados y aceptados',
  });

  const orden = await getOrderExpanded(req.params.id);
  const encuesta = await encuestaAlCerrar(orden); // ENC-01
  res.json({
    message: encuesta?.enviada
      ? 'Soportes aceptados. La orden queda FINALIZADA y se envió la encuesta al cliente.'
      : 'Soportes aceptados. La orden queda FINALIZADA.',
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

  // VER-04 · QUÉ se devuelve, no solo que se devuelve.
  //
  // Sin lista, el rechazo era total: el profesional volvía a subirlo todo,
  // incluido lo que ya estaba bien, y el administrador tenía que revisar otra
  // vez documentos que ya había dado por buenos. Si no llega ninguna categoría
  // (cliente antiguo), se devuelven las que hoy tienen archivo — el
  // comportamiento de siempre.
  const pedidas = Array.isArray(req.body?.categorias) ? req.body.categorias : null;
  let categorias;
  if (pedidas) {
    const invalidas = pedidas.filter((c) => !esCategoriaValida(c));
    if (invalidas.length) throw badRequest(`Documento desconocido: ${invalidas.join(', ')}.`);
    categorias = [...new Set(pedidas.map((c) => normalizarCategoria(c)))];
    if (!categorias.length) {
      throw badRequest('Marque al menos un documento para devolver al profesional.');
    }
  } else {
    const conArchivo = (await pool.query(
      `SELECT DISTINCT COALESCE(categoria,'otros') AS categoria
         FROM sst.archivos_soporte WHERE orden_id=$1`, [req.params.id]
    )).rows.map((r) => normalizarCategoria(r.categoria));
    categorias = conArchivo.length ? conArchivo : CATEGORIAS_SOPORTE.map((c) => c.clave);
  }
  const listaDocs = listaEtiquetas(categorias);

  const orden = await changeStatus({ orderId: req.params.id, newStatus: 'PROGRAMADA', userId: req.user.sub, motivo });
  // Reabrir enlace público para re-cargar soportes.
  await pool.query(`UPDATE sst.enlaces_publicos SET activo=true WHERE orden_id=$1`, [req.params.id]);
  // Solo estas casillas quedan abiertas en el portal; las demás, bloqueadas.
  await pool.query(
    `UPDATE sst.ordenes_servicio
        SET soportes_rechazados     = $2,
            soportes_rechazo_motivo = $3,
            soportes_rechazados_en  = now(),
            actualizado_en = now()
      WHERE id = $1`,
    [req.params.id, categorias, motivo.trim()]
  );

  const expandida = await getOrderExpanded(req.params.id);
  const prof = orden.profesional_asignado_id
    ? (await pool.query(
        `SELECT nombre, correo, usuario_id FROM sst.profesionales WHERE id=$1`,
        [orden.profesional_asignado_id]
      )).rows[0]
    : null;

  // La campanita solo llega si la ficha del profesional está enlazada con una
  // cuenta de acceso, y muchas no lo están; además el profesional trabaja en
  // campo y no vive dentro de la plataforma. Sin correo, un rechazo podía
  // quedarse semanas sin que se enterara nadie.
  let correoEnviado = false;
  let correoError = null;
  if (prof?.correo) {
    const enlace = await pool.query(
      `SELECT token FROM sst.enlaces_publicos
        WHERE orden_id=$1 AND activo ORDER BY creado_en DESC LIMIT 1`,
      [req.params.id]
    );
    const token = enlace.rows[0]?.token;
    const supportUrl = token ? `${env.publicAppUrl}/soporte?token=${token}` : null;
    try {
      await sendEmail({
        to: prof.correo,
        cc: req.user.correo || undefined,
        subject: `Soportes devueltos · ${expandida.codigo} · ${expandida.empresa_nombre || ''}`,
        text:
          `Hola ${prof.nombre},\n\n` +
          `Revisamos los soportes de la OS ${expandida.codigo} (${expandida.arl_nombre}) ` +
          `para ${expandida.empresa_nombre} y hay algo que corregir:\n\n` +
          `${motivo.trim()}\n\n` +
          `Documento(s) por volver a subir: ${listaDocs}.\n` +
          `Los demás quedaron aceptados: no hay que repetirlos.\n\n` +
          `La orden vuelve a PROGRAMADA.\n` +
          (supportUrl
            ? `Sube los soportes corregidos por el mismo enlace (sin login):\n${supportUrl}\n`
            : `Solicita un enlace nuevo al equipo administrativo para volver a subirlos.\n`),
        html: correoHtml({
          titulo: 'Soportes devueltos para corregir',
          subtitulo: `${expandida.codigo} · ${expandida.empresa_nombre || ''}`,
          pie: 'JD&D Consultores · Seguridad y Salud en el Trabajo',
          cuerpo: [
            parrafo(`Hola ${prof.nombre},`),
            parrafo(
              `Revisamos los soportes que enviaste y hay algo que corregir antes de poder ` +
              `dar la visita por cerrada.`,
            ),
            // El motivo es lo único que el profesional necesita leer sí o sí:
            // va destacado y con las palabras exactas del administrador.
            bloqueAviso(motivo.trim()),
            // Lo que hay que repetir va en la tabla, no diluido en el texto:
            // es el dato que el profesional vuelve a mirar al abrir el correo.
            tablaDatos([
              filaDato('Orden', expandida.codigo),
              filaDato('ARL', expandida.arl_nombre),
              filaDato('Empresa', expandida.empresa_nombre),
              filaDato('Por volver a subir', listaDocs),
              filaDato('Estado', 'PROGRAMADA'),
            ]),
            parrafo(
              'Los demás documentos quedaron aceptados. Al abrir el enlace solo ' +
              'podrás reemplazar los que aparecen arriba: el archivo anterior de ' +
              'cada uno se sustituye por el que subas.',
            ),
            supportUrl
              ? parrafo('Sube los soportes corregidos desde aquí (no necesitas iniciar sesión):')
              : parrafo(
                  'Solicita un enlace nuevo al equipo administrativo para volver a subirlos.',
                ),
            supportUrl ? boton('Subir soportes corregidos', supportUrl) : '',
            supportUrl ? enlaceCrudo(supportUrl) : '',
          ].join(''),
        }),
      });
      correoEnviado = true;
    } catch (e) {
      // El rechazo YA está guardado: si el correo falla no puede devolverse un
      // error, o el administrador lo intentaría otra vez sobre una orden que ya
      // volvió a PROGRAMADA.
      correoError = e?.message || 'No fue posible entregar el correo.';
      console.error('[reject] correo no enviado:', correoError);
    }
  }

  if (prof?.usuario_id) {
    await notify({
      userId: prof.usuario_id, tipo: 'RECHAZO', titulo: 'Soportes rechazados',
      mensaje: motivo, datos: { orden_id: orden.id },
    }).catch((e) => console.error('[reject] notificación interna no creada:', e?.message));
  }

  res.json({
    message: correoEnviado
      ? 'Soportes rechazados; la OS vuelve a PROGRAMADA y el profesional fue avisado por correo.'
      : 'Soportes rechazados; la OS vuelve a PROGRAMADA.',
    correo_enviado: correoEnviado,
    correo_error: correoError,
    categorias_rechazadas: categorias,
    data: orden,
  });
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
  // el estado FINALIZADA, no la pantalla desde la que se llegó a él.
  const encuesta = await encuestaAlCerrar(orden);
  res.json({
    encuesta_enviada: !!encuesta?.enviada,
    encuesta_error: encuesta && !encuesta.enviada ? encuesta.motivo : null,
    data: orden,
  });
}));

export default router;
