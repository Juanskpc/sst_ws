import { EstadoImportacion } from '../enums/estado-importacion.enum.js';
import type {
  ArlId,
  LoteImportacionId,
  UsuarioId,
} from '../shared/identifiers.js';

/** Estado interno completo del lote (usado por `reconstituir` desde el repositorio). */
export interface PropsLoteImportacion {
  readonly id: LoteImportacionId;
  readonly subidoPor: UsuarioId | null;
  readonly nombreArchivo: string;
  readonly arlDetectada: ArlId | null;
  readonly urlArchivo: string | null;
  readonly tipoMime: string | null;
  readonly estado: EstadoImportacion;
  readonly mensajeError: string | null;
  readonly totalOrdenes: number;
  readonly creadoEn: Date;
}

/** Datos mínimos para iniciar un lote en la ingesta (Fase A). */
export interface NuevoLoteImportacion {
  readonly id: LoteImportacionId;
  readonly subidoPor: UsuarioId | null;
  readonly nombreArchivo: string;
  readonly urlArchivo: string | null;
  readonly tipoMime: string | null;
}

/**
 * Lote de importación (M2) — refleja `sst.lotes_importacion`.
 *
 * Nace en `PROCESANDO` (la ingesta responde en < 2s) y el worker asíncrono lo
 * finaliza en `PROCESADO` o `ERROR`. La finalización es una operación única;
 * llamarla dos veces es un bug del worker y se señala con excepción (invariante,
 * no error de negocio esperable).
 */
export class LoteImportacion {
  private constructor(private props: PropsLoteImportacion) {}

  /** Crea un lote nuevo en estado PROCESANDO. */
  static crear(input: NuevoLoteImportacion, ahora: Date = new Date()): LoteImportacion {
    return new LoteImportacion({
      id: input.id,
      subidoPor: input.subidoPor,
      nombreArchivo: input.nombreArchivo,
      arlDetectada: null,
      urlArchivo: input.urlArchivo,
      tipoMime: input.tipoMime,
      estado: EstadoImportacion.PROCESANDO,
      mensajeError: null,
      totalOrdenes: 0,
      creadoEn: ahora,
    });
  }

  /** Reconstruye un lote desde persistencia (sin re-validar invariantes). */
  static reconstituir(props: PropsLoteImportacion): LoteImportacion {
    return new LoteImportacion(props);
  }

  /** Registra la ARL detectada por el clasificador (IMP-05). */
  registrarArlDetectada(arlId: ArlId): void {
    this.props = { ...this.props, arlDetectada: arlId };
  }

  /** Finaliza el lote con éxito indicando cuántas OS produjo. */
  marcarProcesado(totalOrdenes: number): void {
    this.asegurarEnProceso();
    if (totalOrdenes < 0) {
      throw new Error('El total de órdenes no puede ser negativo.');
    }
    this.props = {
      ...this.props,
      estado: EstadoImportacion.PROCESADO,
      totalOrdenes,
      mensajeError: null,
    };
  }

  /** Finaliza el lote con error de procesamiento. */
  marcarError(mensaje: string): void {
    this.asegurarEnProceso();
    this.props = {
      ...this.props,
      estado: EstadoImportacion.ERROR,
      mensajeError: mensaje,
    };
  }

  private asegurarEnProceso(): void {
    if (this.props.estado !== EstadoImportacion.PROCESANDO) {
      throw new Error(
        `El lote ${this.props.id} ya fue finalizado (estado ${this.props.estado}).`,
      );
    }
  }

  get id(): LoteImportacionId {
    return this.props.id;
  }
  get estado(): EstadoImportacion {
    return this.props.estado;
  }
  get nombreArchivo(): string {
    return this.props.nombreArchivo;
  }
  get arlDetectada(): ArlId | null {
    return this.props.arlDetectada;
  }
  get totalOrdenes(): number {
    return this.props.totalOrdenes;
  }
  get mensajeError(): string | null {
    return this.props.mensajeError;
  }

  /** Vista inmutable del estado para mapeo en repositorios. */
  aPrimitivos(): PropsLoteImportacion {
    return { ...this.props };
  }
}
