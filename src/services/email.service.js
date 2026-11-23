import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { LOGO_CID, LOGO_JDD_CID, adjuntoLogo, adjuntoLogoJdd } from './email-layout.service.js';

let transporter = null;
if (env.email.driver === 'smtp' && env.email.host) {
  if (env.nodeEnv !== 'production' && !env.email.redirectTo) {
    console.warn('⚠️  [EMAIL] SMTP real SIN EMAIL_REDIRECT_TO fuera de producción: los correos llegarán a los destinatarios de verdad.');
  }
  transporter = nodemailer.createTransport({
    host: env.email.host,
    port: env.email.port,
    secure: env.email.port === 465,
    auth: env.email.user ? { user: env.email.user, pass: env.email.pass } : undefined,
  });
}

/**
 * Envía un correo. En driver 'console' (default) lo imprime en consola,
 * de modo que el flujo M5/M11 funciona end-to-end sin SMTP real.
 */
export async function sendEmail({ to, cc, subject, text, html, attachments }) {
  // SOLO DESARROLLO · `EMAIL_REDIRECT_TO`. La base de desarrollo tiene correos de
  // clientes REALES (los contactos que trae el SIPAB) y de profesionales, así que
  // probar con SMTP real mandaría encuestas y asignaciones a gente de verdad. Con
  // la variable puesta, todo sale solo a esa dirección y el asunto dice a quién
  // iba: se prueba el correo completo (adjuntos incluidos) sin tocar a nadie.
  if (env.email.redirectTo) {
    const original = [to, cc].flat().filter(Boolean).join(', ') || '(sin destinatario)';
    subject = `[PRUEBA · para ${original}] ${subject}`;
    to = env.email.redirectTo;
    cc = undefined;
  }
  if (!transporter) {
    console.log('\n📧 [EMAIL · console]');
    console.log(`   Para:    ${to}`);
    if (cc) console.log(`   Copia:   ${cc}`);
    console.log(`   Asunto:  ${subject}`);
    if (text) console.log(`   Texto:   ${text.split('\n').join('\n            ')}`);
    if (attachments?.length) console.log(`   Adjuntos: ${attachments.map((a) => a.filename).join(', ')}`);
    console.log('');
    return { queued: true, driver: 'console' };
  }
  // 22-nov-2026 · El logo de ORBITA de la cabecera (`correoHtml`) viaja como
  // imagen en línea (`cid:`), no como enlace: así se ve sin «mostrar imágenes».
  // Se añade aquí, una sola vez, para que ningún remitente tenga que acordarse.
  // No es un adjunto más para quien lo recibe: va dentro del cuerpo.
  if (html?.includes(`cid:${LOGO_CID}`) && !attachments?.some((a) => a.cid === LOGO_CID)) {
    const logo = adjuntoLogo();
    if (logo) attachments = [...(attachments ?? []), logo];
  }
  // 23-nov-2026 · Lo mismo con el logo de JD&D de los correos a clientes.
  if (html?.includes(`cid:${LOGO_JDD_CID}`) && !attachments?.some((a) => a.cid === LOGO_JDD_CID)) {
    const logo = adjuntoLogoJdd();
    if (logo) attachments = [...(attachments ?? []), logo];
  }
  const info = await transporter.sendMail({
    from: env.email.from,
    to, cc, subject, text, html, attachments,
  });
  return { queued: true, driver: 'smtp', messageId: info.messageId };
}
