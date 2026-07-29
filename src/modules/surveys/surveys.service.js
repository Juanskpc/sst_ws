import { pool } from '../../config/db.js';
import { env } from '../../config/env.js';
import { randomToken } from '../../utils/security.js';
import { badRequest, notFound } from '../../utils/httpError.js';
import { sendEmail } from '../../services/email.service.js';

/** ENC-03 · Enunciados por defecto si nadie los ha configurado todavía. */
const PREGUNTAS_DEFECTO = {
  titulo: 'Encuesta de satisfacción',
  satisfaccion: 'Nivel de satisfacción de la actividad recibida',
  recomendacion: '¿Recomendaría a JD&D Consultores?',
  comentarios: 'Observaciones para mejorar el servicio',
};

/**
 * ENC-03 · Textos vigentes del formulario. Viven en `sst.configuracion` para
 * que se puedan cambiar sin migrar; lo que NO cambia es su significado: las dos
 * escalas son siempre 1-5 y son las que promedia el dashboard (ENC-05).
 */
export async function obtenerPreguntas(client = pool) {
  const r = await client.query(`SELECT valor FROM sst.configuracion WHERE clave='encuesta_preguntas'`);
  return { ...PREGUNTAS_DEFECTO, ...(r.rows[0]?.valor || {}) };
}

export const urlEncuesta = (token) => `${env.publicAppUrl}/encuesta?token=${token}`;

/**
 * ENC-01/02 · Crea la encuesta de una OS y manda el correo al contacto SST de la
 * empresa con el enlace al formulario público.
 *
 * Idempotente por diseño (ENC-06: índice único por orden_id). Si la OS ya tiene
 * encuesta no se crea otra ni se reenvía sola: `reenviar` obliga el envío para
 * el caso en que el correo original se haya perdido.
 *
 * Nunca lanza: se invoca justo después de cerrar una OS y un fallo de SMTP no
 * puede tumbar la verificación, que es la operación que el usuario pidió.
 * Devuelve el detalle para que la ruta lo informe.
 */
export async function enviarEncuesta(ordenId, { reenviar = false } = {}) {
  try {
    const o = (await pool.query(`SELECT * FROM sst.vw_ordenes_expandidas WHERE id=$1`, [ordenId])).rows[0];
    if (!o) return { enviada: false, motivo: 'OS no encontrada' };

    const correo = (o.contacto_sst_correo || '').trim();
    if (!correo) {
      return { enviada: false, motivo: 'La OS no tiene correo de contacto SST' };
    }

    const preguntas = await obtenerPreguntas();

    // Crea la fila solo si no existía; si existía se conserva su token para no
    // invalidar un enlace que el cliente ya pueda tener en su bandeja.
    const ins = await pool.query(
      `INSERT INTO sst.respuestas_encuesta
         (orden_id, contacto_correo, contacto_nombre, token, profesional_id, arl_id, empresa_nombre, preguntas, enviado_en)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
       ON CONFLICT (orden_id) DO NOTHING
       RETURNING *`,
      [
        ordenId, correo, o.contacto_sst_nombre || null, randomToken(24),
        o.profesional_asignado_id || null, o.arl_id, o.empresa_nombre || null,
        JSON.stringify(preguntas),
      ]
    );

    let encuesta = ins.rows[0];
    if (!encuesta) {
      encuesta = (await pool.query(`SELECT * FROM sst.respuestas_encuesta WHERE orden_id=$1`, [ordenId])).rows[0];
      if (encuesta.respondido_en) return { enviada: false, motivo: 'El cliente ya respondió la encuesta', encuesta };
      if (!reenviar) return { enviada: false, motivo: 'La encuesta ya se había enviado', encuesta };
      await pool.query(`UPDATE sst.respuestas_encuesta SET enviado_en=now() WHERE id=$1`, [encuesta.id]);
    }

    const url = urlEncuesta(encuesta.token);
    const saludo = o.contacto_sst_nombre ? `Sr(a). ${o.contacto_sst_nombre}` : 'Cordial saludo';
    await sendEmail({
      to: correo,
      subject: `${preguntas.titulo} · ${o.codigo} — JD&D Consultores`,
      text:
        `${saludo},\n\n` +
        `Hemos finalizado la actividad de seguridad y salud en el trabajo asociada a la ` +
        `orden ${o.codigo}${o.empresa_nombre ? ` de ${o.empresa_nombre}` : ''}.\n\n` +
        `Su opinión nos ayuda a mejorar. La encuesta toma menos de un minuto:\n${url}\n\n` +
        `Actividad: ${o.actividad_economica || 'N/D'}\n` +
        (o.profesional_nombre ? `Profesional a cargo: ${o.profesional_nombre}\n` : '') +
        `\nGracias por confiar en JD&D Consultores.\n`,
    });

    return { enviada: true, encuesta, url };
  } catch (e) {
    console.error('[encuesta] no se pudo enviar:', e?.message);
    return { enviada: false, motivo: e?.message || 'Error enviando la encuesta' };
  }
}

/** Resuelve el token del enlace público → encuesta + datos de la OS. */
export async function resolverToken(token) {
  const r = await pool.query(`SELECT * FROM sst.vw_encuestas WHERE id = (
    SELECT id FROM sst.respuestas_encuesta WHERE token=$1
  )`, [token]);
  if (!r.rows[0]) throw notFound('Encuesta no encontrada o enlace inválido');
  return r.rows[0];
}

/**
 * ENC-04/06 · Registra la respuesta. El UPDATE condicionado a
 * `respondido_en IS NULL` es la defensa real contra el doble envío: dos clicks
 * simultáneos sobre el mismo enlace compiten en la BD, no en memoria.
 */
export async function registrarRespuesta(token, { satisfaccion, recomendacion, comentarios }) {
  const escala = (v, campo) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 5) throw badRequest(`${campo} debe ser un entero entre 1 y 5`);
    return n;
  };
  const sat = escala(satisfaccion, 'La satisfacción');
  const rec = escala(recomendacion, 'La recomendación');

  const r = await pool.query(
    `UPDATE sst.respuestas_encuesta
        SET satisfaccion=$2, recomendacion=$3, comentarios=$4, respondido_en=now()
      WHERE token=$1 AND respondido_en IS NULL
      RETURNING id`,
    [token, sat, rec, (comentarios || '').trim() || null]
  );
  if (!r.rows[0]) {
    // O el token no existe, o ya fue respondido: se distingue para dar un
    // mensaje útil en vez de un 404 genérico.
    const existe = await pool.query(`SELECT respondido_en FROM sst.respuestas_encuesta WHERE token=$1`, [token]);
    if (!existe.rows[0]) throw notFound('Encuesta no encontrada o enlace inválido');
    throw badRequest('Esta encuesta ya fue respondida. ¡Gracias por su tiempo!');
  }
  return resolverToken(token);
}
