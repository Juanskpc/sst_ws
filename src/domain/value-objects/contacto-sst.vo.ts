import { CorreoElectronico } from './correo-electronico.vo.js';

/** Entrada cruda del contacto SST (valores ya confirmados por el humano). */
export interface ContactoSstInput {
  readonly nombre: string | null;
  readonly telefono: string | null;
  readonly correo: CorreoElectronico | null;
}

/**
 * Contacto SST de la empresa cliente (`contacto_sst_*` en la OS).
 *
 * Es una costura para M8 (encuestas de satisfacción, Fase 2), por eso se captura
 * y valida desde Fase 1. Los campos son opcionales: normaliza `""` a `null`.
 */
export class ContactoSst {
  private constructor(
    private readonly _nombre: string | null,
    private readonly _telefono: string | null,
    private readonly _correo: CorreoElectronico | null,
  ) {}

  static crear(input: ContactoSstInput): ContactoSst {
    return new ContactoSst(
      ContactoSst.normalizar(input.nombre),
      ContactoSst.normalizar(input.telefono),
      input.correo,
    );
  }

  /** Contacto vacío (documento sin datos de contacto detectados). */
  static vacio(): ContactoSst {
    return new ContactoSst(null, null, null);
  }

  private static normalizar(texto: string | null): string | null {
    if (texto === null) return null;
    const limpio = texto.trim();
    return limpio.length > 0 ? limpio : null;
  }

  get nombre(): string | null {
    return this._nombre;
  }

  get telefono(): string | null {
    return this._telefono;
  }

  get correo(): CorreoElectronico | null {
    return this._correo;
  }

  estaVacio(): boolean {
    return this._nombre === null && this._telefono === null && this._correo === null;
  }
}
