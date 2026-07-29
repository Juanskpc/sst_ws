import { pool, withTransaction } from '../../config/db.js';
import { env } from '../../config/env.js';
import { randomToken } from '../../utils/security.js';
import { badRequest, notFound } from '../../utils/httpError.js';
import { sendEmail } from '../../services/email.service.js';
import { generatePrecuentaPdf } from '../../services/pdf.service.js';

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
 * PRE-02 · Valor hora aplicable a una orden.
 *
 * Orden de resolución: tarifa del profesional para el tipo de actividad vigente
 * al cierre del periodo → valor_hora base del profesional. Se devuelve también
 * el origen para poder explicar la cifra en pantalla.
 *
 * Hoy la mayoría de OS llega sin `tipo_actividad` (la extracción no siempre lo
 * trae), así que el fallback es el camino normal, no la excepción.
 */
async function resolverValorHora({ profesionalId, tipoActividad, hasta, valorHoraBase }, client = pool) {
  if (tipoActividad) {
    const r = await client.query(
      `SELECT valor_hora FROM sst.tarifas_actividad_profesional
        WHERE profesional_id=$1 AND lower(actividad)=lower($2) AND vigente_desde <= $3::date
        ORDER BY vigente_desde DESC LIMIT 1`,
      [profesionalId, tipoActividad, hasta]
    );
    if (r.rows[0]) return { valorHora: Number(r.rows[0].valor_hora), origen: 'tarifa' };
  }
  return { valorHora: Number(valorHoraBase) || 0, origen: 'profesional' };
}

/**
 * PRE-01 · Genera (o recalcula) las pre-cuentas de un periodo.
 *
 * Idempotente: una pre-cuenta por profesional y periodo. Volver a generar
 * recalcula las que siguen abiertas —útil si se cerró una OS tarde o se corrigió
 * una tarifa— pero NO toca las que el profesional ya aceptó o rechazó: esas son
 * un acuerdo cerrado y se informan como omitidas.
 *
 * `profesionalId` opcional restringe la generación a uno solo.
 */
export async function generarPrecuentas({ periodo, profesionalId = null, userId = null }) {
  const { inicio, fin } = rangoPeriodo(periodo);

  const params = [inicio, fin];
  let filtroProf = '';
  if (profesionalId) {
    params.push(profesionalId);
    filtroProf = ` AND h.profesional_id = $${params.length}`;
  }

  // Todas las OS ejecutadas del mes, con lo necesario para valorarlas.
  const trabajo = await pool.query(
    // `profesional_nombre` ya viene en la vista; aquí solo se agrega la tarifa base.
    `SELECT h.*, p.valor_hora AS valor_hora_base
       FROM sst.vw_horas_ejecutadas h
       JOIN sst.profesionales p ON p.id = h.profesional_id
      WHERE h.fecha_ejecucion BETWEEN $1::date AND $2::date${filtroProf}
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
    const existente = (await pool.query(
      `SELECT id, estado FROM sst.precuentas WHERE profesional_id=$1 AND periodo=$2`,
      [profId, periodo]
    )).rows[0];

    if (existente && CERRADAS.includes(existente.estado)) {
      omitidas.push({
        precuenta_id: existente.id,
        profesional_id: profId,
        profesional_nombre: ordenes[0].profesional_nombre,
        estado: existente.estado,
        motivo: `Ya fue ${existente.estado} por el profesional`,
      });
      continue;
    }

    // Valora cada orden ANTES de abrir la transacción (son consultas de lectura).
    const items = [];
    let totalHoras = 0;
    let totalMonto = 0;
    for (const o of ordenes) {
      const { valorHora, origen } = await resolverValorHora({
        profesionalId: profId,
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
        actividad: o.tipo_actividad || o.actividad_economica,
        fecha_ejecucion: o.fecha_ejecucion,
        horas,
        valor_hora_snapshot: valorHora,
        monto,
        origen_tarifa: origen,
      });
    }

    const precuenta = await withTransaction(async (client) => {
      const pc = (await client.query(
        `INSERT INTO sst.precuentas (profesional_id, periodo, total_horas, total_monto, estado, token, generado_por)
         VALUES ($1,$2,$3,$4,'generada',$5,$6)
         ON CONFLICT (profesional_id, periodo) DO UPDATE
           SET total_horas=EXCLUDED.total_horas, total_monto=EXCLUDED.total_monto,
               estado='generada', generado_por=EXCLUDED.generado_por, actualizado_en=now()
         RETURNING *`,
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
  if (!pc) throw notFound('Pre-cuenta no encontrada');
  const items = await client.query(
    `SELECT * FROM sst.precuenta_items WHERE precuenta_id=$1 ORDER BY fecha_ejecucion, orden_codigo`,
    [id]
  );
  return { ...pc, items: items.rows };
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
      return { enviada: false, motivo: `La pre-cuenta ya fue ${pc.estado} por el profesional` };
    }
    if (!pc.profesional_correo) return { enviada: false, motivo: 'El profesional no tiene correo registrado' };

    const pdf = await generatePrecuentaPdf(pc);
    const url = urlPrecuenta(pc.token);
    const mes = periodoLargo(pc.periodo);

    await sendEmail({
      to: pc.profesional_correo,
      subject: `Pre-cuenta de cobro · ${mes} — JD&D Consultores`,
      text:
        `Sr(a). ${pc.profesional_nombre},\n\n` +
        `Adjuntamos la pre-cuenta de cobro correspondiente a ${mes}:\n\n` +
        `  · Órdenes ejecutadas: ${pc.total_ordenes}\n` +
        `  · Total de horas:     ${Number(pc.total_horas)}\n` +
        `  · Total a pagar:      ${enPesos(pc.total_monto)}\n\n` +
        `Por favor revísela y acéptela o recházala (indicando el motivo) en el siguiente enlace:\n${url}\n\n` +
        `Si algo no cuadra, el rechazo con observaciones nos permite revisarlo antes de facturar.\n\n` +
        `JD&D Consultores en Sistemas de Gestión\n`,
      attachments: [{ filename: `precuenta_${pc.periodo}.pdf`, content: pdf }],
    });

    const upd = (await pool.query(
      `UPDATE sst.precuentas SET estado='enviada', enviado_en=now(), actualizado_en=now()
        WHERE id=$1 RETURNING *`, [id]
    )).rows[0];
    return { enviada: true, precuenta: upd, url };
  } catch (e) {
    console.error('[precuenta] no se pudo enviar:', e?.message);
    return { enviada: false, motivo: e?.message || 'Error enviando la pre-cuenta' };
  }
}

/** Resuelve el token del enlace público → pre-cuenta con ítems. */
export async function resolverToken(token) {
  const pc = (await pool.query(`SELECT id FROM sst.precuentas WHERE token=$1`, [token])).rows[0];
  if (!pc) throw notFound('Pre-cuenta no encontrada o enlace inválido');
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
    throw badRequest('Para rechazar la pre-cuenta debe indicar las observaciones');
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
    if (!existe.rows[0]) throw notFound('Pre-cuenta no encontrada o enlace inválido');
    throw badRequest(`Esta pre-cuenta ya fue ${existe.rows[0].estado}.`);
  }
  return obtenerPrecuenta(r.rows[0].id);
}
