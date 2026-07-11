/**
 * Nivel de confianza para los *badges* del split-view (M3).
 * Umbrales de presentación FIJOS (independientes del umbral configurable de
 * revisión de `app_settings`):
 *   - ALTA  → confianza ≥ 80  (verde)
 *   - MEDIA → 70 ≤ confianza < 80  (naranja)
 *   - BAJA  → confianza < 70  (rojo)
 */
export const NivelConfianza = {
  ALTA: 'ALTA',
  MEDIA: 'MEDIA',
  BAJA: 'BAJA',
} as const;

export type NivelConfianza = (typeof NivelConfianza)[keyof typeof NivelConfianza];
