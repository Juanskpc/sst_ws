import { PDFDocument } from 'pdf-lib';
import { Router } from 'express';
import { pool, withTransaction } from '../../config/db.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authRequired, requireRole } from '../../middleware/auth.js';
import { badRequest } from '../../utils/httpError.js';
import {
  getOrderExpanded, changeStatus, generateOrderDocuments, profesionalDeUsuario, coasesoresDeOrden,
  asesoresSinEntregar,
} from './orders.service.js';
import { randomToken } from '../../utils/security.js';
import { env } from '../../config/env.js';
import { sendEmail } from '../../services/email.service.js';
import { notify } from '../../services/notification.service.js';
import { enviarEncuesta } from '../surveys/surveys.service.js';
import { construirInvitaciones, adjuntosInvitacion } from '../../services/calendar.service.js';
import {
  correoHtml, parrafo, tablaDatos, filaDato, bloqueLista, bloqueAviso, boton, enlaceCrudo,
} from '../../services/email-layout.service.js';
import { enPesosCO, fechaDiaCO, fechaHoraCO, horaAmPm, horasTexto } from '../../utils/formato.js';
import { parseNumeroCO, parseFechaCO } from '../../utils/parseo.js';
import { resolverEmpresaId } from '../companies/companies.service.js';
import {
  casillasDeOrden, esCategoriaValida, esOpcional, etiquetaCategoria, listaEtiquetas, normalizarCategoria,
} from '../../services/soportes.service.js';
import {
  esBolivar, normalizarModalidadEjecucion, normalizarTipoActividadBolivar,
} from '../../utils/bolivar.js';
import { avisoDeEntrega, entregaDeLaOrden } from '../../services/entrega-arl.service.js';
import {
  ROLES_APRUEBAN, aprobarCobro, detalleCobro, guardarValores, retirarAprobacion,
} from './cobro-orden.service.js';

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

  if (tipo?.id) {
    // T0-10 · Por ID del tipo. El respaldo por nombre NORMALIZADO es solo para las
    // tarifas que no se pudieron enlazar (`tipo_orden_id` NULL): antes se casaba
    // texto contra texto con `lower()` y "Capacitacion" sin tilde nunca coincidía
    // con "Capacitación", así que la orden caía al valor del tipo sin avisar.
    const propia = await client.query(
      `SELECT valor_hora FROM sst.tarifas_actividad_profesional
        WHERE profesional_id=$1 AND vigente_desde <= CURRENT_DATE
          AND (tipo_orden_id = $2
               OR (tipo_orden_id IS NULL AND sst.norm_texto(actividad) = sst.norm_texto($3)))
        ORDER BY vigente_desde DESC LIMIT 1`,
      [profesional.id, tipo.id, tipo.nombre]
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
 * ASG · Quién firma los formatos cuando NO es quien ejecuta la visita.
 *
 * Bolívar solo acepta radicados a nombre de profesionales que ella tiene
 * registrados y aprobados, y no todo el equipo lo está. El puente es este: la
 * visita la hace quien puede hacerla y **el formato sale a nombre de un
 * registrado**. Todo lo demás —correo, `.ics`, enlace de soportes, agenda,
 * cuenta de cobro, encuesta— sigue siendo del ejecutor.
 *
 * Devuelve `null` cuando no hay suplencia (nadie elegido, o el elegido es el
 * propio ejecutor): la columna se guarda en NULL y los formatos salen como
 * siempre, a nombre de quien ejecuta.
 *
 * Se comprueba el registro ANTE LA ARL DE ESTA ORDEN, no "que esté registrado en
 * algo": poner a un registrado de Colmena en un AT-031 de Bolívar deja el mismo
 * formato que la ARL va a devolver, y encima con la apariencia de estar bien.
 */
async function resolverProfesionalDeFormatos({ ordenId, ejecutorId, elegidoId }, client) {
  if (!elegidoId || elegidoId === ejecutorId) return null;

  const r = await client.query(
    `SELECT p.*, a.nombre AS arl_nombre,
            pa.registrado, pa.codigo_registro,
            to_char(pa.vigente_hasta, 'YYYY-MM-DD') AS vigente_hasta,
            (pa.vigente_hasta IS NOT NULL AND pa.vigente_hasta < CURRENT_DATE) AS vencido
       FROM sst.profesionales p
       CROSS JOIN LATERAL (SELECT o.arl_id FROM sst.ordenes_servicio o WHERE o.id = $2) ord
       LEFT JOIN sst.arls a ON a.id = ord.arl_id
       LEFT JOIN sst.profesionales_arl pa
              ON pa.profesional_id = p.id AND pa.arl_id = ord.arl_id
      WHERE p.id = $1`,
    [elegidoId, ordenId]
  );
  const elegido = r.rows[0];
  if (!elegido) throw badRequest('El profesional elegido para los formatos no existe.');
  // A3-01 · La orden particular no lleva formatos de ARL (ver
  // `generateOrderDocuments`): no hay a nombre de quién sacarlos.
  if (!elegido.arl_nombre) {
    throw badRequest('Esta orden es de un cliente particular y no lleva formatos de ARL: no se elige a nombre de quién salen.');
  }
  if (elegido.estado !== 'Activo') {
    throw badRequest(`${elegido.nombre} está Inactivo y no puede figurar en los formatos.`);
  }
  if (!elegido.registrado) {
    throw badRequest(
      `${elegido.nombre} no está registrado ante ${elegido.arl_nombre}. Los formatos solo pueden ` +
      'salir a nombre de un profesional registrado ante la ARL de la orden; el registro se ' +
      'marca en Profesionales → Registro ante las ARL.'
    );
  }
  // La vigencia caducada NO bloquea: la fecha la teclea el administrador y
  // puede estar desactualizada, mientras que la orden hay que asignarla hoy.
  // Se avisa en la respuesta (`avisoFormatos`) para que alguien la revise.
  return elegido;
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

// 7-oct-2026 · `profesional_id` dice de QUIÉN es la franja cuando la orden la
// ejecutan varios asesores, cada uno con su horario. NULL = del asesor principal
// (`ordenes_servicio.profesional_asignado_id`), que es el caso de siempre.
const FRANJA_COLS = `id, orden_id, profesional_id,
  to_char(fecha, 'YYYY-MM-DD') AS fecha,
  to_char(hora_inicio, 'HH24:MI') AS hora_inicio,
  to_char(hora_fin, 'HH24:MI')    AS hora_fin`;

/**
 * ASG-02 · Valida y ordena las franjas de una visita.
 *
 * Una visita se puede partir (mañana y tarde, o varios días), pero dos franjas
 * del MISMO asesor no pueden solaparse: sería pedirle estar dos veces en el
 * mismo rato. Tocarse en el borde (08:00–12:00 y 12:00–16:00) sí vale. Dos
 * asesores distintos sí pueden coincidir: van juntos a la misma sesión.
 * Devuelve [] si no se mandó nada: asignar sin fecha sigue permitido.
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
    const profesional_id = String(f?.profesional_id ?? '').trim() || null;
    return { fecha, hora_inicio: ini, hora_fin: fin, profesional_id };
  });

  franjas.sort((a, b) => (a.fecha + a.hora_inicio).localeCompare(b.fecha + b.hora_inicio));
  // La última franja de cada asesor en cada día: contra ella se compara la siguiente.
  const ultima = new Map();
  for (const act of franjas) {
    const clave = `${act.profesional_id ?? ''}|${act.fecha}`;
    const prev = ultima.get(clave);
    if (prev && act.hora_inicio < prev.hora_fin) {
      throw badRequest(
        `Las franjas del ${act.fecha} se cruzan (${prev.hora_inicio}–${prev.hora_fin} y ${act.hora_inicio}–${act.hora_fin}).`
      );
    }
    if (!prev || act.hora_fin > prev.hora_fin) ultima.set(clave, act);
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
  const { arl_id, profesional_id, q, estado_cobro, estado_arl } = req.query;
  const clauses = [];
  const params = [];
  if (estado) { params.push(estado); clauses.push(`estado = $${params.length}::sst.estado_orden`); }
  // El eje de facturación filtra aparte del ciclo operativo: la pregunta que se
  // hace desde Órdenes es "qué está finalizado y sin radicar", que son los dos
  // ejes a la vez.
  if (estado_cobro) {
    params.push(estado_cobro);
    clauses.push(`estado_cobro = $${params.length}::sst.estado_cobro`);
  }
  // T0-07 · La aprobación de la ARL, el otro eje que decide si una orden se puede
  // facturar. Junto a `estado_cobro` responde "qué está listo para facturar".
  if (estado_arl) {
    params.push(estado_arl);
    clauses.push(`estado_arl = $${params.length}::sst.estado_arl`);
  }
  if (arl_id) { params.push(arl_id); clauses.push(`arl_id = $${params.length}`); }
  // 5-oct-2026 · También las órdenes en las que va de COASESOR: este filtro pinta
  // la agenda del modal de asignación, y esas horas las tiene igual de ocupadas.
  if (profesional_id) {
    params.push(profesional_id);
    clauses.push(`(profesional_asignado_id = $${params.length} OR EXISTS (
      SELECT 1 FROM sst.orden_coasesores c
       WHERE c.orden_id = vw_ordenes_expandidas.id AND c.profesional_id = $${params.length}))`);
  }
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
                 -- 7-oct-2026 · Solo los SUYOS (NULL = los del asesor principal).
                 AND COALESCE(s.profesional_id, o.profesional_asignado_id) = $1
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
                 -- 7-oct-2026 · Solo las SUYAS: con varios asesores cada uno
                 -- tiene su horario (NULL = las del asesor principal).
                 AND COALESCE(v.profesional_id, o.profesional_asignado_id) = $1
            ), '[]'::json) AS franjas
       FROM sst.vw_ordenes_expandidas o
      WHERE (o.profesional_asignado_id = $1
             -- 5-oct-2026 · O va de coasesor: la visita también es suya.
             OR EXISTS (SELECT 1 FROM sst.orden_coasesores c
                         WHERE c.orden_id = o.id AND c.profesional_id = $1))${filtroEstado}
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

// ---------------------------------------------------------------------------
// Estado de FACTURACIÓN de la orden (ago-2026, petición 6 del cliente)
//
// Es un eje INDEPENDIENTE del ciclo operativo: una OS FINALIZADA puede estar sin
// facturar o facturada. Por eso no toca `sst.estado_orden` —que está protegido
// por su matriz de transiciones y por el trigger de EST-06— sino su propia
// columna, su propio enum y su propio historial.
//
// No es la Cartera (RPT-06) que se retiró el 19-ago-2026: aquello era un reporte
// con tres fechas sueltas que nadie llenaba. Esto es un estado de la orden y
// deja constancia de quién lo movió.
// ---------------------------------------------------------------------------

/**
 * El eje entero. El primero es el valor por defecto de toda orden nueva.
 *
 * SON DOS, no cinco: nació con RADICADA, APROBADA y PAGADA por medio y el
 * cliente las retiró el 23-ago-2026 porque no lleva registro de ellas. La lista
 * está copiada en otros dos sitios —el enum `sst.estado_cobro` de `schema.sql` y
 * `ESTADOS_COBRO` del frontend—: si vuelve alguno hay que tocar los tres.
 */
const ESTADOS_COBRO = ['NO FACTURADA', 'FACTURADA'];

/**
 * Cambio del estado de cobro (admin y contador).
 *
 * Acepta una LISTA de ids aunque la vista mande siempre una sola orden: el
 * marcado en lote se retiró de la interfaz el 23-ago-2026 —el cliente lo pidió
 * de a una, desde el icono de la fila— pero el endpoint conserva la forma,
 * porque es la que deja mover un paquete recién radicado sin cuarenta viajes al
 * servidor si algún día vuelve a hacer falta.
 *
 * Va declarado ANTES de `/:id` por la misma razón que `/mias`: Express resuelve
 * por orden de declaración y un comodín que aceptara 'cobro' como id sería un
 * error de Postgres, no un 404.
 *
 * El eje solo se mueve sobre órdenes FINALIZADAS (decisión D-7): antes del
 * cierre no hay nada que facturarle a la ARL. Las que no cumplen no tumban el
 * lote —marcar treinta y perderlas todas por una sería peor— pero se devuelven
 * enumeradas para que quien marca sepa cuáles quedaron fuera.
 */
router.patch('/cobro', requireRole('admin', 'contador'), asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((x) => String(x ?? '').trim()).filter(Boolean) : [];
  const estado = String(req.body?.estado ?? '').trim().toUpperCase();
  if (!ids.length) throw badRequest('Seleccione al menos una orden.');
  if (!ESTADOS_COBRO.includes(estado)) {
    throw badRequest(`El estado de cobro debe ser uno de: ${ESTADOS_COBRO.join(', ')}.`);
  }
  const numeroFactura = String(req.body?.numero_factura ?? '').trim() || null;
  const observacion = String(req.body?.observacion ?? '').trim() || null;
  // El número de factura es el dato por el que se busca una orden cuando la ARL
  // pregunta: exigirlo justo en el estado que lo produce evita una tabla llena
  // de "FACTURADA" sin decir con qué factura.
  if (estado === 'FACTURADA' && !numeroFactura) {
    throw badRequest('Indique el número de factura para marcar las órdenes como FACTURADA.');
  }

  const resultado = await withTransaction(async (client) => {
    // A1-05 · `tiene_factura_orbita` dice si la última factura VALIDADA de la
    // orden es un documento electrónico emitido por Orbita (no un marcado
    // manual de Siigo): desmarcarla aquí borraría el rastro de una factura que
    // sí existe y que la DIAN ya validó — eso se corrige con una nota crédito
    // (A2-01), nunca con este PATCH.
    const filas = await client.query(
      `SELECT o.id, o.codigo, o.arl_id, o.estado::text AS estado, o.estado_cobro::text AS estado_cobro,
              o.estado_arl::text AS estado_arl,
              EXISTS (
                SELECT 1 FROM sst.documento_ordenes dor WHERE dor.orden_id = o.id AND dor.documento_validado_id IS NOT NULL
              ) AS tiene_factura_orbita
         FROM sst.ordenes_servicio o WHERE o.id = ANY($1::uuid[]) FOR UPDATE`,
      [ids]
    );
    const encontradas = new Set(filas.rows.map((f) => f.id));
    const inexistentes = ids.filter((id) => !encontradas.has(id));

    const aptas = filas.rows.filter((f) => f.estado === 'FINALIZADA');
    const sinCerrar = filas.rows.filter((f) => f.estado !== 'FINALIZADA');
    const bloqueadasPorFacturaElectronica = aptas.filter(
      (f) => estado === 'NO FACTURADA' && f.estado_cobro === 'FACTURADA' && f.tiene_factura_orbita,
    );
    // Las que ya estaban en ese estado se saltan en silencio: volver a marcar lo
    // mismo no es un error, pero escribir otra fila de historial idéntica
    // llenaría la auditoría de ruido y taparía el cambio de verdad. Las
    // bloqueadas por tener una factura de Orbita tampoco cambian aquí.
    const bloqueadasIds = new Set(bloqueadasPorFacturaElectronica.map((f) => f.id));
    const cambian = aptas.filter((f) => f.estado_cobro !== estado && !bloqueadasIds.has(f.id));

    // T0-07 · Facturar exige que la ARL haya APROBADO la orden. Se corta ANTES de
    // tocar nada —y no se deja fuera en silencio como las sin cerrar— porque una
    // factura emitida sobre una orden que la ARL no aprobó es la que después
    // rechazan. Las órdenes sin ARL (A3-01, privados) no tienen esta regla.
    if (estado === 'FACTURADA') {
      const sinAprobar = cambian.filter((f) => f.arl_id && f.estado_arl !== 'APROBADO');
      if (sinAprobar.length) {
        throw badRequest(
          sinAprobar.length === 1
            ? 'La ARL todavía no aprueba esta orden (estado ARL: Pendiente). ' +
              `Apruébela primero para poder facturar ${sinAprobar[0].codigo}.`
            : 'La ARL todavía no aprueba estas órdenes (estado ARL: Pendiente): ' +
              `${sinAprobar.map((f) => f.codigo).join(', ')}. Apruébelas primero para poder facturarlas.`,
        );
      }
    }

    for (const fila of cambian) {
      await client.query(
        `UPDATE sst.ordenes_servicio
            SET estado_cobro = $2::sst.estado_cobro,
                cobro_numero_factura = COALESCE($3, cobro_numero_factura),
                cobro_observacion = $4,
                cobro_actualizado_en = now(),
                cobro_actualizado_por = $5,
                actualizado_en = now()
          WHERE id = $1`,
        [fila.id, estado, numeroFactura, observacion, req.user.sub]
      );
      await client.query(
        `INSERT INTO sst.historial_cobro_orden
           (orden_id, estado_anterior, estado_nuevo, numero_factura, observacion, cambiado_por)
         VALUES ($1,$2::sst.estado_cobro,$3::sst.estado_cobro,$4,$5,$6)`,
        [fila.id, fila.estado_cobro, estado, numeroFactura, observacion, req.user.sub]
      );
    }
    return {
      actualizadas: cambian.map((f) => f.id),
      sin_cambio: aptas.filter((f) => f.estado_cobro === estado && !bloqueadasIds.has(f.id)).map((f) => f.codigo),
      no_finalizadas: sinCerrar.map((f) => f.codigo),
      bloqueadas_por_factura_electronica: bloqueadasPorFacturaElectronica.map((f) => f.codigo),
      inexistentes,
    };
  });

  const n = resultado.actualizadas.length;
  const partes = [`${n} orden${n === 1 ? '' : 'es'} marcada${n === 1 ? '' : 's'} como ${estado}.`];
  if (resultado.sin_cambio.length) {
    partes.push(`${resultado.sin_cambio.length} ya estaba${resultado.sin_cambio.length === 1 ? '' : 'n'} en ese estado.`);
  }
  if (resultado.no_finalizadas.length) {
    partes.push(
      `Quedaron fuera ${resultado.no_finalizadas.join(', ')}: el estado de cobro solo se mueve ` +
      'sobre órdenes FINALIZADAS.'
    );
  }
  if (resultado.bloqueadas_por_factura_electronica.length) {
    partes.push(
      `No se desmarcaron ${resultado.bloqueadas_por_factura_electronica.join(', ')}: su factura es un documento ` +
      'de Orbita ya validado por la DIAN. Para corregirla, emita una nota crédito.'
    );
  }
  res.json({ message: partes.join(' '), estado, ...resultado });
}));

// ---------------------------------------------------------------------------
// T0-07 · Estado ARL: ¿la ARL aprobó los documentos de la orden?
//
// Tercer eje de la orden, junto al ciclo operativo y al de cobro, con su propio
// enum y su propio historial. Es la condición para facturar (ver `/cobro`).
// ---------------------------------------------------------------------------

/**
 * El eje entero; el primero es el valor por defecto de toda orden. Copiado en el
 * enum `sst.estado_arl` de `schema.sql` y en `ESTADOS_ARL` de `core/models.ts`:
 * si Q-08 añade un valor hay que tocar los tres.
 */
const ESTADOS_ARL = ['PENDIENTE', 'APROBADO'];

/**
 * Cambio del estado ARL y/o del n.º de prefactura (admin y contador), a imagen de
 * `PATCH /orders/cobro`. Declarado ANTES de `/:id` por la misma razón que él.
 *
 * Es TODO O NADA —a diferencia de `/cobro`, que deja fuera las que no cumplen—:
 * la interfaz lo llama desde el "Guardar" de una orden, y ahí lo único útil es
 * un error que diga qué falta, no un 200 que dejó la orden sin cambiar.
 *
 * Reglas (T0-07):
 *  1. APROBADO solo sobre órdenes FINALIZADAS: antes no hay soportes aceptados
 *     que la ARL pueda aprobar.
 *  2. En Bolívar, APROBADO exige n.º de prefactura (solo dígitos).
 *  3. El n.º de prefactura solo existe en Bolívar.
 *  4. Una orden ya FACTURADA no vuelve a PENDIENTE: dejaría una factura emitida
 *     sobre una orden que la ARL "no aprobó".
 *
 * `numero_prefactura` omitido = se conserva el que hay; vacío = se borra. Una
 * prefactura agrupa varias órdenes, así que el mismo número va a todas las ids.
 */
router.patch('/estado-arl', requireRole('admin', 'contador'), asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((x) => String(x ?? '').trim()).filter(Boolean) : [];
  const estado = String(req.body?.estado ?? '').trim().toUpperCase();
  if (!ids.length) throw badRequest('Seleccione al menos una orden.');
  if (!ESTADOS_ARL.includes(estado)) {
    throw badRequest(`El estado ARL debe ser uno de: ${ESTADOS_ARL.join(', ')}.`);
  }
  const prefacturaEnviada = req.body?.numero_prefactura !== undefined;
  const prefactura = String(req.body?.numero_prefactura ?? '').trim() || null;
  if (prefactura && !/^\d{1,12}$/.test(prefactura)) {
    throw badRequest('El n.º de prefactura solo admite dígitos (los de Bolívar tienen 6).');
  }

  const resultado = await withTransaction(async (client) => {
    const filas = await client.query(
      `SELECT o.id, o.codigo, a.nombre AS arl_nombre, o.estado::text AS estado,
              o.estado_arl::text AS estado_arl, o.estado_cobro::text AS estado_cobro,
              o.numero_prefactura
         FROM sst.ordenes_servicio o LEFT JOIN sst.arls a ON a.id = o.arl_id
        WHERE o.id = ANY($1::uuid[]) FOR UPDATE OF o`,
      [ids]
    );
    if (filas.rows.length !== new Set(ids).size) {
      throw badRequest('Alguna de las órdenes ya no existe. Recargue la lista.');
    }

    const cambios = [];
    for (const fila of filas.rows) {
      // A3-01 · El estado ARL no aplica a una orden particular: nadie la aprueba
      // en una plataforma, y la facturación la trata como aprobada.
      if (!fila.arl_nombre) {
        throw badRequest(`${fila.codigo} es de un cliente particular: no tiene estado ARL.`);
      }
      const bolivar = esBolivar(fila.arl_nombre);
      const finalPrefactura = prefacturaEnviada ? prefactura : fila.numero_prefactura;
      if (prefactura && !bolivar) {
        throw badRequest(`${fila.codigo}: el n.º de prefactura solo aplica a Bolívar.`);
      }
      if (estado === 'APROBADO') {
        if (fila.estado !== 'FINALIZADA') {
          throw badRequest(
            `${fila.codigo} está ${fila.estado}: la ARL solo aprueba órdenes FINALIZADAS, que ya tienen los soportes aceptados.`,
          );
        }
        if (bolivar && !finalPrefactura) {
          throw badRequest(`Indique el n.º de prefactura de ${fila.codigo}: en Bolívar es obligatorio para marcarla APROBADO.`);
        }
      }
      if (estado === 'PENDIENTE' && fila.estado_arl === 'APROBADO' && fila.estado_cobro === 'FACTURADA') {
        throw badRequest(`${fila.codigo} ya está FACTURADA: no puede volver a PENDIENTE en la ARL.`);
      }

      const cambiaEstado = fila.estado_arl !== estado;
      const cambiaPrefactura = (fila.numero_prefactura ?? null) !== (finalPrefactura ?? null);
      // Repetir lo mismo no es un error, pero tampoco deja rastro: otra fila de
      // historial idéntica taparía el cambio de verdad.
      if (!cambiaEstado && !cambiaPrefactura) continue;

      await client.query(
        `UPDATE sst.ordenes_servicio
            SET estado_arl = $2::sst.estado_arl,
                numero_prefactura = $3,
                estado_arl_en = CASE WHEN $4::boolean THEN now() ELSE estado_arl_en END,
                estado_arl_por = CASE WHEN $4::boolean THEN $5::uuid ELSE estado_arl_por END,
                actualizado_en = now()
          WHERE id = $1`,
        [fila.id, estado, finalPrefactura, cambiaEstado, req.user.sub]
      );
      await client.query(
        `INSERT INTO sst.historial_estado_arl
           (orden_id, estado_anterior, estado_nuevo, numero_prefactura, usuario_id, origen)
         VALUES ($1,$2::sst.estado_arl,$3::sst.estado_arl,$4,$5,'MANUAL')`,
        [fila.id, fila.estado_arl, estado, finalPrefactura, req.user.sub]
      );
      cambios.push(fila.codigo);
    }
    return { actualizadas: cambios, sin_cambio: filas.rows.length - cambios.length };
  });

  const n = resultado.actualizadas.length;
  res.json({
    message: n
      ? `${n} orden${n === 1 ? '' : 'es'} actualizada${n === 1 ? '' : 's'}: estado ARL ${estado}.`
      : 'Sin cambios: la orden ya estaba así.',
    estado,
    ...resultado,
  });
}));

/** Historial del eje de cobro de UNA orden: quién la movió, cuándo y por qué. */
router.get('/:id/cobro', asyncHandler(async (req, res) => {
  const r = await pool.query(
    `SELECT h.*, u.nombre AS cambiado_por_nombre
       FROM sst.historial_cobro_orden h
       LEFT JOIN sst.usuarios u ON u.id = h.cambiado_por
      WHERE h.orden_id = $1
      ORDER BY h.cambiado_en`,
    [req.params.id]
  );
  res.json({ data: r.rows });
}));

// Detalle completo: OS + historial + documentos + soportes + enlace público.
router.get('/:id', asyncHandler(async (req, res) => {
  const orden = await getOrderExpanded(req.params.id);
  const coasesores = await coasesoresDeOrden(req.params.id);
  const [historial, docs, soportes, enlace, franjas, historialCobro, historialArl] = await Promise.all([
    pool.query(
      `SELECT h.*, u.nombre AS cambiado_por_nombre FROM sst.historial_estados_orden h
       LEFT JOIN sst.usuarios u ON u.id = h.cambiado_por
       WHERE h.orden_id=$1 ORDER BY h.cambiado_en`, [req.params.id]),
    pool.query(`SELECT * FROM sst.documentos_generados WHERE orden_id=$1 ORDER BY generado_en`, [req.params.id]),
    // 7-oct-2026 · Con el asesor que subió cada uno (NULL = el principal).
    pool.query(
      `SELECT s.*, COALESCE(s.profesional_id, o.profesional_asignado_id) AS de_profesional_id,
              p.nombre AS profesional_nombre
         FROM sst.archivos_soporte s
         JOIN sst.ordenes_servicio o ON o.id = s.orden_id
         LEFT JOIN sst.profesionales p ON p.id = COALESCE(s.profesional_id, o.profesional_asignado_id)
        WHERE s.orden_id=$1 ORDER BY s.subido_en`, [req.params.id]),
    // El enlace que se enseña en la ficha es el del asesor principal.
    pool.query(`SELECT * FROM sst.enlaces_publicos WHERE orden_id=$1 AND activo AND profesional_id IS NULL ORDER BY creado_en DESC LIMIT 1`, [req.params.id]),
    franjasDeOrden(req.params.id),
    // El eje de cobro lleva su propio historial, aparte del de estados: son dos
    // líneas de tiempo distintas sobre la misma orden y mezclarlas haría ilegible
    // cualquiera de las dos.
    pool.query(
      `SELECT h.*, u.nombre AS cambiado_por_nombre FROM sst.historial_cobro_orden h
       LEFT JOIN sst.usuarios u ON u.id = h.cambiado_por
       WHERE h.orden_id=$1 ORDER BY h.cambiado_en`, [req.params.id]),
    // T0-07 · Tercera línea de tiempo: la aprobación de la ARL.
    pool.query(
      `SELECT h.*, u.nombre AS usuario_nombre FROM sst.historial_estado_arl h
       LEFT JOIN sst.usuarios u ON u.id = h.usuario_id
       WHERE h.orden_id=$1 ORDER BY h.creado_en`, [req.params.id]),
  ]);
  res.json({
    data: {
      ...orden,
      historial: historial.rows,
      historial_cobro: historialCobro.rows,
      historial_estado_arl: historialArl.rows,
      documentos: docs.rows,
      soportes: soportes.rows,
      franjas,
      coasesores,
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
  // FOR · Los dos enumerados del AT-031 de Bolívar. Se normalizan aquí y no en
  // la vista: el CHECK de la columna rechazaría una letra inventada con un error
  // del driver, y lo que hay que hacer con una es ignorarla, no reventar la
  // corrección entera de la orden.
  tipo_servicio_arl: normalizarTipoActividadBolivar,
  modalidad_ejecucion: normalizarModalidadEjecucion,
  // Viáticos (ago-2026): la cifra ya no se escribe. Se elige la CATEGORÍA del
  // catálogo y el valor sale de ella; vaciarla ('') es el "No aplica", que deja
  // la orden sin viáticos. `viaticos_valor` no está en esta lista a propósito:
  // dejarlo editable a mano habría vuelto a permitir dos cifras distintas para
  // el mismo desplazamiento, que es justo lo que el catálogo viene a evitar.
  viaticos_tipo_id: (v) => (String(v ?? '').trim() || null),
  viaticos_observacion: String,
  // FOR · Asesor de Gestión del Riesgo de la ARL (casilla 16 del AT-031). Lo trae
  // el SIPAB, pero se puede corregir a mano porque el .xls llega con la Ñ dañada.
  asesor_gestion_riesgo: String,
  // FOR · Tema/actividad propio (T0-05): sale en "Temas desarrollados" del AT-031
  // y en "Tema y/o actividad" del AT-028. Tope de 300 caracteres porque es el
  // largo que cabe en la casilla del formato; se rechaza en vez de recortar en
  // silencio, que dejaría una frase cortada en un documento que se radica.
  tema_actividad: (v) => {
    const s = String(v ?? '').trim();
    if (s.length > 300) throw badRequest('El tema o actividad admite máximo 300 caracteres.');
    return s || null;
  },
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

  const avisos = [];
  const orden = await withTransaction(async (client) => {
    const actual = (await client.query(
      `SELECT * FROM sst.ordenes_servicio WHERE id=$1 FOR UPDATE`, [req.params.id]
    )).rows[0];
    if (!actual) throw badRequest('Orden de servicio no encontrada');

    const valores = {};
    for (const campo of campos) valores[campo] = valorEditable(campo, body[campo]);

    // Cambiar la categoría del viático arrastra el importe: es lo que hace que
    // la cifra y la categoría no puedan contradecirse. Se congela el valor
    // VIGENTE del catálogo, igual que al cargar la orden; "No aplica" (null)
    // borra los dos.
    if ('viaticos_tipo_id' in valores) {
      if (!valores.viaticos_tipo_id) {
        valores.viaticos_valor = null;
      } else {
        const tv = (await client.query(
          `SELECT valor FROM sst.tipos_viatico WHERE id=$1 AND activo`, [valores.viaticos_tipo_id]
        )).rows[0];
        if (!tv) throw badRequest('El tipo de viático no existe o fue retirado del catálogo.');
        valores.viaticos_valor = Number(tv.valor);
      }
    }

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

    // T0-16 · Cambiar el tipo de orden RECALCULA el valor hora con el que se paga.
    // El valor se congela al asignar el profesional, así que sin esto el cambio de
    // tipo dejaba el valor del tipo anterior en la orden y la cuenta de cobro
    // salía con una cifra que nadie eligió. Solo si ya hay profesional asignado
    // (antes no hay valor congelado que corregir: se calcula al asignar).
    const cambiaTipo = 'tipo_orden_id' in valores
      && (valores.tipo_orden_id ?? null) !== (actual.tipo_orden_id ?? null);
    if (cambiaTipo && actual.profesional_asignado_id) {
      // "Cuenta generada" = una cuenta ya creada que incluye la orden y no fue
      // rechazada (estados de `sst.precuentas`: generada | aceptada | rechazada;
      // no existe "borrador"). Una rechazada se REHACE con los valores de hoy, así
      // que su orden todavía puede corregirse. En una generada o aceptada el
      // profesional ya vio —o aceptó— esa cifra y no se le reescribe por debajo.
      const enCuenta = (await client.query(
        `SELECT pc.periodo, pc.estado
           FROM sst.precuenta_items pi
           JOIN sst.precuentas pc ON pc.id = pi.precuenta_id
          WHERE pi.orden_id = $1 AND pc.estado IN ('generada','aceptada')
          ORDER BY pc.creado_en DESC LIMIT 1`,
        [req.params.id]
      )).rows[0];
      if (enCuenta) {
        avisos.push(
          `La orden ya está en la cuenta de cobro ${enCuenta.estado} de ${enCuenta.periodo}: ` +
          'el valor hora no cambió con el nuevo tipo.',
        );
      } else {
        const prof = (await client.query(
          `SELECT * FROM sst.profesionales WHERE id=$1`, [actual.profesional_asignado_id]
        )).rows[0];
        const tarifa = await valorHoraDeOrden({ ordenId: req.params.id, profesional: prof }, client);
        await client.query(
          `UPDATE sst.ordenes_servicio SET valor_hora_cobro=$2, valor_hora_origen=$3 WHERE id=$1`,
          [req.params.id, tarifa.valorHora, tarifa.origen]
        );
        // 5-oct-2026 · Y lo mismo para cada asesor adicional: el tipo nuevo le
        // cambia el valor hora igual que al principal.
        for (const c of await coasesoresDeOrden(req.params.id, client)) {
          const co = (await client.query(`SELECT * FROM sst.profesionales WHERE id=$1`, [c.profesional_id])).rows[0];
          const tarifaCo = await valorHoraDeOrden({ ordenId: req.params.id, profesional: co }, client);
          await client.query(
            `UPDATE sst.orden_coasesores SET valor_hora_cobro=$3, valor_hora_origen=$4
              WHERE orden_id=$1 AND profesional_id=$2`,
            [req.params.id, c.profesional_id, tarifaCo.valorHora, tarifaCo.origen]
          );
        }
      }
    }
    return actual;
  });

  res.json({ data: await getOrderExpanded(orden.id), avisos });
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
/**
 * Vista previa de formatos · observaciones por formato que manda la pantalla,
 * `{ at031: "texto", … }`. Se limpian aquí porque terminan impresas en un
 * documento que se radica ante la ARL: claves solo alfanuméricas y hasta 500
 * caracteres por formato. `null` = no vino nada (se conservan las guardadas).
 */
function observacionesDeFormatos(bruto) {
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return null;
  const limpias = {};
  for (const [clave, valor] of Object.entries(bruto)) {
    if (!/^[A-Za-z0-9]{1,40}$/.test(clave)) continue;
    const texto = String(valor ?? '').replace(/\s+/g, ' ').trim();
    if (texto.length > 500) {
      throw badRequest('Las observaciones de cada formato admiten hasta 500 caracteres.');
    }
    if (texto) limpias[clave] = texto;
  }
  return limpias;
}

/**
 * Vista previa · casillas abiertas del formato llenadas por el administrador,
 * `{ fichaAxa: { 'nombre 4': 'texto' } }`. Mismo criterio que las observaciones:
 * terminan impresas en un documento que se radica. Nombres de campo como los
 * del PDF ('nombre 4', 'FECHA 2', '28'), claves de formato plano ('empresa') y
 * 'proxima_fecha', hasta 1.000 caracteres por casilla.
 */
function camposDeFormatos(bruto) {
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return null;
  const limpios = {};
  for (const [clave, campos] of Object.entries(bruto)) {
    if (!/^[A-Za-z0-9]{1,40}$/.test(clave) || !campos || typeof campos !== 'object') continue;
    for (const [campo, valor] of Object.entries(campos)) {
      if (!/^[A-Za-z0-9 _]{1,40}$/.test(campo)) continue;
      const texto = String(valor ?? '').trim();
      if (texto.length > 1000) {
        throw badRequest('Cada casilla del formato admite hasta 1.000 caracteres.');
      }
      if (texto) (limpios[clave] ??= {})[campo] = texto;
    }
  }
  return limpios;
}

/**
 * Transacción que SIEMPRE se deshace. Es lo que hace inofensiva la vista previa:
 * corre la asignación completa —cambio de estado, franjas, formatos— y al final
 * no queda nada, ni siquiera la secuencia de calendario incrementada.
 */
async function enTransaccionDescartable(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

/**
 * La copia de la vista previa va APLANADA: sin casillas donde escribir. Lo que se
 * teclea dentro del visor del navegador no vuelve nunca al servidor, y así se
 * perdieron textos en la primera prueba de JD&D. Lo editable está en el panel de
 * la pantalla. El PDF que se ENVÍA conserva sus casillas para el profesional.
 */
async function pdfDeSoloLectura(buffer) {
  try {
    const doc = await PDFDocument.load(buffer);
    const form = doc.getForm();
    if (!form.getFields().length) return Buffer.from(buffer);
    form.flatten();
    return Buffer.from(await doc.save());
  } catch {
    return Buffer.from(buffer);
  }
}

/**
 * Vista previa de los formatos que saldrán con una asignación, ANTES de enviarla
 * (pedido de JD&D, 29-sep-2026): el administrador revisa cada PDF y puede
 * escribir observaciones en él. Mismo cuerpo que `POST /:id/assign` más
 * `observaciones_formatos`; no guarda nada ni manda correo.
 */
router.post('/:id/assign/preview', requireRole('admin'), asyncHandler(async (req, res) => {
  const result = await enTransaccionDescartable((client) => aplicarAsignacion(req, client, { vistaPrevia: true }));
  if (!result.completa) {
    throw badRequest('Reparta todas las horas de la visita para ver los formatos: con media agenda no se envía nada.');
  }
  const formatos = [];
  for (const d of result.docs) {
    const esPdf = /\.pdf$/i.test(d._filename || '');
    formatos.push({
      clave: d._clave,
      // Con varios asesores cada uno lleva su juego: se dice de quién es.
      etiqueta: (d._etiqueta || d.tipo) + (d._profesionalNombre ? ` · ${d._profesionalNombre}` : ''),
      nombre: d._filename,
      prediligenciado: d._prediligenciado !== false,
      admite_observaciones: !!d._admiteObservaciones,
      editables: d._editables || [],
      // Solo los PDF se pueden ver en el navegador; los Word/Excel se listan.
      pdf: esPdf ? (await pdfDeSoloLectura(d._buffer)).toString('base64') : null,
    });
  }
  res.json({
    data: {
      formatos,
      observaciones_formatos: result.orden.observaciones_formatos || {},
      campos_formatos: result.orden.campos_formatos || {},
      soportes: result.entrega?.soportes ?? [],
    },
  });
}));

/**
 * 5-oct-2026 · Coasesores que llegan en el cuerpo: `[{ profesional_id, horas }]`.
 *
 * `undefined` = el cliente no dijo nada y se conservan los que la orden tuviera;
 * un arreglo (aunque vacío) los REEMPLAZA, igual que las franjas.
 */
function normalizarCoasesores(bruto) {
  if (bruto === undefined || bruto === null) return null;
  if (!Array.isArray(bruto)) throw badRequest('coasesores debe ser una lista.');
  const vistos = new Set();
  return bruto.map((c) => {
    const id = String(c?.profesional_id ?? '').trim();
    const horas = Number(c?.horas);
    if (!id) throw badRequest('Elija el asesor adicional.');
    if (vistos.has(id)) throw badRequest('El mismo asesor adicional está repetido.');
    vistos.add(id);
    if (!Number.isFinite(horas) || horas <= 0) {
      throw badRequest('Indique cuántas horas de la orden realiza cada asesor adicional.');
    }
    return { profesional_id: id, horas: Math.round(horas * 100) / 100 };
  });
}

/**
 * M5 · Todo lo que una asignación escribe en BD, dentro de la transacción que se
 * le pase. Lo comparten la asignación real (`POST /:id/assign`, que confirma) y
 * la VISTA PREVIA de formatos (`POST /:id/assign/preview`, que deshace): así lo
 * que se ve antes de enviar sale de exactamente el mismo código que lo enviado,
 * incluidos el suplente, las franjas y las observaciones.
 */
async function aplicarAsignacion(req, client, { vistaPrevia = false } = {}) {
  const profesionalId = req.body?.profesional_id || req.body?.professional_id;
  if (!profesionalId) throw badRequest('profesional_id es obligatorio');

  // ASG-02 · La visita puede venir partida en franjas (mañana y tarde, o varios
  // días). `fecha_programada` sigue siendo el INICIO de la primera: de ella
  // cuelgan el periodo de la cuenta de cobro, los reportes y el orden de
  // los listados, así que se deriva aquí en vez de confiar en el cliente.
  // 7-oct-2026 · Con varios asesores cada franja dice de quién es; las del
  // principal se guardan con NULL para que sigan siendo suyas si él cambia.
  const franjas = normalizarFranjas(req.body?.franjas)
    .map((f) => (f.profesional_id === profesionalId ? { ...f, profesional_id: null } : f));
  const fechaProgramada = franjas.length
    ? instanteCO(franjas[0].fecha, franjas[0].hora_inicio)
    : req.body?.fecha_programada || req.body?.scheduled_at || null;

  // ASG · A nombre de quién salen los formatos, cuando no es quien ejecuta.
  // Vacío o igual al ejecutor = el caso normal, y se guarda NULL: una columna
  // que repite el valor de al lado invita a leerla como si dijera algo.
  const formatosIdBruto = String(req.body?.profesional_formatos_id ?? '').trim() || null;

  const observaciones = observacionesDeFormatos(req.body?.observaciones_formatos);
  const camposUsuario = camposDeFormatos(req.body?.campos_formatos);
  const coasesoresPedidos = normalizarCoasesores(req.body?.coasesores);

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

  // ASG · El profesional a cuyo nombre salen los formatos. Solo tiene sentido
  // si está REGISTRADO ante la ARL de esta orden: el punto entero de la
  // petición es que Bolívar solo acepta radicados a nombre de los suyos, así
  // que dejar poner a cualquiera devolvería el formato al mismo problema.
  const formatosProf = await resolverProfesionalDeFormatos(
    { ordenId: req.params.id, ejecutorId: profesionalId, elegidoId: formatosIdBruto }, client,
  );

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
            profesional_formatos_id=$6,
            secuencia_calendario = secuencia_calendario + 1
      WHERE id=$1
    RETURNING secuencia_calendario`,
    [
      req.params.id, profesionalId, fechaProgramada, tarifa.valorHora, tarifa.origen,
      formatosProf?.id ?? null,
    ]
  );

  // 5-oct-2026 · Asesores adicionales: cada uno cobra sus horas. Desde el
  // 7-oct-2026 cada uno tiene además SU horario (franjas propias), que puede
  // coincidir con el de los demás o no. Se reemplazan en bloque cuando el cliente manda la
  // lista; si no la manda se conservan, pero se vuelven a validar contra el
  // principal de hoy (cambiar de principal a quien ya iba de coasesor lo dejaría
  // dos veces en la misma orden).
  const coasesores = coasesoresPedidos
    ?? (await coasesoresDeOrden(req.params.id, client)).map((c) => ({ profesional_id: c.profesional_id, horas: c.horas }));
  if (coasesores.some((c) => c.profesional_id === profesionalId)) {
    throw badRequest('El asesor adicional no puede ser el mismo que el asesor principal.');
  }
  const horasCoasesores = coasesores.reduce((t, c) => t + c.horas, 0);
  if (coasesores.length && !(Number(horasOrden) > 0)) {
    throw badRequest('La orden no tiene horas asignadas: no hay qué repartir entre varios asesores.');
  }
  if (coasesores.length && horasCoasesores >= Number(horasOrden)) {
    throw badRequest(
      `Los asesores adicionales suman ${horasTexto(horasCoasesores)} h y la orden tiene ` +
      `${horasTexto(horasOrden)} h: al asesor principal le tiene que quedar alguna hora.`
    );
  }
  await client.query(`DELETE FROM sst.orden_coasesores WHERE orden_id=$1`, [req.params.id]);
  for (const c of coasesores) {
    const co = (await client.query(`SELECT * FROM sst.profesionales WHERE id=$1`, [c.profesional_id])).rows[0];
    if (!co) throw badRequest('El asesor adicional no existe.');
    if (co.estado !== 'Activo') throw badRequest(`${co.nombre} está Inactivo y no se le puede asignar la orden.`);
    // 7-oct-2026 · Sus horas son las que tiene marcadas en la agenda: un asesor
    // con horas pero sin horario no sabría cuándo ir, y uno con más agenda que
    // horas cobraría menos de lo que trabaja.
    if (franjas.length) {
      const suyas = franjas.filter((f) => f.profesional_id === c.profesional_id);
      if (!suyas.length) throw badRequest(`Falta marcar en la agenda las horas de ${co.nombre}.`);
      if (minutosDeFranjas(suyas) !== Math.round(c.horas * 60)) {
        throw badRequest(
          `${co.nombre} tiene ${horasTexto(minutosDeFranjas(suyas) / 60)} h en la agenda y ` +
          `${horasTexto(c.horas)} h asignadas: deben coincidir.`
        );
      }
    }
    // Mismo criterio que el principal: su valor hora de HOY, congelado.
    const tarifaCo = await valorHoraDeOrden({ ordenId: req.params.id, profesional: co }, client);
    await client.query(
      `INSERT INTO sst.orden_coasesores
         (orden_id, profesional_id, horas, valor_hora_cobro, valor_hora_origen, creado_por)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.params.id, c.profesional_id, c.horas, tarifaCo.valorHora, tarifaCo.origen, req.user.sub]
    );
  }

  // ASG-02 · Las franjas se reemplazan en bloque: reprogramar es volver a
  // decidir toda la visita, y conservar las viejas dejaría horas fantasma en
  // la agenda del profesional. Solo se tocan si el cliente mandó franjas, para
  // no borrar las de una asignación que solo cambia de profesional.
  // `franjasPrevias`: cuántas tenía CADA asesor, para cancelarle en el calendario
  // las invitaciones que sobren (las de NULL eran del principal de antes).
  const franjasPrevias = {};
  if (franjas.length) {
    const ajena = franjas.find(
      (f) => f.profesional_id && !coasesores.some((c) => c.profesional_id === f.profesional_id),
    );
    if (ajena) throw badRequest('Hay franjas de un asesor que no está asignado a la orden.');
    const antes = await client.query(
      `DELETE FROM sst.franjas_visita WHERE orden_id=$1 RETURNING profesional_id`,
      [req.params.id]
    );
    for (const f of antes.rows) {
      const de = f.profesional_id ?? actual.rows[0].profesional_asignado_id ?? profesionalId;
      franjasPrevias[de] = (franjasPrevias[de] ?? 0) + 1;
    }
    for (const f of franjas) {
      await client.query(
        `INSERT INTO sst.franjas_visita (orden_id, profesional_id, fecha, hora_inicio, hora_fin, creado_por)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [req.params.id, f.profesional_id, f.fecha, f.hora_inicio, f.hora_fin, req.user.sub]
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
  // Vista previa de formatos (29-sep) · lo que el administrador escribió en la
  // casilla de observaciones de cada formato. Se guarda en la orden ANTES de
  // generar, que es de donde lo lee `generateOrderDocuments`. Si no viene en el
  // cuerpo, se conservan las que ya tenía: reprogramar no las borra.
  if (observaciones) {
    await client.query(
      `UPDATE sst.ordenes_servicio SET observaciones_formatos = $2 WHERE id = $1`,
      [req.params.id, observaciones],
    );
  }
  if (camposUsuario) {
    await client.query(
      `UPDATE sst.ordenes_servicio SET campos_formatos = $2 WHERE id = $1`,
      [req.params.id, camposUsuario],
    );
  }

  // En la vista previa se generan igual, pero sin subirlos ni registrarlos.
  const docs = completa
    ? await generateOrderDocuments(req.params.id, client, { guardar: !vistaPrevia })
    : [];

  // SUP · Qué soportes tendrá que devolver, CONGELADO aquí.
  //
  // Sale de la misma regla que acaba de decidir los formatos, y se guarda en
  // vez de recalcularse cada vez que el profesional abre el portal: el enlace
  // ya va camino de su correo con una lista concreta de documentos, y cambiar
  // una regla la semana que viene no puede alterar lo que se le pidió hoy.
  const entrega = entregaDeLaOrden(await getOrderExpanded(req.params.id, client));
  if (completa) {
    await client.query(
      `UPDATE sst.ordenes_servicio SET soportes_requeridos = $2 WHERE id = $1`,
      [req.params.id, entrega.soportes],
    );
  }

  // Enlace público de soportes (M6). Al reprogramar se conserva el enlace
  // vigente: emitir uno nuevo invalidaría el que ya se le envió al profesional.
  const vigente = await client.query(
    `SELECT token FROM sst.enlaces_publicos
      WHERE orden_id=$1 AND activo AND profesional_id IS NULL ORDER BY creado_en DESC LIMIT 1`,
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
  // 7-oct-2026 · Y uno por cada asesor adicional: todos suben SUS soportes. El
  // que ya tenía enlace lo conserva; el de quien salió del equipo se cierra.
  const tokens = {};
  const equipoIds = (await coasesoresDeOrden(req.params.id, client)).map((c) => c.profesional_id);
  await client.query(
    `UPDATE sst.enlaces_publicos SET activo = false
      WHERE orden_id=$1 AND profesional_id IS NOT NULL AND NOT (profesional_id = ANY($2::uuid[]))`,
    [req.params.id, equipoIds]
  );
  for (const id of equipoIds) {
    const suyo = await client.query(
      `UPDATE sst.enlaces_publicos SET activo = true
        WHERE id = (SELECT id FROM sst.enlaces_publicos
                     WHERE orden_id=$1 AND profesional_id=$2 ORDER BY creado_en DESC LIMIT 1)
        RETURNING token`,
      [req.params.id, id]
    );
    tokens[id] = suyo.rows[0]?.token ?? randomToken(24);
    if (!suyo.rows[0]) {
      await client.query(
        `INSERT INTO sst.enlaces_publicos (orden_id, token, profesional_id) VALUES ($1,$2,$3)`,
        [req.params.id, tokens[id], id]
      );
    }
  }

  const orden = await getOrderExpanded(req.params.id, client);
  return {
    orden, profesional: prof.rows[0], docs, token, tokens, esReprogramacion, completa, entrega,
    formatosProf,
    secuenciaCalendario: guardada.rows[0].secuencia_calendario,
    franjas: await franjasDeOrden(req.params.id, client),
    franjasPrevias,
    coasesores: await coasesoresDeOrden(req.params.id, client),
  };
}

router.post('/:id/assign', requireRole('admin'), asyncHandler(async (req, res) => {
  const result = await withTransaction((client) => aplicarAsignacion(req, client));

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
      data: { ...result.orden, franjas: result.franjas, coasesores: result.coasesores },
    });
  }

  // ASG-03/04/07 · correo al profesional con PDFs + notificación interna.
  //
  // Va FUERA de la transacción, así que a esta altura la asignación ya está
  // confirmada en BD: si el correo falla, la respuesta no puede ser un error —
  // el administrador creería que no se asignó y lo intentaría de nuevo. Se
  // responde 200 avisando que el envío quedó pendiente.
  const supportUrl = `${env.publicAppUrl}/soporte?token=${result.token}`;
  const urlSoportesPrincipal = supportUrl;
  const fecha = fechaCO(result.orden.fecha_programada);

  // ASG-05 · Invitaciones de calendario, UNA POR FRANJA. Arreglo vacío si la OS
  // se asignó sin fecha, que está permitido: se puede decidir el profesional
  // antes que el día.
  // 7-oct-2026 · Las franjas de CADA asesor: las de NULL son del principal.
  const franjasDe = (profesionalId) => result.franjas.filter(
    (f) => (f.profesional_id ?? result.profesional.id) === profesionalId,
  );
  const invitacionesPara = (profesional, principal) => adjuntosInvitacion(construirInvitaciones({
    orden: result.orden,
    profesional,
    organizador: { nombre: req.user.nombre, correo: req.user.correo },
    secuencia: result.secuenciaCalendario,
    franjas: franjasDe(profesional.id),
    previas: result.franjasPrevias[profesional.id] ?? 0,
    // El administrador va en copia de todos: sin esto las invitaciones de dos
    // asesores compartirían UID y en su calendario una pisaría a la otra.
    sufijoUid: principal ? '' : `-${String(profesional.id).slice(0, 8)}`,
  }));

  const o = result.orden;
  const esRepro = result.esReprogramacion;
  const lugar = [o.direccion, o.ciudad_ejecucion].filter(Boolean).join(', ');
  const contacto = [o.contacto_sst_nombre, o.contacto_sst_telefono].filter(Boolean).join(' · ');
  // A3-01 · Una orden particular no lleva formatos A PROPÓSITO: no se anuncia
  // que "llegarán aparte", como cuando a una ARL le faltan por cargar.
  const particular = !o.arl_id;
  const sinFormatos = !result.docs.length && !particular;
  // SUP · Qué tiene que devolver, dicho en el mismo correo que le manda a la
  // visita. Antes el correo hablaba de "los soportes firmados" en abstracto y la
  // lista solo aparecía al abrir el portal, ya de vuelta de la empresa.
  // El registro fotográfico se ofrece pero no se exige (30-sep-2026): el correo lo dice.
  const obligatorios = result.entrega.soportes.filter((c) => !esOpcional(c));
  const opcionales = result.entrega.soportes.filter((c) => esOpcional(c));
  const queDevolver = [
    listaEtiquetas(obligatorios),
    opcionales.length ? `y, si la empresa lo permite, ${listaEtiquetas(opcionales)} (opcional)` : '',
  ].filter(Boolean).join(' ');
  // FOR · Qué va adjunto, con su nombre y en el orden en que se generó.
  //
  // El correo hablaba de "los formatos de la ARL" en abstracto y describía lo
  // que había que hacer con ellos —imprimirlos y completar asistentes, temas,
  // observaciones y firmas— como si todas las órdenes llevaran lo mismo. Una
  // asistencia técnica de Bolívar lleva un PDF y un informe en Word, y de ese
  // segundo no se imprime nada. Se enumera lo que de verdad viaja.
  // 7-oct-2026 · Con varios asesores cada uno recibe SU juego (su horario y sus
  // horas): los documentos traen `_profesionalId`; los que no, son de todos.
  const docsDe = (profesionalId) => result.docs.filter(
    (d) => !d._profesionalId || d._profesionalId === profesionalId,
  );
  const adjuntosDe = (docs) => {
    const adjuntos = [];
    for (const d of docs) {
      const etiqueta = d._etiqueta || d.tipo;
      const ya = adjuntos.find((a) => a.etiqueta === etiqueta);
      // Los de alcance 'sesion' salen repetidos, uno por franja: se cuentan en
      // vez de repetir la misma línea tres veces.
      if (ya) ya.copias += 1;
      else adjuntos.push({ etiqueta, copias: 1, prediligenciado: d._prediligenciado !== false });
    }
    const listaAdjuntos = adjuntos.map(
      (a) => (a.copias > 1 ? `${a.etiqueta} · ${a.copias} juegos, uno por franja` : a.etiqueta),
    );
    const hayPrediligenciados = adjuntos.some((a) => a.prediligenciado);
    const hayTalCual = adjuntos.some((a) => !a.prediligenciado);
    // Cada frase solo aparece si le corresponde un adjunto de esa clase.
    const queHacerConEllos = [
      hayPrediligenciados
        ? `Los formatos en PDF van ya diligenciados con los datos de esta orden: imprímelos y ` +
          `completa en la sesión lo que falta (asistentes, temas desarrollados, observaciones y firmas).`
        : null,
      hayTalCual
        ? `Los documentos de Word, Excel o PowerPoint no se pueden prediligenciar: los redactas tú ` +
          `con los datos de esta orden.`
        : null,
    ].filter(Boolean);
    return { listaAdjuntos, queHacerConEllos };
  };
  // Los viáticos se dicen ANTES de la visita: el profesional decide cómo viaja
  // con ese dato, y descubrirlos al recibir la cuenta de cobro llega tarde.
  // Con la categoría delante: "Transporte intermunicipal · $45.000" dice qué se
  // le reconoce, que es lo que el profesional necesita para decidir cómo viaja.
  const viaticos = Number(o.viaticos_valor) || 0;
  const viaticosTexto = viaticos > 0
    ? [o.viaticos_tipo, enPesosCO(viaticos)].filter(Boolean).join(' · ')
    : null;
  // ASG · Si los formatos van a nombre de OTRO, el profesional tiene que
  // enterarse por este correo. Si no, abre el AT-031, ve un nombre que no es el
  // suyo y llama por teléfono creyendo que hubo un error de la plataforma.
  const notaSuplente = result.formatosProf
    ? `Los formatos de esta orden salen a nombre de ${result.formatosProf.nombre}, que es quien ` +
      `está registrado ante ${o.arl_nombre}. La visita la ejecuta usted: firme como asistente y ` +
      `deje el nombre impreso tal como viene.`
    : null;

  // 5-oct-2026 · Con varios asesores en la orden, CADA UNO recibe el correo con
  // los formatos y las invitaciones, y con SUS horas. El enlace de soportes es
  // uno por orden y lo lleva el principal: una casilla guarda un solo documento,
  // y dos personas subiendo a la vez se pisarían.
  const equipo = result.coasesores;
  const horasCo = equipo.reduce((t, c) => t + Number(c.horas), 0);
  const horasPrincipal = Math.max(0, Number(o.horas_asignadas ?? 0) - horasCo);
  const companeros = (excluirId) => [
    { id: result.profesional.id, nombre: result.profesional.nombre, horas: horasPrincipal },
    ...equipo.map((c) => ({ id: c.profesional_id, nombre: c.nombre, horas: Number(c.horas) })),
  ].filter((p) => p.id !== excluirId).map((p) => `${p.nombre} (${horasTexto(p.horas)} h)`);

  /** `dest`: a quién se le escribe, cuántas horas son suyas y si es el principal. */
  const enviarCorreoA = async (dest) => {
    const invitaciones = invitacionesPara(dest.profesional, dest.principal);
    // 7-oct-2026 · Cada asesor sube SUS soportes, por su propio enlace.
    const supportUrl = dest.principal
      ? urlSoportesPrincipal
      : `${env.publicAppUrl}/soporte?token=${result.tokens[dest.profesional.id]}`;
    // Su horario, sus documentos y la fecha de SU primera franja.
    const suyas = franjasDe(dest.profesional.id);
    const varias = suyas.length > 1;
    const fechaDest = suyas.length ? fechaCO(instanteCO(suyas[0].fecha, suyas[0].hora_inicio)) : fecha;
    const docsDest = docsDe(dest.profesional.id);
    const { listaAdjuntos, queHacerConEllos } = adjuntosDe(docsDest);
    const horasDest = equipo.length ? horasTexto(dest.horas) : horasTexto(o.horas_asignadas);
    const notaEquipo = equipo.length
      ? `Esta orden la ejecutan varios asesores, cada uno con su horario y sus horas. ` +
        `De las ${horasTexto(o.horas_asignadas)} h de la orden, a usted le corresponden ${horasTexto(dest.horas)} h, ` +
        `en el horario que aparece en este correo. ` +
        `Va con: ${companeros(dest.profesional.id).join(', ')}. ` +
        `Cada asesor sube sus propios soportes, por el enlace de su correo.`
      : null;
    await sendEmail({
      to: dest.profesional.correo,
      // El administrador que asigna va en copia para que la invitación entre
      // también en SU calendario: el requisito pide los dos, no solo el asesor.
      cc: req.user.correo || undefined,
      subject: esRepro
        ? `OS reprogramada · ${o.codigo} · ${o.empresa_nombre || ''}`
        : `Nueva OS asignada · ${o.codigo} · ${o.empresa_nombre || ''}`,
      // La versión en texto se conserva íntegra: es lo que ve quien lee en texto
      // plano y lo que queda en los registros del driver 'console'.
      text:
        `Hola ${dest.profesional.nombre},\n\n` +
        (esRepro
          ? `La OS ${o.codigo} (${o.pagador_nombre ?? o.arl_nombre}) para ${o.empresa_nombre} fue REPROGRAMADA.\n`
          : `Se te asignó la OS ${o.codigo} (${o.pagador_nombre ?? o.arl_nombre}) para ${o.empresa_nombre}.\n`) +
        // Con la visita partida, una sola "fecha programada" se queda corta: lo
        // que el profesional necesita saber es cada franja.
        (varias
          ? `La visita se realiza en ${suyas.length} franjas:\n${franjasEnTexto(suyas)}\n`
          : `Fecha programada: ${fechaDest}\n`) +
        `Horas: ${horasDest}\n` +
        (notaEquipo ? `${notaEquipo}\n` : '') +
        (lugar ? `Lugar: ${lugar}\n` : '') +
        (contacto ? `Contacto SST: ${contacto}\n` : '') +
        (notaSuplente ? `\n${notaSuplente}\n` : '') +
        '\n' +
        // Sin plantillas activas para la ARL no hay PDFs que adjuntar (CFG-03):
        // prometer unos formatos que no van deja al profesional buscándolos.
        (particular ? '' : sinFormatos
          ? `Los formatos de esta ARL todavía no están cargados en la plataforma; ` +
            `te los haremos llegar aparte.\n\n`
          : `Documentos adjuntos de ${o.arl_nombre}:\n` +
            listaAdjuntos.map((a) => `  · ${a}\n`).join('') +
            `\n${queHacerConEllos.join(' ')}\n\n`) +
        // La lista concreta, también en texto plano. Estaba calculada y no se
        // imprimía: quien lee el correo en texto solo veía «los soportes
        // firmados», que es justo lo que este bloque vino a quitar.
        (queDevolver ? `Al terminar tendrás que subir: ${queDevolver}.\n` : '') +
        `Enlace para subir los soportes (sin login):\n${supportUrl}\n` +
        (invitaciones.length
          ? `\nAdjuntamos ${invitaciones.length === 1 ? 'la invitación' : `${invitaciones.length} invitaciones`} para tu calendario.\n`
          : ''),
      html: correoHtml({
        titulo: esRepro ? 'Visita reprogramada' : 'Nueva orden de servicio asignada',
        subtitulo: `${o.codigo} · ${o.empresa_nombre || ''}`,
        pie: 'JD&D Consultores · Seguridad y Salud en el Trabajo',
        cuerpo: [
          parrafo(`Hola ${dest.profesional.nombre},`),
          parrafo(
            esRepro
              ? `La visita de esta orden cambió de programación. Estos son los datos vigentes; ` +
                `los anteriores ya no aplican.`
              : `Te asignamos la siguiente orden de servicio. Abajo tienes los formatos y el ` +
                `enlace para subir los soportes al terminar.`,
          ),
          tablaDatos([
            filaDato('Orden', o.codigo),
            filaDato(o.arl_id ? 'ARL' : 'Cliente', o.pagador_nombre ?? o.arl_nombre),
            filaDato('Empresa', o.empresa_nombre),
            filaDato('Horas', horasDest),
            // Los viáticos de la orden son del asesor principal.
            filaDato('Viáticos aprobados', dest.principal ? viaticosTexto : null),
            filaDato('Lugar', lugar),
            filaDato('Contacto SST', contacto),
            filaDato('Formatos a nombre de', result.formatosProf?.nombre ?? null),
          ]),
          // Con una sola franja el bloque igual se usa: es donde el ojo va a
          // buscar el cuándo, y mantenerlo evita dos maquetas distintas.
          bloqueLista(
            varias ? `La visita se realiza en ${suyas.length} franjas` : 'Fecha de la visita',
            suyas.length ? suyas.map(franjaEnTexto) : [fechaDest],
          ),
          particular ? '' : sinFormatos
            ? bloqueAviso(
                'Los formatos de esta ARL todavía no están cargados en la plataforma. ' +
                'Te los haremos llegar aparte.',
              )
            // Los documentos por su nombre, no "los formatos de la ARL": lo que
            // se lista es exactamente lo que trae ESTE correo.
            : bloqueLista(`Documentos adjuntos de ${o.arl_nombre}`, listaAdjuntos),
          particular || sinFormatos ? '' : parrafo(queHacerConEllos.join(' ')),
          // ASG · El nombre impreso no es el suyo, y hay que decírselo aquí: es
          // lo primero que va a ver al abrir el PDF adjunto.
          notaSuplente ? bloqueAviso(notaSuplente) : '',
          notaEquipo ? bloqueAviso(notaEquipo) : '',
          // La regla de la ARL, cuando hay algo que explicar: por qué esta
          // capacitación virtual no lleva AT-028, o que hay que redactar un
          // informe. Va como aviso destacado, no como un párrafo más.
          result.entrega.nota ? bloqueAviso(result.entrega.nota) : '',
          // Lo que tendrá que devolver, ANTES de ir a la visita: descubrir en el
          // portal que hacía falta una firma más obliga a volver a la empresa.
          result.entrega.soportes.length
            ? bloqueLista(
                'Al terminar tendrás que subir',
                result.entrega.soportes.map((c) => etiquetaCategoria(c) + (esOpcional(c) ? ' (opcional)' : '')),
              )
            : '',
          parrafo('Cuando termines la visita, sube los soportes firmados desde aquí (no necesitas iniciar sesión):'),
          boton('Subir soportes firmados', supportUrl),
          enlaceCrudo(supportUrl),
        ].join(''),
      }),
      attachments: [
        ...docsDest.map((d) => ({ filename: d._filename, content: d._buffer })),
        ...invitaciones,
      ],
    });
  };

  let correoEnviado = true;
  let correoError = null;
  const destinatarios = [
    { profesional: result.profesional, horas: horasPrincipal, principal: true },
    ...equipo.map((c) => ({
      profesional: { id: c.profesional_id, nombre: c.nombre, correo: c.correo, usuario_id: c.usuario_id },
      horas: Number(c.horas), principal: false,
    })),
  ];
  for (const dest of destinatarios) {
    try {
      await enviarCorreoA(dest);
    } catch (e) {
      // Uno que falle no impide escribirle a los demás; se avisa de cuál fue.
      correoEnviado = false;
      correoError = `${dest.profesional.nombre}: ${e?.message || 'no fue posible entregar el correo.'}`;
      console.error('[assign] correo no enviado:', correoError);
    }
  }

  // La campanita es informativa: tampoco debe tumbar una asignación válida.
  for (const dest of destinatarios) {
    if (!dest.profesional.usuario_id) continue;
    try {
      await notify({
        userId: dest.profesional.usuario_id,
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
  // FOR · Cuando la matriz tuvo que decidir con un dato que falta (sin tipo de
  // actividad, sin la letra del AT-031, sin horas) se dice AQUÍ, que es el único
  // momento en que alguien puede corregirlo antes de que el profesional ejecute.
  const avisoEntrega = avisoDeEntrega(result.orden, result.entrega);
  // ASG · La vigencia caducada no bloquea la asignación (la fecha la teclea un
  // administrador y puede estar sin actualizar), pero sí se dice: si el registro
  // de verdad venció, la ARL va a devolver el radicado.
  const avisoFormatos = result.formatosProf?.vencido
    ? `El registro de ${result.formatosProf.nombre} ante ${result.orden.arl_nombre} figura ` +
      `vencido el ${result.formatosProf.vigente_hasta}. Los formatos salieron a su nombre; ` +
      'confirme la vigencia con la ARL o actualícela en Profesionales.'
    : null;
  res.json({
    message: correoEnviado
      ? `OS ${accion}, formatos generados y correo enviado.`
      : `OS ${accion} y formatos generados, pero el correo al profesional no salió.`,
    completa: true,
    correo_enviado: correoEnviado,
    correo_error: correoError,
    // Qué se envió y qué se le pedirá de vuelta, para poder enseñarlo sin
    // volver a pedir la orden.
    entrega: {
      tipo_actividad: result.entrega.tipo,
      formatos: result.docs.map((d) => d.tipo),
      soportes: result.entrega.soportes,
      // Los dos avisos se juntan aquí y no en dos campos: la vista los enseña en
      // el mismo sitio y separarlos solo obligaría a repetir el mismo `if`.
      aviso: [avisoFormatos, avisoEntrega].filter(Boolean).join(' ') || null,
    },
    // ASG · A nombre de quién salieron los formatos, cuando no es el ejecutor.
    profesional_formatos: result.formatosProf
      ? { id: result.formatosProf.id, nombre: result.formatosProf.nombre }
      : null,
    // CFG-03 · Cuántos formatos salieron adjuntos. En cero el correo llegó sin
    // documentos porque la ARL no tiene plantillas activas, y eso hay que
    // decírselo a quien asigna: es un vacío de configuración, no del envío.
    formatos_generados: result.docs.length,
    data: {
      ...result.orden,
      support_url: supportUrl,
      documentos: result.docs.map(({ _buffer, ...d }) => d),
      franjas: result.franjas,
      coasesores: result.coasesores,
    },
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

/**
 * VER-01 · Soportes de la OS, **ordenados por categoría**: primero el acta (es
 * la que decide si la visita se da por buena), luego la asistencia y luego las
 * evidencias. Antes salían por hora de subida, que es el orden en que el
 * profesional los fue eligiendo en el móvil y no le sirve a quien revisa.
 */
router.get('/:id/supports', asyncHandler(async (req, res) => {
  // 7-oct-2026 · Con varios asesores cada uno sube lo suyo: los archivos traen
  // de quién son y salen agrupados por asesor (el principal primero).
  const r = await pool.query(
    `SELECT s.*, COALESCE(s.profesional_id, o.profesional_asignado_id) AS de_profesional_id,
              p.nombre AS profesional_nombre
         FROM sst.archivos_soporte s
         JOIN sst.ordenes_servicio o ON o.id = s.orden_id
         LEFT JOIN sst.profesionales p ON p.id = COALESCE(s.profesional_id, o.profesional_asignado_id)
        WHERE s.orden_id=$1
      ORDER BY (s.profesional_id IS NOT NULL), p.nombre,
               CASE s.categoria
                 WHEN 'acta' THEN 1 WHEN 'asistencia' THEN 2 WHEN 'evidencias' THEN 3
                 WHEN 'informe' THEN 4
                 ELSE 9 END,
               s.subido_en`,
    [req.params.id]
  );
  const principal = (await pool.query(
    `SELECT o.profesional_asignado_id AS profesional_id, p.nombre
       FROM sst.ordenes_servicio o LEFT JOIN sst.profesionales p ON p.id = o.profesional_asignado_id
      WHERE o.id=$1`, [req.params.id]
  )).rows[0];
  const sinEntregar = new Set((await asesoresSinEntregar(req.params.id)).map((x) => x.profesional_id));
  const equipo = principal?.profesional_id
    ? [
        { profesional_id: principal.profesional_id, nombre: principal.nombre, principal: true },
        ...(await coasesoresDeOrden(req.params.id)).map((x) => ({ profesional_id: x.profesional_id, nombre: x.nombre, principal: false })),
      ].map((m) => ({ ...m, entregado: !sinEntregar.has(m.profesional_id) }))
    : [];
  // SUP · Las casillas que se le pidieron a ESTA orden viajan con los archivos.
  //
  // Quien revisa las necesita para dos cosas: saber que falta algo que no está
  // (una casilla vacía es un motivo de rechazo tan válido como un acta sin
  // firmar) y no poder devolver un documento que nunca se pidió. Van aquí y no
  // en una petición aparte porque se usan en la misma pantalla y a la vez.
  const req_ = await pool.query(
    `SELECT soportes_requeridos FROM sst.ordenes_servicio WHERE id=$1`, [req.params.id]
  );
  res.json({ data: r.rows, casillas: casillasDeOrden(req_.rows[0]?.soportes_requeridos), equipo });
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
  // Las casillas de ESTA orden: devolver una que nunca se le pidió dejaría el
  // portal esperando un documento que el profesional no tiene por qué entregar,
  // y la orden atascada en PROGRAMADA para siempre.
  const suyas = casillasDeOrden(
    (await pool.query(`SELECT soportes_requeridos FROM sst.ordenes_servicio WHERE id=$1`, [req.params.id]))
      .rows[0]?.soportes_requeridos,
  ).map((c) => c.clave);

  // 7-oct-2026 · Y A QUIÉN. Con varios asesores cada uno sube lo suyo, así que el
  // rechazo dice de quién es cada documento: `devueltos: [{ categoria,
  // profesional_id }]`. `categorias` (el cuerpo de antes) se entiende como del
  // asesor principal.
  const previa = (await pool.query(
    `SELECT profesional_asignado_id FROM sst.ordenes_servicio WHERE id=$1`, [req.params.id]
  )).rows[0];
  if (!previa) throw badRequest('OS no encontrada');
  const principalId = previa.profesional_asignado_id;
  const adicionales = await coasesoresDeOrden(req.params.id);

  const devueltosBruto = Array.isArray(req.body?.devueltos) ? req.body.devueltos : null;
  const pedidas = Array.isArray(req.body?.categorias) ? req.body.categorias : null;
  let lista;
  if (devueltosBruto || pedidas) {
    lista = devueltosBruto
      ? devueltosBruto.map((d) => ({ categoria: d?.categoria, profesional_id: String(d?.profesional_id ?? '').trim() || null }))
      : pedidas.map((c) => ({ categoria: c, profesional_id: null }));
    const invalidas = lista.filter((d) => !esCategoriaValida(d.categoria)).map((d) => d.categoria);
    if (invalidas.length) throw badRequest(`Documento desconocido: ${invalidas.join(', ')}.`);
    lista = lista.map((d) => ({ ...d, categoria: normalizarCategoria(d.categoria) }));
    if (!lista.length) throw badRequest('Marque al menos un documento para devolver al profesional.');
    const ajenas = [...new Set(lista.map((d) => d.categoria).filter((c) => !suyas.includes(c)))];
    if (ajenas.length) {
      throw badRequest(
        `A esta orden no se le pidió ${listaEtiquetas(ajenas)}, así que no se puede devolver. ` +
        `Sus documentos son: ${listaEtiquetas(suyas)}.`,
      );
    }
  } else {
    // Sin lista (cliente antiguo): se devuelve lo que cada uno tiene subido.
    const conArchivo = (await pool.query(
      `SELECT DISTINCT COALESCE(categoria,'otros') AS categoria, profesional_id
         FROM sst.archivos_soporte WHERE orden_id=$1`, [req.params.id]
    )).rows.map((r) => ({ categoria: normalizarCategoria(r.categoria), profesional_id: r.profesional_id }));
    lista = conArchivo.length ? conArchivo : suyas.map((c) => ({ categoria: c, profesional_id: null }));
  }
  // Por asesor ('' = el principal).
  const porAsesor = new Map();
  for (const d of lista) {
    const de = !d.profesional_id || d.profesional_id === principalId ? '' : d.profesional_id;
    if (de && !adicionales.some((c) => c.profesional_id === de)) {
      throw badRequest('Se marcó un documento de un asesor que no está en esta orden.');
    }
    porAsesor.set(de, [...new Set([...(porAsesor.get(de) ?? []), d.categoria])]);
  }
  const categorias = [...new Set(lista.map((d) => d.categoria))];
  const delPrincipal = porAsesor.get('') ?? [];

  const orden = await changeStatus({ orderId: req.params.id, newStatus: 'PROGRAMADA', userId: req.user.sub, motivo });
  // Reabrir enlace público para re-cargar soportes.
  await pool.query(`UPDATE sst.enlaces_publicos SET activo=true WHERE orden_id=$1`, [req.params.id]);
  // Solo estas casillas quedan abiertas en el portal de cada uno; las demás, bloqueadas.
  await pool.query(
    `UPDATE sst.ordenes_servicio
        SET soportes_rechazados     = $2,
            soportes_rechazo_motivo = $3,
            soportes_rechazados_en  = now(),
            actualizado_en = now()
      WHERE id = $1`,
    [req.params.id, delPrincipal.length ? delPrincipal : null, motivo.trim()]
  );
  if (delPrincipal.length) {
    await pool.query(
      `UPDATE sst.enlaces_publicos SET entregado_en = NULL WHERE orden_id=$1 AND profesional_id IS NULL`,
      [req.params.id]
    );
  }
  for (const [de, suyasDevueltas] of porAsesor) {
    if (!de) continue;
    const upd = await pool.query(
      `UPDATE sst.enlaces_publicos SET rechazados = $3, entregado_en = NULL, activo = true
        WHERE orden_id=$1 AND profesional_id=$2`,
      [req.params.id, de, suyasDevueltas]
    );
    if (!upd.rowCount) {
      await pool.query(
        `INSERT INTO sst.enlaces_publicos (orden_id, token, profesional_id, rechazados) VALUES ($1,$2,$3,$4)`,
        [req.params.id, randomToken(24), de, suyasDevueltas]
      );
    }
  }

  const expandida = await getOrderExpanded(req.params.id);

  // La campanita solo llega si la ficha del profesional está enlazada con una
  // cuenta de acceso, y muchas no lo están; además el profesional trabaja en
  // campo y no vive dentro de la plataforma. Sin correo, un rechazo podía
  // quedarse semanas sin que se enterara nadie.
  let correoEnviado = false;
  let correoError = null;
  // Se le escribe a CADA asesor al que se le devolvió algo, con su enlace y su lista.
  for (const [de, suyasDevueltas] of porAsesor) {
    const profId = de || principalId;
    const prof = profId
      ? (await pool.query(`SELECT nombre, correo, usuario_id FROM sst.profesionales WHERE id=$1`, [profId])).rows[0]
      : null;
    const listaDocs = listaEtiquetas(suyasDevueltas);
    if (prof?.correo) {
      const enlace = await pool.query(
        `SELECT token FROM sst.enlaces_publicos
          WHERE orden_id=$1 AND activo AND profesional_id IS NOT DISTINCT FROM $2
          ORDER BY creado_en DESC LIMIT 1`,
        [req.params.id, de || null]
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
            `Revisamos los soportes de la OS ${expandida.codigo} (${expandida.pagador_nombre ?? expandida.arl_nombre}) ` +
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
                filaDato(expandida.arl_id ? 'ARL' : 'Cliente', expandida.pagador_nombre ?? expandida.arl_nombre),
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
        correoError = `${prof.nombre}: ${e?.message || 'no fue posible entregar el correo.'}`;
        console.error('[reject] correo no enviado:', correoError);
      }
    }

    if (prof?.usuario_id) {
      await notify({
        userId: prof.usuario_id, tipo: 'RECHAZO', titulo: 'Soportes rechazados',
        mensaje: motivo, datos: { orden_id: orden.id },
      }).catch((e) => console.error('[reject] notificación interna no creada:', e?.message));
    }
  }

  res.json({
    message: correoEnviado && !correoError
      ? 'Soportes rechazados; la OS vuelve a PROGRAMADA y el profesional fue avisado por correo.'
      : 'Soportes rechazados; la OS vuelve a PROGRAMADA.',
    correo_enviado: correoEnviado && !correoError,
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

// ================= 30-sep-2026 · Cobro de la orden y «Validado plataforma» =================

/** Desglose del cobro (honorarios + gastos), comparación con la prefactura y aprobación. */
router.get('/:id/cobro-detalle', asyncHandler(async (req, res) => {
  res.json({ data: await detalleCobro(req.params.id) });
}));

/**
 * Corregir el valor hora y los gastos. La contadora también puede: es quien
 * suele tener la tarifa a mano. Si cambia el total de una orden ya aprobada, la
 * aprobación se cae y operación tiene que volver a darla.
 */
router.put('/:id/cobro-valores', requireRole('admin', 'administrativo', 'contador'), asyncHandler(async (req, res) => {
  res.json({ data: await guardarValores(req.params.id, req.body, req.user.sub) });
}));

/** Visto bueno de operación: solo con él la orden pasa a Facturación y a la contabilidad. */
router.post('/:id/cobro-aprobacion', requireRole(...ROLES_APRUEBAN), asyncHandler(async (req, res) => {
  res.json({ data: await aprobarCobro(req.params.id, req.body, req.user.sub) });
}));

router.delete('/:id/cobro-aprobacion', requireRole(...ROLES_APRUEBAN), asyncHandler(async (req, res) => {
  res.json({ data: await retirarAprobacion(req.params.id, req.body, req.user.sub) });
}));

/**
 * «Validado plataforma»: alguien comprobó la orden en la plataforma de la ARL.
 * Es un check a mano que no bloquea nada (decisión del 30-sep-2026) y es
 * distinto del estado ARL, que lo pone la prefactura.
 */
router.patch('/:id/validado-plataforma', requireRole('admin', 'administrativo', 'contador'), asyncHandler(async (req, res) => {
  const validado = req.body?.validado === true;
  // Solo se valida en plataforma lo que ya se ejecutó (30-sep-2026): antes no hay
  // nada que la ARL pueda ver. Desmarcar sí se permite siempre, para corregir.
  if (validado) {
    const e = (await pool.query(`SELECT estado::text AS estado FROM sst.ordenes_servicio WHERE id=$1`, [req.params.id])).rows[0];
    if (!e) throw badRequest('Orden no encontrada');
    if (!['EJECUTADA', 'FINALIZADA'].includes(e.estado)) {
      throw badRequest(`La orden está ${e.estado}: se valida en plataforma cuando ya está EJECUTADA.`);
    }
  }
  const r = await pool.query(
    `UPDATE sst.ordenes_servicio
        SET validado_plataforma_en  = CASE WHEN $2 THEN now() ELSE NULL END,
            validado_plataforma_por = CASE WHEN $2 THEN $3::uuid ELSE NULL END,
            actualizado_en = now()
      WHERE id = $1
      RETURNING id, validado_plataforma_en`,
    [req.params.id, validado, req.user.sub],
  );
  if (!r.rows[0]) throw badRequest('Orden no encontrada');
  const u = validado
    ? (await pool.query(`SELECT nombre FROM sst.usuarios WHERE id=$1`, [req.user.sub])).rows[0]
    : null;
  res.json({
    data: {
      validado_plataforma_en: r.rows[0].validado_plataforma_en,
      validado_plataforma_por_nombre: u?.nombre ?? null,
    },
  });
}));

/**
 * 1-oct-2026 · N.º de radicado ante Bolívar. Lo escribe JD&D a mano para mapear
 * la orden con lo que radicó; solo existe en Bolívar. Vacío lo borra.
 */
router.patch('/:id/radicado', requireRole('admin', 'administrativo', 'contador'), asyncHandler(async (req, res) => {
  const numero = String(req.body?.numero_radicado ?? '').trim().replace(/\s+/g, ' ') || null;
  if (numero && numero.length > 40) throw badRequest('El n.º de radicado no puede pasar de 40 caracteres.');
  const o = (await pool.query(
    `SELECT a.nombre AS arl FROM sst.ordenes_servicio o JOIN sst.arls a ON a.id = o.arl_id WHERE o.id = $1`,
    [req.params.id],
  )).rows[0];
  if (!o) throw badRequest('Orden no encontrada');
  if (!esBolivar(o.arl)) throw badRequest('El n.º de radicado solo aplica a las órdenes de Bolívar.');
  const r = await pool.query(
    `UPDATE sst.ordenes_servicio
        SET numero_radicado     = $2,
            numero_radicado_en  = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END,
            numero_radicado_por = CASE WHEN $2::text IS NULL THEN NULL ELSE $3::uuid END,
            actualizado_en = now()
      WHERE id = $1
      RETURNING numero_radicado`,
    [req.params.id, numero, req.user.sub],
  );
  res.json({ data: { numero_radicado: r.rows[0].numero_radicado } });
}));

export default router;
