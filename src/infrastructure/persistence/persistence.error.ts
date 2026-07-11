/** Error de la capa de persistencia (infraestructura). */
export class PersistenciaError extends Error {
  constructor(mensaje: string, readonly causa?: unknown) {
    super(mensaje);
    this.name = 'PersistenciaError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Datos inconsistentes al reconstruir una entidad desde la BD (corrupción). */
export class MapeoPersistenciaError extends PersistenciaError {
  constructor(campo: string, detalle: string) {
    super(`Datos inconsistentes al mapear "${campo}": ${detalle}`);
    this.name = 'MapeoPersistenciaError';
  }
}
