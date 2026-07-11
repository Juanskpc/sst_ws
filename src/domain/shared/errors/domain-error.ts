/**
 * Jerarquía de errores de dominio.
 *
 * Todos los errores esperables del dominio derivan de {@link ErrorDominio} y
 * exponen un `codigo` estable y discriminable. La traducción de `codigo` a un
 * status HTTP es responsabilidad de la capa de presentación, NO del dominio.
 */

/** Códigos estables de error. Contrato con las capas externas. */
export type CodigoErrorDominio =
  | 'VALOR_INVALIDO'
  | 'ARCHIVO_NO_SOPORTADO'
  | 'ARL_NO_RECONOCIDA'
  | 'ORDEN_DUPLICADA'
  | 'EXTRACCION_FALLIDA'
  | 'LOTE_NO_ENCONTRADO'
  | 'BORRADOR_NO_ENCONTRADO'
  | 'BORRADOR_NO_VALIDABLE'
  | 'TRANSICION_INVALIDA'
  | 'MOTIVO_REQUERIDO'
  | 'REGRESION_EJECUTADA';

/** Raíz de todos los errores de negocio. Nunca se instancia directamente. */
export abstract class ErrorDominio extends Error {
  /** Código estable para discriminar el error en capas superiores. */
  abstract readonly codigo: CodigoErrorDominio;

  /** Bandera para reconocer errores de dominio sin depender de `instanceof`. */
  readonly esErrorDominio = true as const;

  /** Contexto estructurado y serializable del error (sin PII sensible). */
  readonly detalles: Readonly<Record<string, unknown>>;

  protected constructor(
    mensaje: string,
    detalles: Readonly<Record<string, unknown>> = {},
  ) {
    super(mensaje);
    this.name = new.target.name;
    this.detalles = detalles;
    // Necesario al extender `Error` transpilando a targets que rompen la cadena de prototipos.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Violación de una invariante al construir un Value Object.
 * Emitido por las factorías `crear()` de los VO.
 */
export class ValorInvalidoError extends ErrorDominio {
  override readonly codigo = 'VALOR_INVALIDO';

  constructor(
    readonly campo: string,
    mensaje: string,
  ) {
    super(mensaje, { campo });
  }
}
