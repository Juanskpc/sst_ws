import { Router } from 'express';
import { pool } from '../../config/db.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { hashPassword, verifyPassword, signToken } from '../../utils/security.js';
import { badRequest, unauthorized, notFound, forbidden, conflict } from '../../utils/httpError.js';
import {
  validarNombre, validarCorreo, validarTelefono, validarTextoOpcional, validarDocumento,
} from '../../utils/personas.js';
import { authRequired, requireMaestro } from '../../middleware/auth.js';
import { createRateLimiter } from '../../utils/rateLimit.js';
import { env } from '../../config/env.js';
import {
  EVENTOS, auditar, ipDe, emitirTokenRecuperacion, canjearTokenRecuperacion,
  validarPolicyPassword, permisosDeRol, VISTAS_SISTEMA,
} from './auth.service.js';

const router = Router();

/**
 * AUTH-04 · Roles del sistema.
 *
 * 'administrativo' se llamaba 'profesional' y se renombró (19-ago-2026) porque
 * se confundía con los PROFESIONALES que hacen las visitas, que no tienen
 * cuenta: son fichas de `sst.profesionales` y trabajan por enlaces públicos.
 */
const ROLES_VALIDOS = ['admin', 'administrativo', 'contador', 'auditor'];

const usuarioPublico = (u) => ({
  id: u.id, documento_identidad: u.documento_identidad, nombre: u.nombre, correo: u.correo,
  rol: u.rol, telefono: u.telefono, especialidad: u.especialidad, activo: u.activo,
  es_maestro: u.es_maestro === true,
  // ASG-08 · Ficha de profesional de campo enlazada, si la hay. Es lo que decide
  // si el panel de inicio muestra una agenda propia: la tiene quien SALE a las
  // visitas, no un rol concreto. Sin esto, el panel se bifurcaba por rol y una
  // cuenta administrativa veía "no tiene ficha enlazada" sin necesitar ninguna.
  profesional_id: u.profesional_id ?? null,
});

/**
 * Documento normalizado para comparar: sin puntos, espacios ni guiones y en
 * mayúsculas, de modo que "1.020.304.050" y "1020304050" sean el mismo documento.
 */
const claveDocumento = (v) => String(v ?? '').replace(/[^0-9a-zA-Z]/g, '').toUpperCase();

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
    // La ficha de profesional enlazada viaja desde el login: el panel de inicio
    // decide con ella si enseña una agenda propia.
    `SELECT u.*, (SELECT p.id FROM sst.profesionales p WHERE p.usuario_id = u.id LIMIT 1) AS profesional_id
       FROM sst.usuarios u WHERE u.documento_identidad = $1`,
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
  const r = await pool.query(
    `SELECT u.*, (SELECT p.id FROM sst.profesionales p WHERE p.usuario_id = u.id LIMIT 1) AS profesional_id
       FROM sst.usuarios u WHERE u.id=$1`,
    [req.user.sub]
  );
  if (!r.rows[0]) throw notFound('Usuario no encontrado');
  res.json({ usuario: usuarioPublico(r.rows[0]), permisos: await permisosDeSesion(r.rows[0]) });
}));

/**
 * AUTH-05 · El usuario corrige SUS datos: nombre, correo, teléfono y especialidad.
 *
 * El documento NO se toca aquí —es con lo que se inicia sesión— ni el rol:
 * nadie se asciende solo. El correo sí, porque es el dato que más cambia en la
 * práctica y obligar a pedírselo al Administrador Maestro dejaba al propio
 * maestro sin forma de corregir el suyo. Es opcional en el cuerpo: si no llega,
 * la cuenta conserva el que tiene.
 *
 * Al final se reemite el token. Sus claims `correo` y `nombre` no son
 * decorativos: de ahí salen el remitente y la copia de los correos de asignación
 * (M11). Sin reemitirlo, cambiar el correo mandaría las notificaciones a la
 * dirección vieja hasta que el token caducara.
 */
router.put('/me', authRequired, asyncHandler(async (req, res) => {
  const nombre = validarNombre(req.body?.nombre);
  const telefono = validarTelefono(req.body?.telefono);
  const especialidad = validarTextoOpcional(req.body?.especialidad, 'La especialidad');
  const correo = req.body?.correo === undefined ? null : validarCorreo(req.body.correo);

  let r;
  try {
    r = await pool.query(
      `UPDATE sst.usuarios
          SET nombre=$2, telefono=$3, especialidad=$4, correo=COALESCE($5, correo),
              actualizado_en=now()
        WHERE id=$1
        RETURNING *, (SELECT p.id FROM sst.profesionales p WHERE p.usuario_id = sst.usuarios.id LIMIT 1) AS profesional_id`,
      [req.user.sub, nombre, telefono, especialidad, correo]
    );
  } catch (e) {
    if (e.code === '23505') throw conflict(`El correo ${correo} ya pertenece a otra cuenta.`);
    throw e;
  }
  if (!r.rows[0]) throw notFound('Usuario no encontrado');
  res.json({
    message: 'Perfil actualizado.',
    usuario: usuarioPublico(r.rows[0]),
    token: signToken(r.rows[0]),
  });
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
  // Nombres de campo del cuerpo de la petición: quien lee esto está en una
  // pantalla que ni siquiera enseña un campo llamado "token".
  if (!token || !password) {
    throw badRequest('Falta la contraseña nueva, o el enlace llegó incompleto. Ábralo otra vez desde el correo.');
  }
  const errorPolicy = validarPolicyPassword(password);
  if (errorPolicy) throw badRequest(errorPolicy);

  const usuario = await canjearTokenRecuperacion(String(token), password, req);
  if (!usuario) {
    await auditar({ evento: EVENTOS.RECUPERACION_TOKEN_INVALIDO, exito: false, req });
    throw badRequest(
      'Este enlace ya se usó o venció (dura una hora). Pida uno nuevo desde "¿Olvidó su contraseña?".',
    );
  }
  await auditar({ usuarioId: usuario.id, correo: usuario.correo, evento: EVENTOS.RECUPERACION_COMPLETADA, exito: true, req });
  res.json({ message: 'Contraseña actualizada.' });
}));

// ============================================================================
// Gestión de usuarios internos — EXCLUSIVA del Administrador Maestro (dev team)
// ============================================================================

// AUTH-04 · Alta de usuarios — roles diferenciados
router.post('/usuarios', authRequired, requireMaestro, asyncHandler(async (req, res) => {
  const { rol = 'administrativo' } = req.body || {};
  if (!ROLES_VALIDOS.includes(rol)) throw badRequest('Rol inválido');

  // M1 · Los datos de la persona pasan por el mismo validador que las fichas de
  // profesional: nombre solo con letras y en mayúsculas, correo con formato,
  // teléfono solo dígitos. Antes entraba cualquier cosa.
  const nombre = validarNombre(req.body?.nombre);
  const correo = validarCorreo(req.body?.correo || req.body?.email);
  const telefono = validarTelefono(req.body?.telefono);
  const especialidad = validarTextoOpcional(req.body?.especialidad, 'La especialidad');
  // Contraseña inicial = la propia cédula (documento). El usuario deberá cambiarla
  // en su primer ingreso: el login detecta que password === documento y lo avisa.
  const documentoTrim = validarDocumento(req.body?.documento || req.body?.documento_identidad);
  const documentoClave = claveDocumento(documentoTrim);
  // El UNIQUE de la columna ya impide el duplicado exacto; esto además atrapa el
  // mismo documento escrito con puntos o espacios ("1.020.304.050") y devuelve a
  // quién pertenece, que es lo que el Maestro necesita saber para resolverlo.
  const dup = await pool.query(
    `SELECT nombre FROM sst.usuarios
      WHERE upper(regexp_replace(coalesce(documento_identidad,''), '[^0-9A-Za-z]', '', 'g')) = $1
      LIMIT 1`,
    [documentoClave]
  );
  if (dup.rows[0]) {
    throw conflict(`El documento ${documentoTrim} ya está registrado a nombre de ${dup.rows[0].nombre}.`);
  }
  const r = await pool.query(
    `INSERT INTO sst.usuarios (nombre, correo, documento_identidad, contrasena_hash, rol, telefono, especialidad)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [nombre, correo, documentoTrim, await hashPassword(documentoTrim), rol, telefono, especialidad]
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
  const { rol } = req.body || {};
  if (rol && !ROLES_VALIDOS.includes(rol)) throw badRequest('Rol inválido');
  // Solo se valida lo que venga: es un PUT parcial (COALESCE abajo), así que un
  // campo ausente conserva su valor y no debe fallar por "obligatorio".
  const nombre = req.body?.nombre === undefined ? null : validarNombre(req.body.nombre);
  const correoBruto = req.body?.correo ?? req.body?.email;
  const correo = correoBruto === undefined ? null : validarCorreo(correoBruto);
  const telefono = req.body?.telefono === undefined ? null : validarTelefono(req.body.telefono);
  const especialidad = req.body?.especialidad === undefined
    ? null
    : validarTextoOpcional(req.body.especialidad, 'La especialidad');
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
    [actual.id, nombre, correo, telefono, especialidad, rol]
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

// Baja definitiva de un usuario interno.
// Es destructiva por diseño (la UI ofrece "Desactivar" como alternativa reversible).
// Las referencias desde otras tablas están declaradas ON DELETE SET NULL / CASCADE,
// así que el histórico de órdenes y la auditoría sobreviven a la baja.
router.delete('/usuarios/:id', authRequired, requireMaestro, asyncHandler(async (req, res) => {
  const actual = (await pool.query(`SELECT * FROM sst.usuarios WHERE id=$1`, [req.params.id])).rows[0];
  if (!actual) throw notFound('Usuario no encontrado');
  if (actual.es_maestro) throw conflict('No es posible eliminar al Administrador Maestro');
  if (actual.id === req.user.sub) throw conflict('No puede eliminar su propia cuenta');
  await pool.query(`DELETE FROM sst.usuarios WHERE id=$1`, [actual.id]);
  await auditar({
    usuarioId: req.user.sub, correo: req.user.correo, evento: EVENTOS.USUARIO_ELIMINADO, exito: true, req,
    // El id eliminado ya no es una FK válida: se guardan los datos en el detalle.
    datos: { usuario_eliminado_id: actual.id, correo: actual.correo, rol: actual.rol },
  });
  res.json({ message: 'Usuario eliminado.' });
}));

export default router;
