/**
 * Los dos enumerados que Bolívar exige en su formato AT-031.
 *
 * Salen del comunicado SNPARL-40035219-2025 ("Actualización Formato AT 031 –
 * AT 028", obligatorio desde el 10-sep-2025), que es el que fija tanto las seis
 * letras del tipo de actividad como la regla de arriba:
 *
 *   * **AT-031** vale para actividades PRESENCIALES **O** VIRTUALES.
 *   * **AT-028** es **únicamente para actividades presenciales**.
 *
 * Por eso la modalidad no es un adorno del formato: decide si el registro de
 * asistencia se emite o no. Vive aquí, y no dentro del servicio de formatos,
 * porque la usan también la extracción, la validación del borrador y la API.
 *
 * `src/../../jdd_consultores_app/src/app/core/bolivar.ts` es su espejo en el
 * frontend, igual que `personas.js` / `personas.ts`: si cambia una lista, cambia
 * la otra.
 */

/**
 * Tipo de actividad del AT-031. La CLAVE es la letra que trae la columna
 * "Tipo Servicio" del Excel SIPAB (valores reales vistos: A, T, C).
 *
 * El orden importa: es el mismo en el que están impresas las casillas del
 * formato, y de él sale el índice del botón que hay que marcar.
 */
export const TIPOS_ACTIVIDAD_BOLIVAR = [
  { letra: 'A', etiqueta: 'Asesoría' },
  { letra: 'T', etiqueta: 'Asistencia Técnica' },
  { letra: 'C', etiqueta: 'Capacitación' },
  { letra: 'E', etiqueta: 'Servicio Especializado' },
  { letra: 'M', etiqueta: 'Material' },
  { letra: 'O', etiqueta: 'Otros' },
];

/** Modalidad de ejecución. El orden es el de las casillas del AT-031. */
export const MODALIDADES_EJECUCION = [
  { clave: 'PRESENCIAL', etiqueta: 'Presencial' },
  { clave: 'VIRTUAL', etiqueta: 'Virtual' },
];

const LETRAS = new Set(TIPOS_ACTIVIDAD_BOLIVAR.map((t) => t.letra));
const CLAVES_MODALIDAD = new Set(MODALIDADES_EJECUCION.map((m) => m.clave));

/**
 * La letra si es una de las seis, o null.
 *
 * Devuelve null en vez de arriesgar una equivalencia: una celda con basura no
 * puede acabar marcando "Asesoría" en un formato que se radica ante la ARL. Lo
 * que no se reconoce se queda sin marcar y lo elige quien revisa.
 */
export function normalizarTipoActividadBolivar(bruto) {
  const letra = String(bruto ?? '').trim().toUpperCase().charAt(0);
  return LETRAS.has(letra) ? letra : null;
}

/** 'presencial', 'Virtual ' → 'PRESENCIAL' / 'VIRTUAL'; cualquier otra cosa, null. */
export function normalizarModalidadEjecucion(bruto) {
  const clave = String(bruto ?? '').trim().toUpperCase();
  return CLAVES_MODALIDAD.has(clave) ? clave : null;
}

/** 'T' → 'Asistencia Técnica'. Para los correos y los avisos. */
export function etiquetaTipoActividadBolivar(letra) {
  const l = normalizarTipoActividadBolivar(letra);
  return TIPOS_ACTIVIDAD_BOLIVAR.find((t) => t.letra === l)?.etiqueta ?? null;
}

/** Índice de la casilla a marcar en el AT-031 (0-5), o -1 si no aplica. */
export function indiceTipoActividadBolivar(letra) {
  return TIPOS_ACTIVIDAD_BOLIVAR.findIndex((t) => t.letra === normalizarTipoActividadBolivar(letra));
}

/** Índice de la casilla de modalidad en el AT-031 (0 presencial, 1 virtual). */
export function indiceModalidad(clave) {
  return MODALIDADES_EJECUCION.findIndex((m) => m.clave === normalizarModalidadEjecucion(clave));
}

/**
 * ¿Esta ARL es Bolívar? El nombre llega de la BD ("Bolívar"), así que se compara
 * sin tildes ni mayúsculas.
 */
export function esBolivar(arlNombre) {
  return String(arlNombre ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().includes('bolivar');
}
