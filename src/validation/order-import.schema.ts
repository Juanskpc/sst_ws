import { z } from 'zod';
import type { MetadatosExtraccion } from '../domain/dto/metadatos-extraccion.dto.js';
import { type ResultadoValidacion, validarCon } from './validation-result.js';

/**
 * OrderImportSchema — contrato de validación de la EXTRACCIÓN de una OS (IMP-06).
 *
 * Cada campo canónico se modela como `{ value, confidence }`: el valor extraído
 * (o `null` si el formato/documento no lo trae) y su confianza 0-100. Esta es la
 * MISMA forma que `metadatos_extraccion` (JSONB) y que el DTO de dominio
 * `MetadatosExtraccion`; la guarda de paridad de más abajo impide que diverjan.
 *
 * Reglas de diseño:
 *   • `.nullable()` en vez de `.optional()`  → "puede faltar" = `null`, no ausencia
 *     (además OpenAI Structured Outputs en modo strict prohíbe opcionales).
 *   • Estructura y `confidence` se validan estrictamente; el CONTENIDO del valor
 *     se valida de forma laxa (un valor atípico lo corrige el humano en la vista
 *     previa y lo blindan los Value Objects del dominio al persistir).
 *   • `z.strictObject` rechaza claves no esperadas → detecta drift del contrato IA.
 */

// Confianza por campo: entero en [0, 100].
const confianza = z
  .number({ error: 'La confianza debe ser un número.' })
  .int({ error: 'La confianza debe ser un entero.' })
  .min(0, { error: 'La confianza no puede ser menor que 0.' })
  .max(100, { error: 'La confianza no puede ser mayor que 100.' });

/** Campo de texto extraído: `{ value: string | null, confidence }`. */
const campoTexto = (etiqueta: string) =>
  z.strictObject({
    value: z
      .string({ error: `El campo "${etiqueta}" debe ser texto o null.` })
      .nullable(),
    confidence: confianza,
  });

/** Campo numérico extraído: `{ value: number | null, confidence }`. */
const campoNumero = (etiqueta: string) =>
  z.strictObject({
    value: z
      .number({ error: `El campo "${etiqueta}" debe ser numérico o null.` })
      .nullable(),
    confidence: confianza,
  });

/** La descripción admite texto largo; tope de seguridad para evitar payloads abusivos. */
const MAX_DESCRIPCION = 20_000;
const campoDescripcion = z.strictObject({
  value: z
    .string({ error: 'La descripción debe ser texto o null.' })
    .max(MAX_DESCRIPCION, {
      error: `La descripción excede la longitud máxima (${MAX_DESCRIPCION} caracteres).`,
    })
    .nullable(),
  confidence: confianza,
});

/** Contacto SST (costura M8): responsable real de SST en la empresa cliente. */
const contactoSstSchema = z.strictObject({
  nombre: campoTexto('contacto SST · nombre'),
  telefono: campoTexto('contacto SST · teléfono'),
  correo: campoTexto('contacto SST · correo'),
});

/** Persona de contacto de la empresa cliente (p. ej. representante legal en AXA). */
const contactoEmpresaSchema = z.strictObject({
  nombre: campoTexto('contacto empresa · nombre'),
  cargo: campoTexto('contacto empresa · cargo'),
  telefono: campoTexto('contacto empresa · teléfono'),
});

/**
 * Esquema completo de una OS extraída por el pipeline IA.
 *
 * Cobertura por ARL (una misma orden nunca trae todos los campos):
 *  • Bolívar (Excel SIPAB): cronograma + secuencia, nit/empresa, actividad, horas, descripción.
 *  • AXA Colpatria (PDF): numero_orden, fechas, afiliación, valores, ciudad/dirección,
 *    tipo_actividad/modalidad, contacto empresa + contacto SST (en OBSERVACIONES).
 *  • Colmena (PDF): numero_orden, nit/empresa, ciudad_ejecucion, descripción, horas.
 * Los campos que una ARL no trae salen como { value: null }.
 */
export const OrderImportSchema = z.strictObject({
  // Identidad
  numero_orden: campoTexto('número de orden'),
  codigo_cronograma: campoTexto('cronograma'),
  secuencia: campoTexto('secuencia'),
  nro_afiliacion: campoTexto('número de afiliación'),
  // Empresa / actividad
  nit_nic: campoTexto('NIT/NIC'),
  empresa_nombre: campoTexto('empresa'),
  actividad_economica: campoTexto('actividad'),
  tipo_actividad: campoTexto('tipo de actividad'),
  modalidad: campoTexto('modalidad'),
  // Logística
  horas_asignadas: campoNumero('horas'),
  valor_unitario: campoNumero('valor unitario'),
  valor_total: campoNumero('valor total'),
  fecha_orden: campoTexto('fecha de la orden'),
  fecha_vencimiento: campoTexto('fecha de vencimiento'),
  ciudad_ejecucion: campoTexto('ciudad de ejecución'),
  direccion: campoTexto('dirección'),
  // Contactos y detalle
  contacto_empresa: contactoEmpresaSchema,
  contacto_sst: contactoSstSchema,
  descripcion: campoDescripcion,
  overall_confidence: confianza.nullable(),
});

/** Tipo inferido del esquema. Es, por construcción, `MetadatosExtraccion`. */
export type OrdenImportada = z.infer<typeof OrderImportSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Guarda de paridad en TIEMPO DE COMPILACIÓN.
// Si `OrderImportSchema` deja de ser estructuralmente equivalente al contrato
// de dominio `MetadatosExtraccion`, la línea siguiente NO compila. Así el schema
// (capa externa, con Zod) y el DTO (dominio puro, sin Zod) no pueden divergir.
// ───────────────────────────────────────────────────────────────────────────
type Equivalente<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _paridadSchemaDominio: Equivalente<OrdenImportada, MetadatosExtraccion> = true;
void _paridadSchemaDominio;

/**
 * Valida (y parsea) datos crudos contra {@link OrderImportSchema}.
 * Devuelve el objeto tipado o la lista de errores claros por campo.
 */
export function validarOrdenImportada(
  datos: unknown,
): ResultadoValidacion<OrdenImportada> {
  return validarCon(OrderImportSchema, datos);
}
