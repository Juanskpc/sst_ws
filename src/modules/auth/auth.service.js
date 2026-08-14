/**
 * Servicio de autenticación (M1 · AUTH-03/06).
 * Concentra la lógica de recuperación de contraseña y la auditoría de eventos,
 * de modo que las rutas queden delgadas y la base quede lista para futuras
 * capacidades (verificación de correo, bloqueo por intentos, etc.).
 */
import { pool } from '../../config/db.js';
import { env } from '../../config/env.js';
import { randomToken, hashToken, hashPassword } from '../../utils/security.js';
import { sendEmail } from '../../services/email.service.js';

/** Eventos auditables. Mantener nombres estables: son datos, no código. */
export const EVENTOS = {
  LOGIN_EXITOSO: 'login_exitoso',
  LOGIN_FALLIDO: 'login_fallido',
  RECUPERACION_SOLICITADA: 'recuperacion_solicitada',
  RECUPERACION_CORREO_DESCONOCIDO: 'recuperacion_correo_desconocido',
  RECUPERACION_LIMITADA: 'recuperacion_limitada_por_rate',
  RECUPERACION_TOKEN_INVALIDO: 'recuperacion_token_invalido',
  RECUPERACION_COMPLETADA: 'recuperacion_completada',
  CONTRASENA_CAMBIADA: 'contrasena_cambiada',
  USUARIO_CREADO: 'usuario_creado',
  USUARIO_ACTUALIZADO: 'usuario_actualizado',
  USUARIO_ESTADO_CAMBIADO: 'usuario_estado_cambiado',
  USUARIO_ELIMINADO: 'usuario_eliminado',
};

/** Registra un evento de autenticación. Nunca interrumpe el flujo principal. */
export async function auditar({ usuarioId = null, correo = null, evento, exito = null, req = null, datos = null }) {
  try {
    await pool.query(
      `INSERT INTO sst.eventos_autenticacion (usuario_id, correo, evento, exito, ip, user_agent, datos)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [usuarioId, correo, evento, exito, ipDe(req), req?.headers?.['user-agent'] || null,
       datos ? JSON.stringify(datos) : null]
    );
  } catch (err) {
    console.error('⚠ auditoría de auth falló:', err.message);
  }
}

export const ipDe = (req) => req?.ip || req?.socket?.remoteAddress || null;

/** Vistas del sidebar gestionables desde Configuración → Roles y permisos. */
export const VISTAS_SISTEMA = ['dashboard', 'importar', 'ordenes', 'informes', 'precuentas', 'empresas', 'profesionales', 'configuracion'];

/** Vistas permitidas para un rol (para armar la sesión del usuario autenticado). */
export async function permisosDeRol(rol) {
  const r = await pool.query(
    `SELECT vista FROM sst.permisos_rol WHERE rol = $1 AND permitido = TRUE`,
    [rol]
  );
  return r.rows.map((row) => row.vista);
}

/**
 * Genera un token de recuperación para el usuario: invalida los anteriores
 * pendientes, persiste solo el SHA-256 y envía el correo con el enlace.
 * Devuelve el token en claro únicamente para pruebas bajo driver 'console'.
 */
export async function emitirTokenRecuperacion(usuario, req) {
  const token = randomToken(32);
  const ttl = env.auth.resetTokenTtlMinutes;

  await pool.query(
    `UPDATE sst.tokens_autenticacion SET usado_en = now()
      WHERE usuario_id = $1 AND proposito = 'recuperacion_contrasena' AND usado_en IS NULL`,
    [usuario.id]
  );
  await pool.query(
    `INSERT INTO sst.tokens_autenticacion (usuario_id, proposito, token_hash, expira_en, ip, user_agent)
     VALUES ($1, 'recuperacion_contrasena', $2, now() + make_interval(mins => $3), $4, $5)`,
    [usuario.id, hashToken(token), ttl, ipDe(req), req?.headers?.['user-agent'] || null]
  );

  const base = env.publicAppUrl.replace(/\/+$/, '');
  const link = `${base}/reset-password?token=${token}`;
  await sendEmail({
    to: usuario.correo,
    subject: 'Recuperación de contraseña · JD&D Consultores',
    text:
      `Hola ${usuario.nombre},\n\n` +
      `Recibimos una solicitud para restablecer tu contraseña. Ingresa a:\n${link}\n\n` +
      `El enlace vence en ${ttl} minutos y solo puede usarse una vez.\n` +
      `Si no solicitaste este cambio, ignora este correo: tu contraseña actual sigue vigente.`,
  });
  return token;
}

/**
 * Canjea un token de recuperación: valida vigencia y un-solo-uso de forma
 * atómica, actualiza la contraseña y deja todo auditado.
 * Devuelve el usuario o null si el token no es válido.
 */
export async function canjearTokenRecuperacion(token, nuevaPassword, req) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // FOR UPDATE evita el doble canje concurrente del mismo token.
    const r = await client.query(
      `SELECT t.id AS token_id, u.id, u.correo, u.nombre
         FROM sst.tokens_autenticacion t
         JOIN sst.usuarios u ON u.id = t.usuario_id
        WHERE t.token_hash = $1
          AND t.proposito = 'recuperacion_contrasena'
          AND t.usado_en IS NULL
          AND t.expira_en > now()
          AND u.activo
        FOR UPDATE OF t`,
      [hashToken(token)]
    );
    const fila = r.rows[0];
    if (!fila) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query(`UPDATE sst.tokens_autenticacion SET usado_en = now() WHERE id = $1`, [fila.token_id]);
    // Invalida cualquier otro token pendiente del usuario.
    await client.query(
      `UPDATE sst.tokens_autenticacion SET usado_en = now()
        WHERE usuario_id = $1 AND proposito = 'recuperacion_contrasena' AND usado_en IS NULL`,
      [fila.id]
    );
    await client.query(
      `UPDATE sst.usuarios
          SET contrasena_hash = $2, contrasena_actualizada_en = now(),
              intentos_fallidos = 0, bloqueado_hasta = NULL, actualizado_en = now()
        WHERE id = $1`,
      [fila.id, await hashPassword(nuevaPassword)]
    );
    await client.query('COMMIT');

    // Confirmación al usuario (fuera de la transacción; el correo no debe frenar el flujo).
    sendEmail({
      to: fila.correo,
      subject: 'Tu contraseña fue actualizada · JD&D Consultores',
      text:
        `Hola ${fila.nombre},\n\nTu contraseña se actualizó correctamente.\n` +
        `Si no realizaste este cambio, contacta de inmediato al equipo de soporte.`,
    }).catch((err) => console.error('⚠ correo de confirmación falló:', err.message));

    return fila;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Valida la política mínima de contraseñas (configurable por env). */
export function validarPolicyPassword(password) {
  const min = env.auth.passwordMinLength;
  if (typeof password !== 'string' || password.length < min) {
    return `La contraseña debe tener al menos ${min} caracteres`;
  }
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return 'La contraseña debe combinar letras y números';
  }
  return null;
}
