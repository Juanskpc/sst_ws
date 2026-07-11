/**
 * Error de extracción de texto (nivel infraestructura). Es intencionadamente
 * independiente del dominio: la traducción a `ExtraccionFallidaError` (dominio)
 * la hace el caso de uso, no el extractor.
 */
export class ExtraccionTextoError extends Error {
  readonly codigo = 'EXTRACCION_TEXTO';

  constructor(
    readonly formato: 'excel' | 'pdf',
    mensaje: string,
    readonly causa?: unknown,
  ) {
    super(mensaje);
    this.name = 'ExtraccionTextoError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
