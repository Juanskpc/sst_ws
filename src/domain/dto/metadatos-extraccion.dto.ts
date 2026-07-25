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

/** Contacto SST crudo tal como lo entrega la extracción (responsable SST real). */
export interface ContactoSstCrudo {
  readonly nombre: CampoCrudo<string>;
  readonly telefono: CampoCrudo<string>;
  readonly correo: CampoCrudo<string>;
}

/** Contacto de la empresa cliente (p. ej. representante legal en AXA). */
export interface ContactoEmpresaCrudo {
  readonly nombre: CampoCrudo<string>;
  readonly cargo: CampoCrudo<string>;
  readonly telefono: CampoCrudo<string>;
}

/** Estructura completa de metadatos de extracción de una OS. */
export interface MetadatosExtraccion {
  readonly numero_orden: CampoCrudo<string>;
  readonly codigo_cronograma: CampoCrudo<string>;
  readonly secuencia: CampoCrudo<string>;
  readonly nro_afiliacion: CampoCrudo<string>;
  readonly nit_nic: CampoCrudo<string>;
  readonly empresa_nombre: CampoCrudo<string>;
  readonly actividad_economica: CampoCrudo<string>;
  readonly tipo_actividad: CampoCrudo<string>;
  readonly modalidad: CampoCrudo<string>;
  readonly horas_asignadas: CampoCrudo<number>;
  readonly valor_unitario: CampoCrudo<number>;
  readonly valor_total: CampoCrudo<number>;
  readonly fecha_orden: CampoCrudo<string>;
  readonly fecha_vencimiento: CampoCrudo<string>;
  readonly ciudad_ejecucion: CampoCrudo<string>;
  readonly direccion: CampoCrudo<string>;
  readonly contacto_empresa: ContactoEmpresaCrudo;
  readonly contacto_sst: ContactoSstCrudo;
  readonly descripcion: CampoCrudo<string>;
  /** Confianza global agregada (0-100); usada por la vista de KPIs (RPT-01). */
  readonly overall_confidence: number | null;
}

/** Claves canónicas de nivel superior a extraer (IMP-06). */
export const CAMPOS_CANONICOS = [
  'numero_orden',
  'codigo_cronograma',
  'secuencia',
  'nro_afiliacion',
  'nit_nic',
  'empresa_nombre',
  'actividad_economica',
  'tipo_actividad',
  'modalidad',
  'horas_asignadas',
  'valor_unitario',
  'valor_total',
  'fecha_orden',
  'fecha_vencimiento',
  'ciudad_ejecucion',
  'direccion',
  'contacto_empresa',
  'contacto_sst',
  'descripcion',
] as const;

export type CampoCanonico = (typeof CAMPOS_CANONICOS)[number];
