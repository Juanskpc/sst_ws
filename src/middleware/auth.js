import { verifyToken } from '../utils/security.js';
import { unauthorized, forbidden } from '../utils/httpError.js';

/** Exige un JWT válido; adjunta req.user = { sub, correo, rol, nombre }. */
export function authRequired(req, _res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  // El texto lo lee el usuario final, no quien depura: "Falta el token Bearer"
  // no le dice a nadie que tiene que volver a entrar.
  if (scheme !== 'Bearer' || !token) {
    return next(unauthorized('Su sesión no está activa. Vuelva a iniciar sesión para continuar.'));
  }
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    next(unauthorized('Su sesión expiró. Vuelva a iniciar sesión para continuar.'));
  }
}

/** Restringe a ciertos roles. Uso: requireRole('admin') */
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.rol)) {
      return next(forbidden(
        'Su usuario no tiene permiso para esta acción. Pídale a un administrador que le habilite el acceso.',
      ));
    }
    next();
  };
}

/**
 * Exclusivo del Administrador Maestro (equipo de desarrollo): gestión de
 * usuarios internos y tareas de mantenimiento. El flag viaja en el JWT.
 */
export function requireMaestro(req, _res, next) {
  if (!req.user) return next(unauthorized());
  if (req.user.es_maestro !== true) {
    return next(forbidden(
      'Esta operación es exclusiva del Administrador Maestro (el equipo de desarrollo).',
    ));
  }
  next();
}
