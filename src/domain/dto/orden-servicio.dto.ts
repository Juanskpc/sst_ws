import type { EstadoOrden } from '../enums/estado-orden.enum.js';

/**
 * Proyección serializable de una OS (contrato de salida hacia Angular).
 * Fechas como ISO-8601 (`string`) para transporte JSON. `camelCase` de cliente.
 */
export interface ContactoSstDTO {
  readonly nombre: string | null;
  readonly telefono: string | null;
  readonly correo: string | null;
}

export interface OrdenServicioDTO {
  readonly id: string;
  readonly codigo: string | null;
  readonly arlId: string;
  readonly codigoCronograma: string;
  readonly secuencia: string;
  readonly nitNic: string | null;
  readonly empresaNombre: string | null;
  readonly actividadEconomica: string | null;
  readonly horasAsignadas: number | null;
  readonly descripcion: string | null;
  readonly contactoSst: ContactoSstDTO;
  readonly estado: EstadoOrden;
  readonly profesionalAsignadoId: string | null;
  readonly fechaProgramada: string | null;
  readonly fechaEjecucion: string | null;
  readonly loteImportacionId: string | null;
  readonly urlArchivoOriginal: string | null;
  readonly fechaCarga: string;
  readonly creadoEn: string;
  readonly actualizadoEn: string;
}
