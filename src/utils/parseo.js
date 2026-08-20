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

/** "26/06/2026" | "2026-06-26" → "YYYY-MM-DD". Devuelve string ISO o null. */
export function parseFechaCO(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}
