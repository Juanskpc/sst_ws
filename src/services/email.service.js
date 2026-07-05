import nodemailer from 'nodemailer';
import { env } from '../config/env.js';

let transporter = null;
if (env.email.driver === 'smtp' && env.email.host) {
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
export async function sendEmail({ to, subject, text, html, attachments }) {
  if (!transporter) {
    console.log('\n📧 [EMAIL · console]');
    console.log(`   Para:    ${to}`);
    console.log(`   Asunto:  ${subject}`);
    if (text) console.log(`   Texto:   ${text.split('\n').join('\n            ')}`);
    if (attachments?.length) console.log(`   Adjuntos: ${attachments.map((a) => a.filename).join(', ')}`);
    console.log('');
    return { queued: true, driver: 'console' };
  }
  const info = await transporter.sendMail({
    from: env.email.from,
    to, subject, text, html, attachments,
  });
  return { queued: true, driver: 'smtp', messageId: info.messageId };
}
