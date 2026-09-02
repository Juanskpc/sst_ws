/**
 * Comprueba que la cuenta del cliente puede enviar correo con su contraseña de
 * aplicación, ANTES de que exista el VPS. Replica exactamente lo que hace
 * sst_ws/src/services/email.service.js: mismo transporte, mismo `from`.
 *
 * La contraseña NO se escribe aquí: llega por variable de entorno y no queda en
 * ningún archivo.
 *
 *   SMTP_PASS='xxxxxxxxxxxxxxxx' node probar-smtp.mjs destino@ejemplo.com
 */
import nodemailer from 'nodemailer';

const CUENTA = 'redes.jddconsultores@gmail.com';
const FROM = `ORBITA · JD&D Consultores <${CUENTA}>`;

const pass = (process.env.SMTP_PASS || '').replace(/\s+/g, ''); // Google la muestra en 4 bloques
const destino = process.argv[2];

if (!pass) {
  console.error('✖ Falta SMTP_PASS (la contraseña de aplicación de 16 caracteres).');
  process.exit(1);
}
if (pass.length !== 16) {
  console.error(`✖ SMTP_PASS tiene ${pass.length} caracteres; una contraseña de aplicación tiene 16.`);
  process.exit(1);
}
if (!destino) {
  console.error('✖ Falta el correo de destino como argumento.');
  process.exit(1);
}

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false, // 587 = STARTTLS, igual que en email.service.js
  auth: { user: CUENTA, pass },
});

try {
  await transporter.verify();
  console.log('✔ Autenticación aceptada por smtp.gmail.com');
} catch (err) {
  console.error('✖ Gmail rechazó la autenticación:', err.message);
  console.error('  535 = contraseña de aplicación mal copiada, revocada, o 2FA no activa en esa cuenta.');
  process.exit(1);
}

const info = await transporter.sendMail({
  from: FROM,
  to: destino,
  subject: 'ORBITA · prueba de envío desde la cuenta del cliente',
  text:
    'Si este correo llegó, la cuenta redes.jddconsultores@gmail.com puede enviar\n' +
    'los correos del sistema (asignaciones, .ics, enlaces de soportes y cuentas de cobro).\n\n' +
    'Lo importante es COMPROBAR EL REMITENTE que aparece en la bandeja: debe decir\n' +
    'ORBITA · JD&D Consultores. Si dice otra cosa, Gmail reescribió el From.',
});

console.log('✔ Enviado ·', info.messageId);
console.log('→ Revisa la bandeja de', destino, 'y confirma el nombre del remitente.');
