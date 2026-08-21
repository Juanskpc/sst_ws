/**
 * Conversión de los textos que llegan del documento (o del formulario) a los
 * tipos que espera la base de datos.
 *
 * Es la dirección contraria a `utils/formato.js`, que escribe para el usuario
 * final. Vive aparte porque tiene DOS llamadores que deben coincidir: la
 * materialización de un borrador (`drafts.routes.js`) y la edición posterior de
 * la OS (`orders.routes.js`). Si divergieran, el mismo "588.560,00" quedaría
 * guardado como dos números distintos según por dónde entrara.
 */

/** "588.560,00" | "$ 58.856" | 588560 → 588560. Devuelve number o null. */
export function parseNumeroCO(raw) {
  if (raw == null || raw === '') return null;
  let s = String(raw).trim().replace(/[^\d.,-]/g, '');
  if (!s) return null;
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) s = s.replace(/\./g, '').replace(',', '.'); // CO: . miles, , decimal
  else if (hasComma) s = s.replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// Meses abreviados en español y en inglés: el SIPAB de Bolívar escribe la fecha
// como `01/aug/2026`, y quien corrige a mano puede escribir `01/ago/2026`.
const MESES_ABREVIADOS = {
  ene: 1, jan: 1, feb: 2, mar: 3, abr: 4, apr: 4, may: 5, jun: 6, jul: 7,
  ago: 8, aug: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12, dec: 12,
};

/** "26/06/2026" | "01/aug/2026" | "2026-06-26" → "YYYY-MM-DD", o null. */
export function parseFechaCO(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  // El parser del Excel ya normaliza a ISO; esto es la red de seguridad para el
  // texto que llegue por otra vía (una corrección a mano, un reproceso).
  m = /^(\d{1,2})[/-]([A-Za-zÀ-ſ]{3,9})\.?[/-](\d{4})$/.exec(s);
  if (m) {
    const mes = MESES_ABREVIADOS[
      m[2].normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().slice(0, 3)
    ];
    if (mes) return `${m[3]}-${String(mes).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}
