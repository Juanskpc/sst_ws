/**
 * ARLs soportadas por el pipeline de importación (IMP-05).
 *
 * No existe como enum en la BD (allí `arls` es un catálogo por `nombre`), pero
 * es el resultado tipado del clasificador de documentos, por lo que vive en el
 * dominio como lenguaje ubicuo.
 *   - BOLIVAR  → Excel SIPAB (parsing determinista)
 *   - AXA      → PDF (extracción IA)
 *   - COLMENA  → PDF (extracción IA)
 */
export const TipoArl = {
  BOLIVAR: 'BOLIVAR',
  AXA: 'AXA',
  COLMENA: 'COLMENA',
} as const;

export type TipoArl = (typeof TipoArl)[keyof typeof TipoArl];

export const TIPOS_ARL = Object.values(TipoArl) as readonly TipoArl[];

export const esTipoArl = (valor: string): valor is TipoArl =>
  (TIPOS_ARL as readonly string[]).includes(valor);
