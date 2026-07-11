/**
 * Formato de origen del documento de la ARL.
 * Refleja el enum `sst.formato_arl` (schema.sql).
 *
 * Se modela como unión literal + objeto `as const` en lugar de `enum` de TS:
 * es *tree-shakeable*, sin runtime overhead y sin las trampas del `enum` nativo.
 */
export const FormatoArl = {
  EXCEL: 'excel',
  PDF: 'pdf',
} as const;

export type FormatoArl = (typeof FormatoArl)[keyof typeof FormatoArl];

export const FORMATOS_ARL = Object.values(FormatoArl) as readonly FormatoArl[];

export const esFormatoArl = (valor: string): valor is FormatoArl =>
  (FORMATOS_ARL as readonly string[]).includes(valor);
