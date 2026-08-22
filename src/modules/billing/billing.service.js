import { pool, withTransaction } from '../../config/db.js';
import { env } from '../../config/env.js';
import { randomToken } from '../../utils/security.js';
import { badRequest, notFound } from '../../utils/httpError.js';
import { sendEmail } from '../../services/email.service.js';
import { generatePrecuentaPdf } from '../../services/pdf.service.js';
import {
  correoHtml, parrafo, tablaDatos, filaDato, bloqueTotal, bloqueLista, bloqueAviso,
  boton, enlaceCrudo,
} from '../../services/email-layout.service.js';
import { fechaDiaCO, horasConUnidad } from '../../utils/formato.js';

/** Estados de una pre-cuenta. Desde aceptada/rechazada no se regenera sola. */
export const ESTADOS_PRECUENTA = ['generada', 'enviada', 'aceptada', 'rechazada'];
const CERRADAS = ['aceptada', 'rechazada'];

/** `2026-07` → { inicio: '2026-07-01', fin: '2026-07-31' } (fin inclusive). */
export function rangoPeriodo(periodo) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(periodo || ''))) {
    throw badRequest('El periodo debe tener el formato AAAA-MM (p.ej. 2026-07)');
  }
  const [y, m] = periodo.split('-').map(Number);
  const inicio = new Date(Date.UTC(y, m - 1, 1));
  const fin = new Date(Date.UTC(y, m, 0));
  return { inicio: inicio.toISOString().slice(0, 10), fin: fin.toISOString().slice(0, 10) };
}

export const urlPrecuenta = (token) => `${env.publicAppUrl}/precuenta?token=${token}`;

/** Formato de pesos colombianos para correo y PDF. */
export const enPesos = (v) =>
  new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 })
    .format(Number(v) || 0);

/**
 * PRE-02 · Valor hora con el que se cobra una orden.
 *
 * Lo primero que se mira es lo que la ORDEN trae congelado (`valor_hora_cobro`,
 * copiado al asignar el profesional). Ese es el punto de todo el cambio: subir
 * mañana la hora de "Capacitación" no puede reescribir lo que ya se trabajó, y
 * menos lo que ya se le envió al profesional.
 *
 * Solo si la orden no lo trae —las anteriores a la columna— se resuelve al
 * vuelo, con el mismo orden que usa la asignación: tarifa del profesional para
 * ese tipo → valor del tipo → valor base del profesional.
 */
async function resolverValorHora(
  { profesionalId, valorHoraCongelado, origenCongelado, tipoOrden, tipoActividad, hasta, valorHoraBase },
  client = pool,
) {
  if (Number(valorHoraCongelado) > 0) {
    return { valorHora: Number(valorHoraCongelado), origen: origenCongelado || 'orden' };
  }

  // El nombre del TIPO DE ORDEN es el que casa con las tarifas por profesional;
  // `tipo_actividad` (el título que trae la ARL, "CAP SEGURIDAD VIAL") se sigue
  // mirando después por las órdenes viejas, que es de donde salía antes.
  for (const clave of [tipoOrden, tipoActividad].filter(Boolean)) {
    const r = await client.query(
      `SELECT valor_hora FROM sst.tarifas_actividad_profesional
        WHERE profesional_id=$1 AND lower(actividad)=lower($2) AND vigente_desde <= $3::date
        ORDER BY vigente_desde DESC LIMIT 1`,
      [profesionalId, clave, hasta]
    );
    if (r.rows[0]) return { valorHora: Number(r.rows[0].valor_hora), origen: 'tarifa' };
  }
  if (tipoOrden) {
    const t = await client.query(
      `SELECT valor_hora FROM sst.tipos_orden WHERE lower(btrim(nombre))=lower(btrim($1))`,
      [tipoOrden]
    );
    if (Number(t.rows[0]?.valor_hora) > 0) {
      return { valorHora: Number(t.rows[0].valor_hora), origen: 'tipo' };
    }
  }
  return { valorHora: Number(valorHoraBase) || 0, origen: 'profesional' };
}

/**
 * PRE-01 · Lo que se ve al entrar en Cuentas de cobro: una fila por
 * **profesional y mes** con trabajo por cobrar del año pedido.
 *
 * La fila existe desde que se aceptan los soportes de la primera orden de ese
 * mes; no hace falta "generar" nada para verla. Si ya hay cuenta creada, la fila
 * trae su id y su estado; si no, `estado` viene nulo y se entiende como
 * pendiente de generar.
 *
 * Los totales se calculan al vuelo con las tarifas de HOY, así que una fila sin
 * cuenta refleja siempre lo último. En cuanto la cuenta existe manda su cifra
 * congelada: es la que el profesional recibió y sobre la que respondió.
 */
export async function resumenPorMes({ anio, client = pool }) {
  const y = Number(anio);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) {
    throw badRequest('El año debe ser un número de cuatro cifras.');
  }

  const trabajo = await client.query(
    `SELECT h.*, p.valor_hora AS valor_hora_base
       FROM sst.vw_horas_por_cobrar h
       JOIN sst.profesionales p ON p.id = h.profesional_id
      WHERE h.periodo LIKE $1
      ORDER BY h.periodo DESC, h.profesional_nombre, h.fecha_ejecucion`,
    [`${y}-%`]
  );

  const cuentas = await client.query(
    `SELECT * FROM sst.vw_precuentas WHERE periodo LIKE $1`, [`${y}-%`]
  );

  // Trabajo PENDIENTE agrupado por profesional y mes. La vista ya excluye lo
  // que está dentro de una cuenta, así que aquí solo queda lo que nadie ha
  // cobrado todavía.
  const grupos = new Map();
  for (const o of trabajo.rows) {
    const clave = `${o.periodo}|${o.profesional_id}`;
    if (!grupos.has(clave)) {
      grupos.set(clave, {
        periodo: o.periodo,
        profesional_id: o.profesional_id,
        profesional_nombre: o.profesional_nombre,
        total_horas: 0,
        total_monto: 0,
        total_ordenes: 0,
        // Cuántas de sus órdenes quedarían valoradas en cero: es lo que impide
        // generar la cuenta, y hay que poder señalarlo antes de intentarlo.
        ordenes_sin_tarifa: 0,
      });
    }
    const g = grupos.get(clave);
    const { valorHora } = await resolverValorHora({
      profesionalId: o.profesional_id,
      valorHoraCongelado: o.valor_hora_cobro,
      origenCongelado: o.valor_hora_origen,
      tipoOrden: o.tipo_orden,
      tipoActividad: o.tipo_actividad,
      hasta: rangoPeriodo(o.periodo).fin,
      valorHoraBase: o.valor_hora_base,
    }, client);
    const horas = Number(o.horas) || 0;
    g.total_horas += horas;
    g.total_monto += Math.round(horas * valorHora);
    g.total_ordenes += 1;
    if (!(valorHora > 0)) g.ordenes_sin_tarifa += 1;
  }

  // Las CUENTAS ya creadas y el trabajo PENDIENTE son filas distintas, aunque
  // caigan en el mismo profesional y mes.
  //
  // Antes se fundían en una sola: si existía cuenta, mandaban sus cifras
  // congeladas y el trabajo finalizado después quedaba tapado — una cuenta
  // aceptada en agosto escondía las siete órdenes que se cerraron esa misma
  // semana. Separadas, la cuenta se lee como lo que es (un acuerdo cerrado) y lo
  // nuevo se ve como lo que es (dinero por cobrar), y se le puede emitir una
  // cuenta complementaria.
  const filas = [
    ...cuentas.rows.map((c) => ({
      periodo: c.periodo,
      profesional_id: c.profesional_id,
      profesional_nombre: c.profesional_nombre,
      total_horas: Number(c.total_horas),
      total_monto: Number(c.total_monto),
      total_ordenes: c.total_ordenes,
      ordenes_sin_tarifa: 0,
      precuenta_id: c.id,
      estado: c.estado,
      enviado_en: c.enviado_en ?? null,
      respondido_en: c.respondido_en ?? null,
      observaciones: c.observaciones ?? null,
      // Cuál es dentro de su mes: de la 2 en adelante son complementarias.
      numero: c.numero,
      del_mes: c.del_mes,
    })),
    ...[...grupos.values()].map((g) => ({
      ...g,
      precuenta_id: null,
      estado: null,
      enviado_en: null,
      respondido_en: null,
      observaciones: null,
      numero: null,
      // Si ya hay cuentas de ese mes, esto es un complemento por generar.
      del_mes: cuentas.rows.filter(
        (c) => c.periodo === g.periodo && c.profesional_id === g.profesional_id,
      ).length,
    })),
  ];

  filas.sort((a, b) =>
    b.periodo.localeCompare(a.periodo)
    || a.profesional_nombre.localeCompare(b.profesional_nombre)
    // Dentro del mismo profesional y mes: primero lo que falta por cobrar.
    || (a.precuenta_id === null ? -1 : 1));
  return filas;
}

/**
 * CFG-05 · Aviso del día de corte.
 *
 * El día de corte es una fecha del mes —del 1 al 28— y no dispara nada por su
 * cuenta: el despliegue no tiene tareas programadas. Lo que hace es esto:
 * pasado ese día, si el MES ANTERIOR todavía tiene trabajo sin cobrar, se le
 * avisa por la campanita a quien puede resolverlo (administradores y
 * contadores). Nada más — no genera cuentas ni manda correos.
 *
 * Se comprueba al abrir Cuentas de cobro y al entrar al panel de inicio, que es
 * lo más parecido a un cron que hay aquí. El aviso se crea UNA vez por periodo y
 * usuario: la condición se cumple todos los días hasta que alguien cobre, y sin
 * la deduplicación la campanita se llenaría del mismo aviso.
 *
 * Nunca lanza: es un efecto secundario de abrir una pantalla, no la operación
 * que el usuario pidió.
 */
export async function avisarCorteDeCobro(client = pool) {
  try {
    const cfg = await client.query(
      `SELECT valor FROM sst.configuracion WHERE clave='precuenta_dia_corte'`
    );
    const dia = Number(cfg.rows[0]?.valor) || 5;
    const hoy = new Date();
    if (hoy.getDate() < dia) return { avisado: false, motivo: 'Todavía no llega el día de corte.' };

    // El mes anterior al de hoy, en formato AAAA-MM.
    const anterior = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
    const periodo = `${anterior.getFullYear()}-${String(anterior.getMonth() + 1).padStart(2, '0')}`;

    const pendiente = await client.query(
      `SELECT count(*)::int AS ordenes,
              count(DISTINCT profesional_id)::int AS profesionales,
              coalesce(sum(round(horas * coalesce(valor_hora_cobro, 0))), 0)::bigint AS monto
         FROM sst.vw_horas_por_cobrar WHERE periodo = $1`,
      [periodo]
    );
    const p = pendiente.rows[0];
    if (!p || p.ordenes === 0) return { avisado: false, motivo: `${periodo} no tiene trabajo sin cobrar.` };

    const r = await client.query(
      `INSERT INTO sst.notificaciones (usuario_id, tipo, titulo, mensaje, datos)
       SELECT u.id, 'CORTE_COBRO',
              'Cuentas de cobro pendientes',
              $2, jsonb_build_object('periodo', $1::text)
         FROM sst.usuarios u
        WHERE u.activo AND u.rol IN ('admin','contador')
          AND NOT EXISTS (
            SELECT 1 FROM sst.notificaciones n
             WHERE n.usuario_id = u.id AND n.tipo = 'CORTE_COBRO'
               AND n.datos->>'periodo' = $1::text
          )
       RETURNING id`,
      [
        periodo,
        `${periodoLargo(periodo)}: quedan ${p.ordenes} orden(es) de ${p.profesionales} ` +
        `profesional(es) sin cuenta de cobro, por ${enPesos(p.monto)}.`,
      ]
    );
    return { avisado: r.rowCount > 0, periodo, avisos: r.rowCount, pendiente: p };
  } catch (e) {
    console.error('[corte] no se pudo generar el aviso:', e?.message);
    return { avisado: false, motivo: e?.message };
  }
}

/** Años en los que hay trabajo por cobrar, para el selector de la vista. */
export async function aniosConTrabajo(client = pool) {
  const r = await client.query(
    `SELECT DISTINCT left(periodo, 4) AS anio FROM sst.vw_horas_por_cobrar
      UNION SELECT DISTINCT left(periodo, 4) FROM sst.precuentas
      ORDER BY anio DESC`
  );
  return r.rows.map((x) => Number(x.anio)).filter(Number.isInteger);
}

/**
 * PRE-01 · Genera (o recalcula) las cuentas de cobro de un periodo.
 *
 * Solo entra el trabajo que **todavía no está en ninguna cuenta**: la vista
 * `vw_horas_por_cobrar` ya excluye lo facturado.
 *
 * Si la cuenta del mes sigue ABIERTA (generada o enviada), se recalcula sobre
 * ella —útil si se cerró una OS tarde o se corrigió una tarifa—. Si ya está
 * ACEPTADA no se toca nunca: es un acuerdo cerrado, y lo nuevo se emite como
 * cuenta **complementaria** del mismo mes, igual que una factura complementaria.
 * Antes esto era imposible —había un índice único por profesional y periodo— y
 * el trabajo finalizado tarde se quedaba sin cobrar.
 *
 * PRE-07 · `precuentaId` REHACE una cuenta RECHAZADA. Un rechazo no es un
 * acuerdo: es un documento devuelto para corregir. Antes las órdenes de una
 * cuenta rechazada quedaban atrapadas en ella —no entraban en ninguna
 * generación nueva—, así que pulsar "Generar" sobre esa fila no encontraba
 * trabajo y no hacía nada. Con la cuenta señalada, sus órdenes vuelven a entrar,
 * se revalorizan con las tarifas de hoy y la cuenta vuelve a quedar 'generada',
 * lista para reenviarse al profesional.
 *
 * `profesionalId` opcional restringe la generación a uno solo.
 */
export async function generarPrecuentas({ periodo, profesionalId = null, precuentaId = null, userId = null }) {
  const { inicio, fin } = rangoPeriodo(periodo);

  // La cuenta que se está rehaciendo, si se pidió una. Tiene que ser de este
  // mismo profesional y periodo (si no, se estaría reescribiendo la cuenta de
  // otro) y no puede estar aceptada.
  let rehacer = null;
  if (precuentaId) {
    rehacer = (await pool.query(
      `SELECT id, estado, profesional_id, periodo FROM sst.precuentas WHERE id=$1`,
      [precuentaId]
    )).rows[0];
    if (!rehacer) throw badRequest('La cuenta de cobro que se quiere rehacer no existe.');
    if (rehacer.estado === 'aceptada') {
      throw badRequest('La cuenta ya fue aceptada por el profesional; no se puede rehacer.');
    }
    if (rehacer.periodo !== periodo || (profesionalId && rehacer.profesional_id !== profesionalId)) {
      throw badRequest('La cuenta de cobro no corresponde a ese profesional y mes.');
    }
    profesionalId = rehacer.profesional_id;
  }

  const params = [inicio, fin];
  let filtroProf = '';
  if (profesionalId) {
    params.push(profesionalId);
    filtroProf = ` AND h.profesional_id = $${params.length}`;
  }

  // Las OS del mes con los soportes aceptados y todavía sin cobrar… más las que
  // ya están dentro de una cuenta ABIERTA de este mismo periodo (recalcular una
  // cuenta abierta tiene que volver a incluir lo que ya contenía, o la dejaría
  // vacía) y las de la cuenta rechazada que se esté rehaciendo. Lo que está en
  // una cuenta ACEPTADA no vuelve a entrar nunca.
  params.push(periodo);
  const iPeriodo = params.length;
  params.push(rehacer?.id ?? null);
  const iRehacer = params.length;
  const trabajo = await pool.query(
    `SELECT h.*, p.valor_hora AS valor_hora_base
       FROM sst.vw_horas_ejecutadas h
       JOIN sst.profesionales p ON p.id = h.profesional_id
      WHERE h.soportes_aceptados_en IS NOT NULL
        AND h.fecha_ejecucion BETWEEN $1::date AND $2::date${filtroProf}
        AND NOT EXISTS (
          SELECT 1
            FROM sst.precuenta_items i
            JOIN sst.precuentas pc ON pc.id = i.precuenta_id
           WHERE i.orden_id = h.orden_id
             AND pc.id IS DISTINCT FROM $${iRehacer}::uuid
             AND NOT (pc.periodo = $${iPeriodo}
                      AND pc.profesional_id = h.profesional_id
                      AND pc.estado NOT IN ('aceptada','rechazada'))
        )
      ORDER BY h.profesional_id, h.fecha_ejecucion`,
    params
  );

  // Agrupa por profesional antes de tocar la BD: una transacción por
  // pre-cuenta, no una por orden.
  const porProfesional = new Map();
  for (const row of trabajo.rows) {
    if (!porProfesional.has(row.profesional_id)) porProfesional.set(row.profesional_id, []);
    porProfesional.get(row.profesional_id).push(row);
  }

  const generadas = [];
  const omitidas = [];

  for (const [profId, ordenes] of porProfesional) {
    const existente = rehacer && rehacer.profesional_id === profId
      ? { id: rehacer.id, estado: rehacer.estado }
      : (await pool.query(
          // La ABIERTA, si la hay: es la única que se recalcula sola. La aceptada
          // se queda como está y lo nuevo irá a una cuenta complementaria; la
          // rechazada solo se rehace si se pidió por `precuentaId`.
          `SELECT id, estado FROM sst.precuentas
            WHERE profesional_id=$1 AND periodo=$2 AND estado NOT IN ('aceptada','rechazada')
            ORDER BY creado_en DESC LIMIT 1`,
          [profId, periodo]
        )).rows[0];

    // Valora cada orden ANTES de abrir la transacción (son consultas de lectura).
    const items = [];
    let totalHoras = 0;
    let totalMonto = 0;
    for (const o of ordenes) {
      const { valorHora, origen } = await resolverValorHora({
        profesionalId: profId,
        valorHoraCongelado: o.valor_hora_cobro,
        origenCongelado: o.valor_hora_origen,
        tipoOrden: o.tipo_orden,
        tipoActividad: o.tipo_actividad,
        hasta: fin,
        valorHoraBase: o.valor_hora_base,
      });
      const horas = Number(o.horas) || 0;
      const monto = Math.round(horas * valorHora);
      totalHoras += horas;
      totalMonto += monto;
      items.push({
        orden_id: o.orden_id,
        orden_codigo: o.orden_codigo,
        empresa_nombre: o.empresa_nombre,
        arl_nombre: o.arl_nombre,
        actividad: o.tipo_orden || o.tipo_actividad || o.actividad_economica,
        fecha_ejecucion: o.fecha_ejecucion,
        horas,
        valor_hora_snapshot: valorHora,
        monto,
        origen_tarifa: origen,
      });
    }

    // PRE-02 · Una cuenta de cobro en cero no es una cuenta de cobro. Pasa
    // cuando el profesional tiene horas pero ninguna tarifa aplicable —ficha sin
    // `valor_hora` y sin tarifa por actividad—, y hasta ahora se generaba igual:
    // se le mandaba al profesional un documento pidiéndole que aceptara cobrar
    // $0. Se omite y se dice qué hay que arreglar.
    const sinTarifa = items.filter((it) => !(Number(it.valor_hora_snapshot) > 0)).length;
    if (totalMonto <= 0) {
      omitidas.push({
        precuenta_id: existente?.id ?? null,
        profesional_id: profId,
        profesional_nombre: ordenes[0].profesional_nombre,
        estado: existente?.estado ?? null,
        motivo: sinTarifa
          ? `${sinTarifa} de sus ${items.length} orden(es) no tienen valor hora. ` +
            `Defina la tarifa del profesional (o la de la actividad) antes de generar.`
          : 'El total quedaría en $0; revise las horas y la tarifa antes de generar.',
      });
      continue;
    }

    const precuenta = await withTransaction(async (client) => {
      // Sobre la abierta se recalcula; si no hay, nace una nueva (que puede ser
      // la segunda del mes: la complementaria).
      const pc = existente
        ? (await client.query(
            `UPDATE sst.precuentas
                SET total_horas=$2, total_monto=$3, estado='generada',
                    generado_por=$4, actualizado_en=now(),
                    -- Rehacer un rechazo deja una cuenta NUEVA sobre el mismo
                    -- registro: las marcas de envío y respuesta son de la
                    -- versión que el profesional devolvió y ya no describen
                    -- esta. Las observaciones sí se conservan: son el motivo
                    -- que hay que haber corregido.
                    enviado_en    = CASE WHEN estado = 'rechazada' THEN NULL ELSE enviado_en END,
                    respondido_en = CASE WHEN estado = 'rechazada' THEN NULL ELSE respondido_en END
              WHERE id=$1 RETURNING *`,
            [existente.id, totalHoras, totalMonto, userId]
          )).rows[0]
        : (await client.query(
            `INSERT INTO sst.precuentas
               (profesional_id, periodo, total_horas, total_monto, estado, token, generado_por)
             VALUES ($1,$2,$3,$4,'generada',$5,$6) RETURNING *`,
            [profId, periodo, totalHoras, totalMonto, randomToken(24), userId]
          )).rows[0];

      // Los ítems se reemplazan completos: recalcular es rehacer el detalle.
      await client.query(`DELETE FROM sst.precuenta_items WHERE precuenta_id=$1`, [pc.id]);
      for (const it of items) {
        await client.query(
          `INSERT INTO sst.precuenta_items
             (precuenta_id, orden_id, orden_codigo, empresa_nombre, arl_nombre, actividad,
              fecha_ejecucion, horas, valor_hora_snapshot, monto, origen_tarifa)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [pc.id, it.orden_id, it.orden_codigo, it.empresa_nombre, it.arl_nombre, it.actividad,
           it.fecha_ejecucion, it.horas, it.valor_hora_snapshot, it.monto, it.origen_tarifa]
        );
      }
      return pc;
    });

    generadas.push({
      ...precuenta,
      profesional_nombre: ordenes[0].profesional_nombre,
      total_ordenes: items.length,
    });
  }

  return { periodo, generadas, omitidas };
}

/** Pre-cuenta + sus ítems, o 404. */
export async function obtenerPrecuenta(id, client = pool) {
  const pc = (await client.query(`SELECT * FROM sst.vw_precuentas WHERE id=$1`, [id])).rows[0];
  if (!pc) throw notFound('Cuenta de cobro no encontrada');
  const items = await client.query(
    `SELECT * FROM sst.precuenta_items WHERE precuenta_id=$1 ORDER BY fecha_ejecucion, orden_codigo`,
    [id]
  );
  return { ...pc, items: items.rows };
}

/**
 * Día de ejecución de un ítem, tal como se imprime en el correo.
 *
 * `fecha_ejecucion` es DATE y el driver la entrega como un `Date` a medianoche
 * **local del proceso**: pasarla por un formateador con zona horaria la correría
 * un día en un servidor en UTC, y el profesional vería su visita del 1 de agosto
 * fechada el 31 de julio, fuera del periodo que está cobrando. Por eso la fecha
 * se arma con los componentes del calendario, sin convertir nada.
 */
function diaEjecucion(valor) {
  if (!valor) return '';
  if (typeof valor === 'string') return fechaDiaCO(valor.slice(0, 10));
  const d = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(d.getTime())) return '';
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return fechaDiaCO(iso);
}

/**
 * Las órdenes que sostienen la cifra, una por línea. El correo enseña las
 * primeras y remite al PDF para el resto: un profesional con treinta visitas
 * recibiría si no un correo de tres pantallas, y el detalle completo —con el
 * valor hora aplicado a cada una— ya va adjunto.
 */
const MAX_ORDENES_CORREO = 8;

function lineasOrdenes(items = []) {
  const lineas = items.slice(0, MAX_ORDENES_CORREO).map((it) => [
    it.orden_codigo,
    it.empresa_nombre,
    diaEjecucion(it.fecha_ejecucion),
    horasConUnidad(it.horas),
    enPesos(it.monto),
  ].filter(Boolean).join(' · '));
  const resto = items.length - lineas.length;
  if (resto > 0) lineas.push(`y ${resto} orden(es) más, en el PDF adjunto`);
  return lineas;
}

/** Mes legible para correos y documento ("julio de 2026"). */
export function periodoLargo(periodo) {
  const [y, m] = String(periodo).split('-').map(Number);
  const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  return `${meses[(m || 1) - 1]} de ${y}`;
}

/**
 * PRE-04 · Envía la pre-cuenta al profesional, con el PDF adjunto (PRE-03) y el
 * enlace para aceptar o rechazar (PRE-05).
 *
 * No lanza: devuelve el detalle para que la ruta informe si el correo falló sin
 * perder el trabajo ya hecho.
 */
export async function enviarPrecuenta(id) {
  try {
    const pc = await obtenerPrecuenta(id);
    if (CERRADAS.includes(pc.estado)) {
      return { enviada: false, motivo: `La cuenta de cobro ya fue ${pc.estado} por el profesional` };
    }
    if (!pc.profesional_correo) return { enviada: false, motivo: 'El profesional no tiene correo registrado' };
    // PRE-02 · Segundo cierre de la misma puerta: una cuenta puede haber quedado
    // en cero antes de que se prohibiera generarlas así, y mandarla sería pedirle
    // al profesional que acepte cobrar $0.
    if (!(Number(pc.total_monto) > 0)) {
      return {
        enviada: false,
        motivo: 'La cuenta de cobro está en $0. Defina el valor hora del profesional y vuelva a generarla.',
      };
    }

    const pdf = await generatePrecuentaPdf(pc);
    const url = urlPrecuenta(pc.token);
    const mes = periodoLargo(pc.periodo);

    const ordenes = lineasOrdenes(pc.items);
    const resumen = `${pc.total_ordenes} orden(es) · ${horasConUnidad(pc.total_horas)}`;

    await sendEmail({
      to: pc.profesional_correo,
      subject: `Cuenta de cobro · ${mes}${pc.numero > 1 ? ' (complementaria)' : ''} — JD&D Consultores`,
      // La versión en texto se conserva íntegra: es lo que ve quien lee en texto
      // plano y lo que queda en el log del driver 'console'.
      text:
        `Sr(a). ${pc.profesional_nombre},\n\n` +
        `Adjuntamos la cuenta de cobro correspondiente a ${mes}:\n\n` +
        `  · Órdenes ejecutadas: ${pc.total_ordenes}\n` +
        `  · Total de horas:     ${Number(pc.total_horas)}\n` +
        `  · Total a pagar:      ${enPesos(pc.total_monto)}\n\n` +
        (ordenes.length ? `${ordenes.map((l) => `  · ${l}`).join('\n')}\n\n` : '') +
        `Por favor revísela y acéptela o recházala (indicando el motivo) en el siguiente enlace:\n${url}\n\n` +
        `Si algo no cuadra, el rechazo con observaciones nos permite revisarlo antes de facturar.\n\n` +
        `JD&D Consultores en Sistemas de Gestión\n`,
      // Misma maqueta de marca que el correo de asignación (M5): el profesional
      // recibe los dos y no tiene por qué reconocer solo uno como nuestro.
      html: correoHtml({
        titulo: 'Cuenta de cobro',
        subtitulo: `${mes} · ${pc.profesional_nombre}`,
        pie: 'JD&D Consultores · Seguridad y Salud en el Trabajo',
        cuerpo: [
          parrafo(`Sr(a). ${pc.profesional_nombre},`),
          parrafo(
            `Esta es la cuenta de cobro por las órdenes de servicio que ejecutó en ${mes}. ` +
            `Revísela y respóndanos desde el enlace; el detalle completo, con el valor hora ` +
            `aplicado a cada orden, va en el PDF adjunto.`,
          ),
          bloqueTotal('Total a pagar', enPesos(pc.total_monto), resumen),
          tablaDatos([
            filaDato('Periodo', mes),
            filaDato('Órdenes ejecutadas', pc.total_ordenes),
            filaDato('Total de horas', horasConUnidad(pc.total_horas)),
          ]),
          bloqueLista('Órdenes incluidas', ordenes),
          parrafo('Acéptela o recházela desde aquí (no necesita iniciar sesión):'),
          boton('Revisar y responder', url),
          enlaceCrudo(url),
          // El rechazo sin motivo lo bloquea `responderPrecuenta`: más vale
          // decirlo antes de que el profesional se tope con el error.
          bloqueAviso(
            'Si algo no cuadra, rechácela indicando el motivo: con esas observaciones ' +
            'podemos revisarlo y corregirlo antes de facturar.',
          ),
        ].join(''),
      }),
      attachments: [{ filename: `cuenta_cobro_.pdf`, content: pdf }],
    });

    const upd = (await pool.query(
      `UPDATE sst.precuentas SET estado='enviada', enviado_en=now(), actualizado_en=now()
        WHERE id=$1 RETURNING *`, [id]
    )).rows[0];
    return { enviada: true, precuenta: upd, url };
  } catch (e) {
    console.error('[precuenta] no se pudo enviar:', e?.message);
    return { enviada: false, motivo: e?.message || 'Error enviando la cuenta de cobro' };
  }
}

/** Resuelve el token del enlace público → pre-cuenta con ítems. */
export async function resolverToken(token) {
  const pc = (await pool.query(`SELECT id FROM sst.precuentas WHERE token=$1`, [token])).rows[0];
  if (!pc) throw notFound('Cuenta de cobro no encontrada o enlace inválido');
  return obtenerPrecuenta(pc.id);
}

/**
 * PRE-06/07 · Respuesta del profesional desde el enlace público.
 *
 * El UPDATE exige que siga sin responder: dos clicks sobre el mismo correo
 * compiten en la BD y solo el primero cuenta. Rechazar sin observaciones no se
 * permite — son justamente lo que hace accionable el rechazo (PRE-07).
 */
export async function responderPrecuenta(token, { decision, observaciones }) {
  if (!['aceptada', 'rechazada'].includes(decision)) {
    throw badRequest('La decisión debe ser "aceptada" o "rechazada"');
  }
  const obs = (observaciones || '').trim();
  if (decision === 'rechazada' && !obs) {
    throw badRequest('Para rechazar la cuenta de cobro debe indicar las observaciones');
  }

  const r = await pool.query(
    `UPDATE sst.precuentas
        SET estado=$2, observaciones=$3, respondido_en=now(), actualizado_en=now()
      WHERE token=$1 AND estado NOT IN ('aceptada','rechazada')
      RETURNING id`,
    [token, decision, obs || null]
  );
  if (!r.rows[0]) {
    const existe = await pool.query(`SELECT estado FROM sst.precuentas WHERE token=$1`, [token]);
    if (!existe.rows[0]) throw notFound('Cuenta de cobro no encontrada o enlace inválido');
    throw badRequest(`Esta pre-cuenta ya fue ${existe.rows[0].estado}.`);
  }
  return obtenerPrecuenta(r.rows[0].id);
}
