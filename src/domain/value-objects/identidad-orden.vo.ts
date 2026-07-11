import { type Resultado, exito, fallo } from '../shared/result.js';
import { ValorInvalidoError } from '../shared/errors/domain-error.js';
import type { ArlId } from '../shared/identifiers.js';

/**
 * Identidad natural de una OS: (ARL + código de cronograma + secuencia).
 *
 * Es la clave de deduplicación IMP-07/09, reflejo del
 * `CONSTRAINT uq_ordenes_dedup UNIQUE (arl_id, codigo_cronograma, secuencia)`.
 * Implementa igualdad por valor para comparaciones en memoria antes de tocar BD.
 */
export class IdentidadOrden {
  private constructor(
    private readonly _arlId: ArlId,
    private readonly _codigoCronograma: string,
    private readonly _secuencia: string,
  ) {}

  static crear(
    arlId: ArlId,
    codigoCronograma: string,
    secuencia: string,
  ): Resultado<IdentidadOrden, ValorInvalidoError> {
    const cronograma = codigoCronograma.trim();
    const secuenciaLimpia = secuencia.trim();
    if (cronograma.length === 0) {
      return fallo(
        new ValorInvalidoError('codigo_cronograma', 'El código de cronograma es obligatorio.'),
      );
    }
    if (secuenciaLimpia.length === 0) {
      return fallo(new ValorInvalidoError('secuencia', 'La secuencia es obligatoria.'));
    }
    return exito(new IdentidadOrden(arlId, cronograma, secuenciaLimpia));
  }

  get arlId(): ArlId {
    return this._arlId;
  }

  get codigoCronograma(): string {
    return this._codigoCronograma;
  }

  get secuencia(): string {
    return this._secuencia;
  }

  /** Clave estable para comparación/indexación en memoria. */
  clave(): string {
    return `${this._arlId}::${this._codigoCronograma}::${this._secuencia}`;
  }

  equals(otra: IdentidadOrden): boolean {
    return this.clave() === otra.clave();
  }
}
