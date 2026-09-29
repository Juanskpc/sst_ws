/**
 * Dinero en CENTAVOS ENTEROS.
 *
 * Por qué existe: sumar importes como `float` da cifras como 0.1 + 0.2 =
 * 0.30000000000000004, y en una factura electrónica un centavo de diferencia
 * entre nuestro total y el que valida la DIAN es un rechazo. Todo cálculo
 * monetario del módulo financiero se hace aquí, con enteros; los decimales
 * solo aparecen al mostrar (`formatoCOP`) o al escribir en NUMERIC(16,2) /
 * en el JSON de Factus (`deCentavos`).
 *
 * Redondeo: *half-up* a centavos (la mitad se va hacia arriba en magnitud, así
 * que -0,005 → -0,01). Es el que muestra Siigo en las facturas de ejemplo
 * (plan de facturación §1.3).
 *
 * `numeric` de Postgres llega desde `pg` como TEXTO ("3590216.00"): por eso
 * `aCentavos` lee el texto decimal sin pasar por `Number`, que perdería
 * exactitud.
 */

/** Divide `n / d` (BigInt, d > 0) redondeando la mitad hacia arriba en magnitud. */
function dividirHalfUp(n, d) {
  const negativo = n < 0n;
  const abs = negativo ? -n : n;
  const q = (abs * 2n + d) / (d * 2n); // floor((abs + d/2) / d) sin fracciones
  return negativo ? -q : q;
}

/**
 * Convierte un decimal (texto o número) a BigInt escalado a `decimales`
 * posiciones, redondeando half-up lo que sobre. "1.005" con 2 → 101n.
 */
function escalar(valor, decimales) {
  let texto;
  if (typeof valor === 'number') {
    if (!Number.isFinite(valor)) throw new TypeError(`Importe no válido: ${valor}`);
    // toFixed evita la notación científica de String(1e-7) y da el decimal exacto de la representación binaria.
    texto = valor.toFixed(10);
  } else if (typeof valor === 'bigint') {
    return valor * 10n ** BigInt(decimales);
  } else {
    texto = String(valor ?? '').trim();
  }
  const m = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(texto);
  if (!m || (m[2] === '' && !m[3])) throw new TypeError(`Importe no válido: "${valor}"`);

  const negativo = m[1] === '-';
  const entera = m[2] || '0';
  const fraccion = m[3] || '';
  const base = BigInt(entera + fraccion.slice(0, decimales).padEnd(decimales, '0'));
  // Si sobran decimales, el primero decide el redondeo (half-up en magnitud).
  const redondea = fraccion.length > decimales && fraccion[decimales] >= '5' ? 1n : 0n;
  const r = base + redondea;
  return negativo ? -r : r;
}

/** Pesos (número o texto decimal) → centavos enteros. `3590216.5` → 359021650. */
export function aCentavos(valor) {
  return Number(escalar(valor, 2));
}

/**
 * Centavos → texto con dos decimales ("3590216.50"), listo para NUMERIC(16,2)
 * y para los campos de Factus (que reciben strings). No devuelve `number` a
 * propósito: volver a float es justo lo que este módulo evita.
 */
export function deCentavos(centavos) {
  const c = BigInt(Math.round(Number(centavos)));
  const negativo = c < 0n;
  const abs = negativo ? -c : c;
  const enteros = abs / 100n;
  const resto = (abs % 100n).toString().padStart(2, '0');
  return `${negativo ? '-' : ''}${enteros}.${resto}`;
}

/** Suma una lista de importes YA en centavos. */
export function sumar(lista) {
  return lista.reduce((acc, c) => acc + Math.round(Number(c)), 0);
}

/**
 * `pct` % de una base en centavos, redondeado half-up a centavos.
 * `pct` admite decimales ("1.1", 0.5 para el 5 por mil): se escala a 6
 * decimales y se opera en BigInt, así 11 % de 3.518.411,68 da 387.025,28 exacto.
 *
 * ⚠️ Redondea una vez por llamada: para una factura con varias líneas hay que
 * decidir si el impuesto se calcula por línea o sobre el total (lo fija A1-04);
 * esta función no lo decide.
 */
export function porcentaje(baseCentavos, pct) {
  const ESCALA = 6;
  const pctEscalado = escalar(pct, ESCALA);
  const base = BigInt(Math.round(Number(baseCentavos)));
  return Number(dividirHalfUp(base * pctEscalado, 100n * 10n ** BigInt(ESCALA)));
}

/** Formato es-CO a mano (sin depender del ICU de Node): `$ 3.590.216,00`. */
export function formatoCOP(centavos) {
  const [enteros, decimales] = deCentavos(centavos).split('.');
  const negativo = enteros.startsWith('-');
  const conPuntos = enteros.replace('-', '').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negativo ? '-' : ''}$ ${conPuntos},${decimales}`;
}
