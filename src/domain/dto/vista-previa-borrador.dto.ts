import type { NivelConfianza } from '../enums/nivel-confianza.enum.js';
import type { EstadoExtraccion } from '../enums/estado-extraccion.enum.js';

/**
 * Respuesta de la Fase A→B: proyección del borrador para el split-view (M3).
 *
 * Cada campo lleva su valor, confianza, nivel (badge) y si requiere revisión
 * contra el umbral vigente. Es un DTO de SALIDA (lo consume Angular), por eso
 * enriquece el crudo con `nivel`/`requiereRevision` ya calculados en backend.
 */
export interface CampoVistaPrevia<T> {
  readonly value: T | null;
  readonly confidence: number;
  readonly nivel: NivelConfianza;
  readonly requiereRevision: boolean;
}

export interface ContactoSstVistaPrevia {
  readonly nombre: CampoVistaPrevia<string>;
  readonly telefono: CampoVistaPrevia<string>;
  readonly correo: CampoVistaPrevia<string>;
}

export interface CamposVistaPrevia {
  readonly codigo_cronograma: CampoVistaPrevia<string>;
  readonly secuencia: CampoVistaPrevia<string>;
  readonly nit_nic: CampoVistaPrevia<string>;
  readonly empresa_nombre: CampoVistaPrevia<string>;
  readonly actividad_economica: CampoVistaPrevia<string>;
  readonly horas_asignadas: CampoVistaPrevia<number>;
  readonly contacto_sst: ContactoSstVistaPrevia;
  readonly descripcion: CampoVistaPrevia<string>;
}

export interface VistaPreviaBorradorDTO {
  readonly borradorId: string;
  readonly loteId: string;
  readonly arl: string | null;
  readonly nombreArchivo: string | null;
  readonly estado: EstadoExtraccion;
  readonly confianzaGeneral: number | null;
  readonly requiereRevision: boolean;
  readonly campos: CamposVistaPrevia;
}
