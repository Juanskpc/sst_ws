import { Router } from 'express';
import { pool } from '../../config/db.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { hashPassword, verifyPassword, signToken, randomToken } from '../../utils/security.js';
import { badRequest, unauthorized, notFound } from '../../utils/httpError.js';
import { authRequired, requireRole } from '../../middleware/auth.js';
import { sendEmail } from '../../services/email.service.js';
import { env } from '../../config/env.js';

const router = Router();

const usuarioPublico = (u) => ({
  id: u.id, documento_identidad: u.documento_identidad, nombre: u.nombre, correo: u.correo,
  rol: u.rol, telefono: u.telefono, especialidad: u.especialidad, activo: u.activo,
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
  if (!usuario || !usuario.activo) throw unauthorized('Credenciales inválidas');
  const ok = await verifyPassword(password, usuario.contrasena_hash);
  if (!ok) throw unauthorized('Credenciales inválidas');
  res.json({ token: signToken(usuario), usuario: usuarioPublico(usuario) });
}));

// AUTH-05 · Perfil del usuario autenticado
router.get('/me', authRequired, asyncHandler(async (req, res) => {
  const r = await pool.query(`SELECT * FROM sst.usuarios WHERE id=$1`, [req.user.sub]);
  if (!r.rows[0]) throw notFound('Usuario no encontrado');
  res.json({ usuario: usuarioPublico(r.rows[0]) });
}));

// AUTH-03 · Solicitud de recuperación de contraseña por correo
router.post('/forgot-password', asyncHandler(async (req, res) => {
  const correo = req.body?.correo || req.body?.email;
  if (!correo) throw badRequest('correo es obligatorio');
  const r = await pool.query(`SELECT id, nombre FROM sst.usuarios WHERE correo=$1`, [correo.toLowerCase()]);
  const usuario = r.rows[0];
  // Respuesta uniforme para no filtrar existencia de cuentas.
  if (usuario) {
    const token = randomToken(24);
    await pool.query(
      `UPDATE sst.usuarios SET token_recuperacion=$2, token_recuperacion_expira=now()+interval '1 hour' WHERE id=$1`,
      [usuario.id, token]
    );
    const link = `${env.publicAppUrl}/reset-password?token=${token}`;
    await sendEmail({
      to: correo,
      subject: 'Recuperación de contraseña · JD&D Consultores',
      text: `Hola ${usuario.nombre}, para restablecer tu contraseña ingresa a:\n${link}\n\nVence en 1 hora.`,
    });
  }
  res.json({ message: 'Si el correo existe, se enviaron instrucciones de recuperación.' });
}));

// AUTH-03 · Confirmación de nueva contraseña con token
router.post('/reset-password', asyncHandler(async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) throw badRequest('token y password son obligatorios');
  if (password.length < 6) throw badRequest('La contraseña debe tener al menos 6 caracteres');
  const r = await pool.query(
    `SELECT id FROM sst.usuarios WHERE token_recuperacion=$1 AND token_recuperacion_expira > now()`,
    [token]
  );
  if (!r.rows[0]) throw badRequest('Token inválido o expirado');
  await pool.query(
    `UPDATE sst.usuarios SET contrasena_hash=$2, token_recuperacion=NULL, token_recuperacion_expira=NULL WHERE id=$1`,
    [r.rows[0].id, await hashPassword(password)]
  );
  res.json({ message: 'Contraseña actualizada.' });
}));

// AUTH-04 · Alta de usuarios (solo admin) — roles diferenciados
router.post('/usuarios', authRequired, requireRole('admin'), asyncHandler(async (req, res) => {
  const { nombre, password, rol = 'profesional', telefono, especialidad } = req.body || {};
  const correo = req.body?.correo || req.body?.email;
  const documento = req.body?.documento || req.body?.documento_identidad;
  if (!nombre || !correo || !password || !documento) {
    throw badRequest('nombre, documento, correo y password son obligatorios');
  }
  if (!['admin', 'profesional', 'contador', 'auditor'].includes(rol)) throw badRequest('Rol inválido');
  const r = await pool.query(
    `INSERT INTO sst.usuarios (nombre, correo, documento_identidad, contrasena_hash, rol, telefono, especialidad)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [nombre, correo.toLowerCase(), String(documento).trim(), await hashPassword(password), rol, telefono, especialidad]
  );
  res.status(201).json({ usuario: usuarioPublico(r.rows[0]) });
}));

export default router;
