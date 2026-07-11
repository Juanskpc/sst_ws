import { type Resultado, exito, fallo } from '../shared/result.js';
import { ValorInvalidoError } from '../shared/errors/domain-error.js';

/**
 * Correo electrónico validado y normalizado (minúsculas, sin espacios).
 * Usado en el contacto SST de la OS (costura M8 — encuestas de Fase 2).
 */
export class CorreoElectronico {
  // Validación pragmática (no RFC 5322 completo): suficiente para el MVP.
  private static readonly PATRON = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  private constructor(private readonly _valor: string) {}

  static crear(entrada: string): Resultado<CorreoElectronico, ValorInvalidoError> {
    const normalizado = entrada.trim().toLowerCase();
    if (!CorreoElectronico.PATRON.test(normalizado)) {
      return fallo(
        new ValorInvalidoError('correo', `Correo electrónico inválido: "${entrada}".`),
      );
    }
    return exito(new CorreoElectronico(normalizado));
  }

  get valor(): string {
    return this._valor;
  }

  equals(otro: CorreoElectronico): boolean {
    return this._valor === otro._valor;
  }
}
