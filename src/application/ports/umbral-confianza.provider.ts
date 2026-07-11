/**
 * Proveedor del umbral de confianza vigente (0-100).
 *
 * Es un puerto (no un valor fijo) porque el umbral es CONFIGURABLE en runtime
 * (`app_settings`, por defecto 70). Así el caso de uso no lo hardcodea ni lee la
 * BD directamente.
 */
export interface UmbralConfianzaProvider {
  obtener(): Promise<number>;
}
