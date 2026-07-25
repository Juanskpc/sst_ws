import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { env } from '../config/env.js';

export const hashPassword = (plain) => bcrypt.hash(plain, 10);
export const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

export function signToken(usuario) {
  return jwt.sign(
    {
      sub: usuario.id, correo: usuario.correo, rol: usuario.rol, nombre: usuario.nombre,
      es_maestro: usuario.es_maestro === true,
    },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn }
  );
}

export function verifyToken(token) {
  return jwt.verify(token, env.jwtSecret);
}

/** Token opaco url-safe para links públicos (M6) y recuperación de contraseña. */
export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

/** SHA-256 hex de un token opaco: en BD solo se persiste el hash, nunca el claro. */
export const hashToken = (token) => crypto.createHash('sha256').update(token, 'utf8').digest('hex');
