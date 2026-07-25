import { Router } from 'express';
import { pool } from '../../config/db.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { hashPassword, verifyPassword, signToken } from '../../utils/security.js';
import { badRequest, unauthorized, notFound, forbidden, conflict } from '../../utils/httpError.js';
import { authRequired, requireMaestro } from '../../middleware/auth.js';
import { createRateLimiter } from '../../utils/rateLimit.js';
import { env } from '../../config/env.js';
import {
  EVENTOS, auditar, ipDe, emitirTokenRecuperacion, canjearTokenRecuperacion,
  validarPolicyPassword, permisosDeRol, VISTAS_SISTEMA,
} from './auth.service.js';

const router = Router();

const usuarioPublico = (u) => ({
  id: u.id, documento_identidad: u.documento_identidad, nombre: u.nombre, correo: u.correo,
  rol: u.rol, telefono: u.telefono, especialidad: u.especialidad, activo: u.activo,
  es_maestro: u.es_maestro === true,
});

/** Vistas del sidebar habilitadas para la sesión. Maestro = acceso total (bypass). */
const permisosDeSesion = (usuario) =>
  usuario.es_maestro === true ? VISTAS_SISTEMA : permisosDeRol(usuario.rol);

// Rate limiting de recuperación (por IP y por correo, ventana configurable).
const forgotLimiter = createRateLimiter({
  windowMs: env.auth.resetRateWindowMinutes * 60 * 1000,
  max: env.auth.resetRateMax,
});

// AUTH-01 · Login con JWT — por DOCUMENTO DE IDENTIDAD + contraseña
router.post('/login', asyncHandler(async (req, res) => {
  const { password } = req.body || {};
  const documento = req.body?.documento || req.body?.documento_identidad;
  if (!documento || !password) throw badRequest('documento y password son obligatorios');
  const r = await pool.query(
    `SELECT * FROM sst.usuarios WHERE documento_identidad = $1`,
    [String(documento).trim()]
  );
  const usuario = r.rows[0];
  const ok = usuario && usuario.activo && (await verifyPassword(password, usuario.contrasena_hash));
  if (!ok) {
    if (usuario) {
      // Costura de bloqueo temporal: se contabiliza el intento; la restricción
      // de acceso por `bloqueado_hasta` se activará en una iteración futura.
      await pool.query(
        `UPDATE sst.usuarios SET intentos_fallidos = intentos_fallidos + 1 WHERE id = $1`,
        [usuario.id]
      );
    }
    await auditar({
      usuarioId: usuario?.id || null, correo: usuario?.correo || null,
      evento: EVENTOS.LOGIN_FALLIDO, exito: false, req,
      datos: { documento: String(documento).trim() },
    });
    throw unauthorized('Credenciales inválidas');
  }
  await pool.query(`UPDATE sst.usuarios SET intentos_fallidos = 0 WHERE id = $1`, [usuario.id]);
  await auditar({ usuarioId: usuario.id, correo: usuario.correo, evento: EVENTOS.LOGIN_EXITOSO, exito: true, req });
  // Si la contraseña sigue siendo la cédula (contraseña inicial asignada al
  // crear el usuario), se recomienda cambiarla. Se detecta comparando el claro
  // contra el documento, sin depender de ninguna columna que pueda quedar obsoleta.
  const requiereCambio = password === usuario.documento_identidad;
  res.json({
    token: signToken(usuario), usuario: usuarioPublico(usuario),
    permisos: await permisosDeSesion(usuario),
    requiere_cambio_contrasena: requiereCambio,
  });
}));

// AUTH-05 · Perfil del usuario autenticado (+ permisos vigentes de su rol)
router.get('/me', authRequired, asyncHandler(async (req, res) => {
  const r = await pool.query(`SELECT * FROM sst.usuarios WHERE id=$1`, [req.user.sub]);
  if (!r.rows[0]) throw notFound('Usuario no encontrado');
  res.json({ usuario: usuarioPublico(r.rows[0]), permisos: await permisosDeSesion(r.rows[0]) });
}));

// AUTH-03 · Solicitud de recuperación de contraseña por correo.
// Respuesta SIEMPRE uniforme (200) para no revelar si el correo existe:
// tanto el rate limit como el correo desconocido devuelven el mismo mensaje.
const MENSAJE_RECUPERACION = 'Si el correo existe, se enviaron instrucciones de recuperación.';
router.post('/forgot-password', asyncHandler(async (req, res) => {
  const correoRaw = req.body?.correo || req.body?.email;
  if (!correoRaw || typeof correoRaw !== 'string') throw badRequest('correo es obligatorio');
  const correo = correoRaw.trim().toLowerCase();

  const limitado = forgotLimiter.isLimited(`ip:${ipDe(req)}`) || forgotLimiter.isLimited(`correo:${correo}`);
  if (limitado) {
    await auditar({ correo, evento: EVENTOS.RECUPERACION_LIMITADA, exito: false, req });
    return res.json({ message: MENSAJE_RECUPERACION });
  }

  const r = await pool.query(
    `SELECT id, nombre, correo FROM sst.usuarios WHERE correo = $1 AND activo`,
    [correo]
  );
  const usuario = r.rows[0];
  if (usuario) {
    await emitirTokenRecuperacion(usuario, req);
    await auditar({ usuarioId: usuario.id, correo, evento: EVENTOS.RECUPERACION_SOLICITADA, exito: true, req });
  } else {
    // Se audita el intento sobre correo inexistente (posible enumeración),
    // pero la respuesta externa no cambia.
    await auditar({ correo, evento: EVENTOS.RECUPERACION_CORREO_DESCONOCIDO, exito: false, req });
  }
  res.json({ message: MENSAJE_RECUPERACION });
}));

// AUTH-03 · Confirmación de nueva contraseña con token de un solo uso
router.post('/reset-password', asyncHandler(async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) throw badRequest('token y password son obligatorios');
  const errorPolicy = validarPolicyPassword(password);
  if (errorPolicy) throw badRequest(errorPolicy);

  const usuario = await canjearTokenRecuperacion(String(token), password, req);
  if (!usuario) {
    await auditar({ evento: EVENTOS.RECUPERACION_TOKEN_INVALIDO, exito: false, req });
    throw badRequest('Token inválido o expirado');
  }
  await auditar({ usuarioId: usuario.id, correo: usuario.correo, evento: EVENTOS.RECUPERACION_COMPLETADA, exito: true, req });
  res.json({ message: 'Contraseña actualizada.' });
}));

// ============================================================================
// Gestión de usuarios internos — EXCLUSIVA del Administrador Maestro (dev team)
// ============================================================================

// AUTH-04 · Alta de usuarios — roles diferenciados
router.post('/usuarios', authRequired, requireMaestro, asyncHandler(async (req, res) => {
  const { nombre, rol = 'profesional', telefono, especialidad } = req.body || {};
  const correo = req.body?.correo || req.body?.email;
  const documento = req.body?.documento || req.body?.documento_identidad;
  if (!nombre || !correo || !documento) {
    throw badRequest('nombre, documento y correo son obligatorios');
  }
  if (!['admin', 'profesional', 'contador', 'auditor'].includes(rol)) throw badRequest('Rol inválido');
  // Contraseña inicial = la propia cédula (documento). El usuario deberá cambiarla
  // en su primer ingreso: el login detecta que password === documento y lo avisa.
  const documentoTrim = String(documento).trim();
  const r = await pool.query(
    `INSERT INTO sst.usuarios (nombre, correo, documento_identidad, contrasena_hash, rol, telefono, especialidad)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [nombre, correo.toLowerCase(), documentoTrim, await hashPassword(documentoTrim), rol, telefono, especialidad]
  );
  const creado = r.rows[0];
  await auditar({
    usuarioId: req.user.sub, correo: req.user.correo, evento: EVENTOS.USUARIO_CREADO, exito: true, req,
    datos: { usuario_creado_id: creado.id, rol: creado.rol },
  });
  res.status(201).json({ usuario: usuarioPublico(creado) });
}));

// Listado de usuarios internos
router.get('/usuarios', authRequired, requireMaestro, asyncHandler(async (_req, res) => {
  const r = await pool.query(
    `SELECT * FROM sst.usuarios ORDER BY es_maestro DESC, creado_en ASC`
  );
  res.json({ usuarios: r.rows.map(usuarioPublico) });
}));

// Actualización de datos básicos (nombre, correo, teléfono, especialidad, rol)
router.put('/usuarios/:id', authRequired, requireMaestro, asyncHandler(async (req, res) => {
  const actual = (await pool.query(`SELECT * FROM sst.usuarios WHERE id=$1`, [req.params.id])).rows[0];
  if (!actual) throw notFound('Usuario no encontrado');
  if (actual.es_maestro && actual.id !== req.user.sub) {
    throw forbidden('La cuenta del Administrador Maestro solo puede editarla el propio maestro');
  }
  const { nombre, telefono, especialidad, rol } = req.body || {};
  const correo = req.body?.correo || req.body?.email;
  if (rol && !['admin', 'profesional', 'contador', 'auditor'].includes(rol)) throw badRequest('Rol inválido');
  if (actual.es_maestro && rol && rol !== 'admin') throw badRequest('El Administrador Maestro debe conservar rol admin');
  const r = await pool.query(
    `UPDATE sst.usuarios
        SET nombre = COALESCE($2, nombre),
            correo = COALESCE($3, correo),
            telefono = COALESCE($4, telefono),
            especialidad = COALESCE($5, especialidad),
            rol = COALESCE($6, rol),
            actualizado_en = now()
      WHERE id = $1 RETURNING *`,
    [actual.id, nombre, correo?.toLowerCase(), telefono, especialidad, rol]
  );
  await auditar({
    usuarioId: req.user.sub, correo: req.user.correo, evento: EVENTOS.USUARIO_ACTUALIZADO, exito: true, req,
    datos: { usuario_editado_id: actual.id },
  });
  res.json({ usuario: usuarioPublico(r.rows[0]) });
}));

// Activar / desactivar usuarios
router.patch('/usuarios/:id/estado', authRequired, requireMaestro, asyncHandler(async (req, res) => {
  const { activo } = req.body || {};
  if (typeof activo !== 'boolean') throw badRequest('activo (boolean) es obligatorio');
  const actual = (await pool.query(`SELECT * FROM sst.usuarios WHERE id=$1`, [req.params.id])).rows[0];
  if (!actual) throw notFound('Usuario no encontrado');
  if (actual.es_maestro && !activo) throw conflict('No es posible desactivar al Administrador Maestro');
  const r = await pool.query(
    `UPDATE sst.usuarios SET activo=$2, actualizado_en=now() WHERE id=$1 RETURNING *`,
    [actual.id, activo]
  );
  await auditar({
    usuarioId: req.user.sub, correo: req.user.correo, evento: EVENTOS.USUARIO_ESTADO_CAMBIADO, exito: true, req,
    datos: { usuario_afectado_id: actual.id, activo },
  });
  res.json({ usuario: usuarioPublico(r.rows[0]) });
}));

export default router;
