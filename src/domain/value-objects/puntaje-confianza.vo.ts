import { type Resultado, exito, fallo } from '../shared/result.js';
import { ValorInvalidoError } from '../shared/errors/domain-error.js';
import { NivelConfianza } from '../enums/nivel-confianza.enum.js';

/**
 * Puntaje de confianza (0-100) de un campo extraído por IA.
 *
 * Value Object inmutable con invariante garantizada en construcción. Encapsula
 * la lógica del *badge* (nivel) y la regla de revisión contra un umbral
 * configurable (`app_settings`, por defecto 70).
 */
export class PuntajeConfianza {
  static readonly MINIMO = 0;
  static readonly MAXIMO = 100;

  private constructor(private readonly _valor: number) {}

  static crear(valor: number): Resultado<PuntajeConfianza, ValorInvalidoError> {
    if (!Number.isFinite(valor)) {
      return fallo(
        new ValorInvalidoError('confianza', 'La confianza debe ser un número finito.'),
      );
    }
    const redondeado = Math.round(valor);
    if (redondeado < PuntajeConfianza.MINIMO || redondeado > PuntajeConfianza.MAXIMO) {
      return fallo(
        new ValorInvalidoError(
          'confianza',
          `La confianza debe estar entre ${PuntajeConfianza.MINIMO} y ${PuntajeConfianza.MAXIMO}.`,
        ),
      );
    }
    return exito(new PuntajeConfianza(redondeado));
  }

  get valor(): number {
    return this._valor;
  }

  /** Nivel para el badge del split-view (umbrales de presentación fijos). */
  nivel(): NivelConfianza {
    if (this._valor >= 80) return NivelConfianza.ALTA;
    if (this._valor >= 70) return NivelConfianza.MEDIA;
    return NivelConfianza.BAJA;
  }

  /** ¿El campo cae por debajo del umbral de revisión configurado? */
  requiereRevision(umbral: number): boolean {
    return this._valor < umbral;
  }

  equals(otro: PuntajeConfianza): boolean {
    return this._valor === otro._valor;
  }
}
