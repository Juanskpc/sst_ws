import { pool } from '../../config/db.js';
import { env } from '../../config/env.js';
import { randomToken } from '../../utils/security.js';
import { badRequest, notFound } from '../../utils/httpError.js';
import { sendEmail } from '../../services/email.service.js';
import {
  correoHtml, parrafo, tablaDatos, filaDato, boton, enlaceCrudo,
} from '../../services/email-layout.service.js';

/**
 * ENC-03 · Enunciados por defecto si nadie los ha configurado todavía.
 *
 * Son CUATRO y califican dos cosas distintas: las dos primeras al profesional
 * que dictó la actividad —de ahí sale su promedio en el listado de asesores— y
 * la tercera a JD&D como empresa. Antes solo estaban la general y la de
 * recomendación, así que no había forma de saber a quién correspondía una nota
 * baja: si a quien fue, o a la empresa que lo mandó.
 */
const PREGUNTAS_DEFECTO = {
  titulo: 'Encuesta de satisfacción',
  satisfaccion: '¿Qué tan satisfecho quedó con la actividad que dictó el profesional?',
  profesional: 'Califique al profesional según: puntualidad, dominio del tema y claridad al resolver dudas',
  recomendacion: '¿Recomendaría a JD&D Consultores?',
  comentarios: 'Observaciones sobre el profesional o el servicio',
};

/**
 * Tope del comentario. Es opcional y de texto libre, pero se pinta en la tabla
 * de Informes y en la ficha del profesional: sin límite, un correo entero
 * pegado en la caja rompe las dos vistas. La BD lo repite como CHECK, que es la
 * única barrera que no se puede saltar.
 */
export const LIMITE_COMENTARIOS = 500;

/**
 * Completa una encuesta guardada con los enunciados que hoy existen.
 *
 * Cada fila conserva los suyos (para que una encuesta vieja se lea como se
 * envió), y eso deja a las que ya estaban en la bandeja sin la pregunta del
 * profesional. Rellenar los que falten hace que también la respondan, que es lo
 * que se quiere: la redacción vieja se respeta, la pregunta nueva se añade.
 */
export function conDefectos(preguntas) {
  return { ...PREGUNTAS_DEFECTO, ...(preguntas || {}) };
}

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
    // La misma maqueta que la asignación, el rechazo y la cuenta de cobro: es
    // el único correo que le llega al CLIENTE, y salía en texto plano mientras
    // los internos iban con la marca puesta.
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
      html: correoHtml({
        titulo: preguntas.titulo,
        subtitulo: `${o.codigo}${o.empresa_nombre ? ` · ${o.empresa_nombre}` : ''}`,
        pie: 'JD&D Consultores · Seguridad y Salud en el Trabajo',
        cuerpo: [
          parrafo(`${saludo},`),
          parrafo(
            'Terminamos la actividad de seguridad y salud en el trabajo que se detalla abajo. ' +
            'Nos ayuda mucho saber cómo le pareció: son tres preguntas y toma menos de un minuto.',
          ),
          tablaDatos([
            filaDato('Orden', o.codigo),
            filaDato('Empresa', o.empresa_nombre),
            filaDato('Actividad', o.actividad_economica),
            filaDato('Profesional a cargo', o.profesional_nombre),
            filaDato('ARL', o.arl_nombre),
          ]),
          parrafo('Se califica tanto al profesional que asistió como al servicio de JD&D Consultores.'),
          boton('Responder la encuesta', url),
          enlaceCrudo(url),
        ].join(''),
      }),
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
  // Los enunciados se completan al leer, no al guardar: así una encuesta ya
  // enviada muestra también la pregunta del profesional en vez de quedarse con
  // el formulario de tres campos que existía cuando salió.
  return { ...r.rows[0], preguntas: conDefectos(r.rows[0].preguntas) };
}

/**
 * ENC-04/06 · Registra la respuesta. El UPDATE condicionado a
 * `respondido_en IS NULL` es la defensa real contra el doble envío: dos clicks
 * simultáneos sobre el mismo enlace compiten en la BD, no en memoria.
 */
export async function registrarRespuesta(
  token, { satisfaccion, calificacion_profesional, recomendacion, comentarios },
) {
  const escala = (v, campo) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 5) {
      throw badRequest(`${campo} se responde con una nota de 1 a 5.`);
    }
    return n;
  };
  const sat = escala(satisfaccion, 'La satisfacción con la actividad');
  const rec = escala(recomendacion, 'La recomendación');
  // La nota del profesional es obligatoria como las otras dos: es la que
  // alimenta su promedio, y dejarla opcional habría hecho que el asesor sin
  // encuestas y el asesor sin calificar se vieran igual.
  const prof = escala(calificacion_profesional, 'La calificación del profesional');

  const texto = (comentarios || '').trim();
  if (texto.length > LIMITE_COMENTARIOS) {
    throw badRequest(
      `Las observaciones no pueden pasar de ${LIMITE_COMENTARIOS} caracteres (escribió ${texto.length}).`,
    );
  }

  const r = await pool.query(
    `UPDATE sst.respuestas_encuesta
        SET satisfaccion=$2, calificacion_profesional=$3, recomendacion=$4,
            comentarios=$5, respondido_en=now()
      WHERE token=$1 AND respondido_en IS NULL
      RETURNING id`,
    [token, sat, prof, rec, texto || null]
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
