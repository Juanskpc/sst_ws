/**
 * Rate limiter en memoria por clave (ventana deslizante simple).
 * Suficiente para el despliegue single-instance de Fase 1; si el backend
 * escala horizontalmente, sustituir el Map por Redis manteniendo esta firma.
 */
export function createRateLimiter({ windowMs, max }) {
  const hits = new Map(); // clave → [timestamps]

  return {
    /** Registra un intento y devuelve true si la clave superó el límite. */
    isLimited(key) {
      const now = Date.now();
      const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (list.length >= max) {
        hits.set(key, list);
        return true;
      }
      list.push(now);
      hits.set(key, list);
      // Poda oportunista para no crecer sin límite.
      if (hits.size > 10000) {
        for (const [k, v] of hits) {
          if (!v.length || now - v[v.length - 1] >= windowMs) hits.delete(k);
        }
      }
      return false;
    },
  };
}
