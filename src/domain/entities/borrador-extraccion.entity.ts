import { type Resultado, exito, fallo } from '../shared/result.js';
import { EstadoExtraccion } from '../enums/estado-extraccion.enum.js';
import { BorradorNoValidableError } from '../errors/ordenes.errors.js';
import { PuntajeConfianza } from '../value-objects/puntaje-confianza.vo.js';
import type { MetadatosExtraccion, CampoCanonico } from '../dto/metadatos-extraccion.dto.js';
import type {
  ArlId,
  BorradorExtraccionId,
  LoteImportacionId,
  OrdenServicioId,
} from '../shared/identifiers.js';

export interface PropsBorradorExtraccion {
  readonly id: BorradorExtraccionId;
  readonly loteImportacionId: LoteImportacionId;
  readonly arlId: ArlId | null;
  readonly nombreArchivo: string | null;
  readonly urlArchivoOriginal: string | null;
  readonly confianzaGeneral: PuntajeConfianza | null;
  readonly metadatos: MetadatosExtraccion;
  readonly estado: EstadoExtraccion;
  readonly duplicadoDe: OrdenServicioId | null;
  readonly ordenServicioId: OrdenServicioId | null;
  readonly mensajeError: string | null;
  readonly creadoEn: Date;
  readonly actualizadoEn: Date;
}

export interface NuevoBorradorExtraccion {
  readonly id: BorradorExtraccionId;
  readonly loteImportacionId: LoteImportacionId;
  readonly arlId: ArlId | null;
  readonly nombreArchivo: string | null;
  readonly urlArchivoOriginal: string | null;
  readonly confianzaGeneral: PuntajeConfianza | null;
  readonly metadatos: MetadatosExtraccion;
}

/**
 * Borrador de extracción (staging M2/M3) — refleja `sst.borradores_extraccion`.
 *
 * Guarda la extracción cruda (`metadatos`) hasta que el humano valide en el
 * split-view. Al "Validar y Guardar" se materializa en una OS (SIN PROGRAMAR) y
 * el borrador queda en `VALIDADA`. Solo transiciona desde `PENDIENTE_VALIDACION`
 * (evita doble materialización ante reintentos del cliente).
 */
export class BorradorExtraccion {
  private constructor(private props: PropsBorradorExtraccion) {}

  /** Crea un borrador listo para revisión humana (extracción ya realizada). */
  static crear(
    input: NuevoBorradorExtraccion,
    ahora: Date = new Date(),
  ): BorradorExtraccion {
    return new BorradorExtraccion({
      ...input,
      estado: EstadoExtraccion.PENDIENTE_VALIDACION,
      duplicadoDe: null,
      ordenServicioId: null,
      mensajeError: null,
      creadoEn: ahora,
      actualizadoEn: ahora,
    });
  }

  static reconstituir(props: PropsBorradorExtraccion): BorradorExtraccion {
    return new BorradorExtraccion(props);
  }

  /** Marca el borrador como materializado en una OS (Fase B). */
  marcarValidada(
    ordenServicioId: OrdenServicioId,
    ahora: Date = new Date(),
  ): Resultado<void, BorradorNoValidableError> {
    return this.transicionar(
      EstadoExtraccion.VALIDADA,
      { ordenServicioId },
      ahora,
    );
  }

  /** Marca el borrador como duplicado de una OS existente (IMP-07/09). */
  marcarDuplicada(
    ordenExistenteId: OrdenServicioId,
    ahora: Date = new Date(),
  ): Resultado<void, BorradorNoValidableError> {
    return this.transicionar(
      EstadoExtraccion.DUPLICADA,
      { duplicadoDe: ordenExistenteId },
      ahora,
    );
  }

  /** Descarta el borrador sin materializarlo. */
  marcarDescartada(ahora: Date = new Date()): Resultado<void, BorradorNoValidableError> {
    return this.transicionar(EstadoExtraccion.DESCARTADA, {}, ahora);
  }

  /** Marca un fallo de extracción/procesamiento sobre el borrador. */
  marcarError(mensaje: string, ahora: Date = new Date()): void {
    this.props = {
      ...this.props,
      estado: EstadoExtraccion.ERROR,
      mensajeError: mensaje,
      actualizadoEn: ahora,
    };
  }

  private transicionar(
    destino: EstadoExtraccion,
    extra: Partial<Pick<PropsBorradorExtraccion, 'ordenServicioId' | 'duplicadoDe'>>,
    ahora: Date,
  ): Resultado<void, BorradorNoValidableError> {
    if (this.props.estado !== EstadoExtraccion.PENDIENTE_VALIDACION) {
      return fallo(new BorradorNoValidableError(this.props.estado));
    }
    this.props = {
      ...this.props,
      ...extra,
      estado: destino,
      actualizadoEn: ahora,
    };
    return exito(undefined);
  }

  /** ¿Algún campo canónico cae por debajo del umbral de revisión? (M3) */
  requiereRevision(umbral: number): boolean {
    return this.camposQueRequierenRevision(umbral).length > 0;
  }

  /** Campos canónicos cuya confianza está por debajo del umbral. */
  camposQueRequierenRevision(umbral: number): CampoCanonico[] {
    const m = this.props.metadatos;
    const bajos: CampoCanonico[] = [];

    if (m.codigo_cronograma.confidence < umbral) bajos.push('codigo_cronograma');
    if (m.secuencia.confidence < umbral) bajos.push('secuencia');
    if (m.nit_nic.confidence < umbral) bajos.push('nit_nic');
    if (m.empresa_nombre.confidence < umbral) bajos.push('empresa_nombre');
    if (m.actividad_economica.confidence < umbral) bajos.push('actividad_economica');
    if (m.horas_asignadas.confidence < umbral) bajos.push('horas_asignadas');

    const c = m.contacto_sst;
    if (
      c.nombre.confidence < umbral ||
      c.telefono.confidence < umbral ||
      c.correo.confidence < umbral
    ) {
      bajos.push('contacto_sst');
    }

    if (m.descripcion.confidence < umbral) bajos.push('descripcion');
    return bajos;
  }

  get id(): BorradorExtraccionId {
    return this.props.id;
  }
  get loteImportacionId(): LoteImportacionId {
    return this.props.loteImportacionId;
  }
  get estado(): EstadoExtraccion {
    return this.props.estado;
  }
  get arlId(): ArlId | null {
    return this.props.arlId;
  }
  get metadatos(): MetadatosExtraccion {
    return this.props.metadatos;
  }
  get confianzaGeneral(): PuntajeConfianza | null {
    return this.props.confianzaGeneral;
  }
  get ordenServicioId(): OrdenServicioId | null {
    return this.props.ordenServicioId;
  }

  aPrimitivos(): PropsBorradorExtraccion {
    return { ...this.props };
  }
}
