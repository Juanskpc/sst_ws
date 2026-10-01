import { z } from 'zod';

/**
 * T0-09 · Esquema de Structured Outputs para el "DETALLE PREFACTURA" que emite
 * Bolívar (ver `1-cliente-jdd/prefacturas/bolivar/*.pdf`, no viaja por git).
 *
 * `.nullable()` y no `.optional()` en todo lo que puede faltar: OpenAI
 * Structured Outputs en modo estricto no admite claves opcionales (mismo motivo
 * que `order-import.schema.ts`). Los importes son `number` porque el control
 * determinista de la suma (§T0-09) los necesita como número, no como texto.
 */
const filaSchema = z.object({
  codigo_cronograma: z.string(),
  secuencia: z.string(),
  nit_empresa: z.string().nullable(),
  razon_social: z.string().nullable(),
  actividad_programa: z.string().nullable(),
  valor_actividad: z.number(),
  alimentacion: z.number(),
  alojamiento: z.number(),
  transporte: z.number(),
  material: z.number(),
  tiempo_muerto: z.number(),
  valor_a_facturar: z.number(),
});

export const PrefacturaSchema = z.object({
  numero_prefactura: z.string(),
  plan_codigo: z.string().nullable(),
  plan_descripcion: z.string().nullable(),
  // Tal como aparece impresa, "DD/MM/AAAA": se normaliza a ISO después, con
  // `parseFechaCO`, igual que cualquier otra fecha de un documento de la ARL.
  fecha_corte: z.string().nullable(),
  valor_total: z.number(),
  nit_proveedor: z.string().nullable(),
  filas: z.array(filaSchema),
});
