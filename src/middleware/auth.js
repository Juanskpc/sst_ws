import { verifyToken } from '../utils/security.js';
import { unauthorized, forbidden } from '../utils/httpError.js';

/** Exige un JWT válido; adjunta req.user = { sub, correo, rol, nombre }. */
export function authRequired(req, _res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return next(unauthorized('Falta el token Bearer'));
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    next(unauthorized('Token inválido o expirado'));
  }
}

/** Restringe a ciertos roles. Uso: requireRole('admin') */
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.rol)) return next(forbidden('Rol insuficiente'));
    next();
  };
}
