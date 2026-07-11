import { type Resultado, exito } from '../shared/result.js';
import { EstadoOrden } from '../enums/estado-orden.enum.js';
import {
  validarTransicion,
  type EntradaHistorialEstado,
} from '../policies/transicion-estado.policy.js';
import type {
  MotivoRequeridoError,
  RegresionEjecutadaError,
  TransicionInvalidaError,
} from '../errors/ordenes.errors.js';
import { ContactoSst } from '../value-objects/contacto-sst.vo.js';
import { HorasAsignadas } from '../value-objects/horas-asignadas.vo.js';
import { IdentidadOrden } from '../value-objects/identidad-orden.vo.js';
import { Nit } from '../value-objects/nit.vo.js';
import type { MetadatosExtraccion } from '../dto/metadatos-extraccion.dto.js';
import type { OrdenServicioDTO } from '../dto/orden-servicio.dto.js';
import type {
  ArlId,
  LoteImportacionId,
  OrdenServicioId,
  ProfesionalId,
  UsuarioId,
} from '../shared/identifiers.js';

/** Entrada para materializar una OS desde un borrador validado (Fase B). */
export interface CrearOrdenDesdeValidacion {
  readonly id: OrdenServicioId;
  readonly identidad: IdentidadOrden;
  readonly nitNic: Nit | null;
  readonly empresaNombre: string | null;
  readonly actividadEconomica: string | null;
  readonly horasAsignadas: HorasAsignadas | null;
  readonly descripcion: string | null;
  readonly contactoSst: ContactoSst;
  readonly loteImportacionId: LoteImportacionId | null;
  readonly urlArchivoOriginal: string | null;
  readonly metadatosExtraccion: MetadatosExtraccion | null;
  readonly codigo?: string | null;
}

/** Estado interno completo (usado por `reconstituir` desde el repositorio). */
export interface PropsOrdenServicio {
  readonly id: OrdenServicioId;
  readonly codigo: string | null;
  readonly identidad: IdentidadOrden;
  readonly nitNic: Nit | null;
  readonly empresaNombre: string | null;
  readonly actividadEconomica: string | null;
  readonly horasAsignadas: HorasAsignadas | null;
  readonly descripcion: string | null;
  readonly contactoSst: ContactoSst;
  readonly estado: EstadoOrden;
  readonly profesionalAsignadoId: ProfesionalId | null;
  readonly fechaProgramada: Date | null;
  readonly fechaEjecucion: Date | null;
  readonly loteImportacionId: LoteImportacionId | null;
  readonly urlArchivoOriginal: string | null;
  readonly metadatosExtraccion: MetadatosExtraccion | null;
  readonly fechaCarga: Date;
  readonly creadoEn: Date;
  readonly actualizadoEn: Date;
}

/**
 * Orden de Servicio — entidad central del dominio (`sst.ordenes_servicio`).
 *
 * Se materializa desde un borrador validado en estado inicial `SIN PROGRAMAR`
 * (IMP-09). Encapsula la máquina de estados EST-01..06 delegando en la política
 * pura de transición; `cambiarEstado` produce además la entrada de auditoría
 * para `order_status_history` (event source de Fases 2/3).
 */
export class OrdenServicio {
  private constructor(private props: PropsOrdenServicio) {}

  /**
   * Crea una OS validada por el humano. No puede fallar por invariantes de
   * campos porque estos ya llegan como Value Objects; el estado inicial es fijo.
   */
  static crearDesdeValidacion(
    input: CrearOrdenDesdeValidacion,
    ahora: Date = new Date(),
  ): OrdenServicio {
    return new OrdenServicio({
      id: input.id,
      codigo: input.codigo ?? null,
      identidad: input.identidad,
      nitNic: input.nitNic,
      empresaNombre: OrdenServicio.normalizar(input.empresaNombre),
      actividadEconomica: OrdenServicio.normalizar(input.actividadEconomica),
      horasAsignadas: input.horasAsignadas,
      descripcion: OrdenServicio.normalizar(input.descripcion),
      contactoSst: input.contactoSst,
      estado: EstadoOrden.SIN_PROGRAMAR,
      profesionalAsignadoId: null,
      fechaProgramada: null,
      fechaEjecucion: null,
      loteImportacionId: input.loteImportacionId,
      urlArchivoOriginal: input.urlArchivoOriginal,
      metadatosExtraccion: input.metadatosExtraccion,
      fechaCarga: ahora,
      creadoEn: ahora,
      actualizadoEn: ahora,
    });
  }

  static reconstituir(props: PropsOrdenServicio): OrdenServicio {
    return new OrdenServicio(props);
  }

  private static normalizar(texto: string | null): string | null {
    if (texto === null) return null;
    const limpio = texto.trim();
    return limpio.length > 0 ? limpio : null;
  }

  /** Identidad natural (clave de deduplicación IMP-07/09). */
  identidad(): IdentidadOrden {
    return this.props.identidad;
  }

  /**
   * Aplica una transición de estado (EST-01..06). En caso de éxito muta el
   * estado y devuelve la entrada de auditoría a persistir en el historial.
   */
  cambiarEstado(
    nuevoEstado: EstadoOrden,
    cambiadoPor: UsuarioId | null,
    motivo: string | null = null,
    ahora: Date = new Date(),
  ): Resultado<
    EntradaHistorialEstado,
    RegresionEjecutadaError | TransicionInvalidaError | MotivoRequeridoError
  > {
    const validacion = validarTransicion(this.props.estado, nuevoEstado, motivo);
    if (!validacion.ok) return validacion;

    const estadoAnterior = this.props.estado;
    const motivoLimpio = motivo !== null && motivo.trim().length > 0 ? motivo.trim() : null;

    this.props = {
      ...this.props,
      estado: nuevoEstado,
      fechaEjecucion:
        nuevoEstado === EstadoOrden.EJECUTADA ? ahora : this.props.fechaEjecucion,
      actualizadoEn: ahora,
    };

    return exito({
      ordenId: this.props.id,
      estadoAnterior,
      estadoNuevo: nuevoEstado,
      cambiadoPor,
      motivo: motivoLimpio,
      cambiadoEn: ahora,
    });
  }

  get id(): OrdenServicioId {
    return this.props.id;
  }
  get estado(): EstadoOrden {
    return this.props.estado;
  }
  get arlId(): ArlId {
    return this.props.identidad.arlId;
  }
  get metadatosExtraccion(): MetadatosExtraccion | null {
    return this.props.metadatosExtraccion;
  }

  /** Proyección serializable para la capa de presentación. */
  aDTO(): OrdenServicioDTO {
    const p = this.props;
    return {
      id: p.id,
      codigo: p.codigo,
      arlId: p.identidad.arlId,
      codigoCronograma: p.identidad.codigoCronograma,
      secuencia: p.identidad.secuencia,
      nitNic: p.nitNic?.valor ?? null,
      empresaNombre: p.empresaNombre,
      actividadEconomica: p.actividadEconomica,
      horasAsignadas: p.horasAsignadas?.valor ?? null,
      descripcion: p.descripcion,
      contactoSst: {
        nombre: p.contactoSst.nombre,
        telefono: p.contactoSst.telefono,
        correo: p.contactoSst.correo?.valor ?? null,
      },
      estado: p.estado,
      profesionalAsignadoId: p.profesionalAsignadoId,
      fechaProgramada: p.fechaProgramada?.toISOString() ?? null,
      fechaEjecucion: p.fechaEjecucion?.toISOString() ?? null,
      loteImportacionId: p.loteImportacionId,
      urlArchivoOriginal: p.urlArchivoOriginal,
      fechaCarga: p.fechaCarga.toISOString(),
      creadoEn: p.creadoEn.toISOString(),
      actualizadoEn: p.actualizadoEn.toISOString(),
    };
  }

  /** Vista inmutable del estado interno para mapeo en repositorios. */
  aPrimitivos(): PropsOrdenServicio {
    return { ...this.props };
  }
}
