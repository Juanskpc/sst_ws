import { type Resultado, exito, fallo } from '../shared/result.js';
import { ValorInvalidoError } from '../shared/errors/domain-error.js';

/**
 * Horas asignadas a la OS (`horas_asignadas NUMERIC(8,2)`).
 * Invariantes: número finito, no negativo, con 2 decimales y dentro del rango
 * admitido por la columna (NUMERIC(8,2) ⇒ máx 999 999.99).
 */
export class HorasAsignadas {
  static readonly MAXIMO = 999_999.99;

  private constructor(private readonly _valor: number) {}

  static crear(valor: number): Resultado<HorasAsignadas, ValorInvalidoError> {
    if (!Number.isFinite(valor)) {
      return fallo(
        new ValorInvalidoError('horas_asignadas', 'Las horas deben ser un número finito.'),
      );
    }
    if (valor < 0) {
      return fallo(
        new ValorInvalidoError('horas_asignadas', 'Las horas no pueden ser negativas.'),
      );
    }
    const redondeado = Math.round(valor * 100) / 100;
    if (redondeado > HorasAsignadas.MAXIMO) {
      return fallo(
        new ValorInvalidoError(
          'horas_asignadas',
          `Las horas superan el máximo permitido (${HorasAsignadas.MAXIMO}).`,
        ),
      );
    }
    return exito(new HorasAsignadas(redondeado));
  }

  get valor(): number {
    return this._valor;
  }

  equals(otro: HorasAsignadas): boolean {
    return this._valor === otro._valor;
  }
}
