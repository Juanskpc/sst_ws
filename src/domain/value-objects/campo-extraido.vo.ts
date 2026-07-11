import { PuntajeConfianza } from './puntaje-confianza.vo.js';

/**
 * Campo extraído por el pipeline IA: un valor tipado + su confianza (IMP-06).
 *
 * Representación de dominio del par `{ value, confidence }` que llega crudo en
 * `metadatos_extraccion` (JSONB). El valor puede ser `null` cuando la IA no lo
 * encontró (p. ej. `descripcion` truncada en PDFs de AXA).
 */
export class CampoExtraido<T> {
  private constructor(
    private readonly _valor: T | null,
    private readonly _confianza: PuntajeConfianza,
  ) {}

  static crear<T>(valor: T | null, confianza: PuntajeConfianza): CampoExtraido<T> {
    return new CampoExtraido<T>(valor, confianza);
  }

  get valor(): T | null {
    return this._valor;
  }

  get confianza(): PuntajeConfianza {
    return this._confianza;
  }

  /** ¿Hay un valor no vacío? (trata `""` como ausencia para strings). */
  tieneValor(): boolean {
    if (this._valor === null) return false;
    if (typeof this._valor === 'string') return this._valor.trim().length > 0;
    return true;
  }

  requiereRevision(umbral: number): boolean {
    return this._confianza.requiereRevision(umbral);
  }
}
