/**
 * Contrato del JSON crudo de extracción (`metadatos_extraccion` JSONB).
 *
 * Es la forma EXACTA que produce el pipeline IA y que se persiste para auditar
 * la calidad del modelo (IMP-06). Se conserva en `snake_case` porque es el
 * contrato de datos con la IA / la columna JSONB, no una entidad de dominio.
 * La confianza viaja como número plano (0-100); el dominio la envuelve en el VO
 * `PuntajeConfianza` mediante mappers de la capa de aplicación.
 */

/** Par crudo `{ value, confidence }` de un campo extraído. */
export interface CampoCrudo<T> {
  readonly value: T | null;
  readonly confidence: number;
}

/** Contacto SST crudo tal como lo entrega la extracción. */
export interface ContactoSstCrudo {
  readonly nombre: CampoCrudo<string>;
  readonly telefono: CampoCrudo<string>;
  readonly correo: CampoCrudo<string>;
}

/** Estructura completa de metadatos de extracción de una OS. */
export interface MetadatosExtraccion {
  readonly codigo_cronograma: CampoCrudo<string>;
  readonly secuencia: CampoCrudo<string>;
  readonly nit_nic: CampoCrudo<string>;
  readonly empresa_nombre: CampoCrudo<string>;
  readonly actividad_economica: CampoCrudo<string>;
  readonly horas_asignadas: CampoCrudo<number>;
  readonly contacto_sst: ContactoSstCrudo;
  readonly descripcion: CampoCrudo<string>;
  /** Confianza global agregada (0-100); usada por la vista de KPIs (RPT-01). */
  readonly overall_confidence: number | null;
}

/** Claves canónicas de nivel superior a extraer (IMP-06). */
export const CAMPOS_CANONICOS = [
  'codigo_cronograma',
  'secuencia',
  'nit_nic',
  'empresa_nombre',
  'actividad_economica',
  'horas_asignadas',
  'contacto_sst',
  'descripcion',
] as const;

export type CampoCanonico = (typeof CAMPOS_CANONICOS)[number];
