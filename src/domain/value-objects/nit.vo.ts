import { type Resultado, exito, fallo } from '../shared/result.js';
import { ValorInvalidoError } from '../shared/errors/domain-error.js';

/**
 * NIT/NIC de la empresa (identificación tributaria colombiana).
 *
 * Normaliza la entrada (elimina puntos y espacios) y valida un formato básico:
 * 5-15 dígitos con dígito de verificación opcional (`-D`). No calcula el DV
 * (regla externa a este MVP), solo garantiza forma y no-vacío.
 */
export class Nit {
  private constructor(private readonly _valor: string) {}

  static crear(entrada: string): Resultado<Nit, ValorInvalidoError> {
    const limpio = entrada.replace(/[.\s]/g, '').trim();
    if (limpio.length === 0) {
      return fallo(new ValorInvalidoError('nit_nic', 'El NIT/NIC no puede estar vacío.'));
    }
    if (!/^\d{5,15}(-\d)?$/.test(limpio)) {
      return fallo(
        new ValorInvalidoError('nit_nic', 'El NIT/NIC tiene un formato inválido.'),
      );
    }
    return exito(new Nit(limpio));
  }

  get valor(): string {
    return this._valor;
  }

  equals(otro: Nit): boolean {
    return this._valor === otro._valor;
  }
}
