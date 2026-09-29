// Verifica src/utils/dinero.js con los tres casos de la ficha A0-04 (valores
// reales de las facturas FE-775 y FE-781 de Siigo) y los bordes del redondeo.
// Uso: node scripts/verificar-dinero.mjs
import { aCentavos, deCentavos, sumar, porcentaje, formatoCOP } from '../src/utils/dinero.js';

let fallos = 0;
const igual = (obtenido, esperado, texto) => {
  const ok = obtenido === esperado;
  if (!ok) fallos++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${texto} → ${JSON.stringify(obtenido)}${ok ? '' : ` (esperado ${JSON.stringify(esperado)})`}`);
};

// Los tres casos de la ficha.
igual(deCentavos(porcentaje(aCentavos('3590216'), 2)), '71804.32', '3.590.216 × 2 %');
igual(deCentavos(porcentaje(aCentavos('3518411.68'), 11)), '387025.28', '3.518.411,68 × 11 %');
igual(deCentavos(porcentaje(aCentavos('1744386.56'), 19)), '331433.45', '1.744.386,56 × 19 %');

// Lo que un float hace mal.
igual(deCentavos(sumar([aCentavos(0.1), aCentavos(0.2)])), '0.30', '0,1 + 0,2 sin arrastre de float');
igual(aCentavos(1.005), 101, '1,005 → 101 centavos (half-up; Math.round(1.005*100) daría 100)');
igual(aCentavos('2.675'), 268, '"2.675" → 268 centavos');
igual(aCentavos(-0.005), -1, '-0,005 → -1 (half-up en magnitud, simétrico para notas crédito)');
igual(aCentavos('3590216.5'), 359021650, '"3590216.5" → 359021650');
igual(aCentavos(0.0000001), 0, '1e-7 (notación científica) → 0');

// Porcentajes con decimales: autorretención 1,1 % y ReteICA 5 por mil (0,5 %).
igual(deCentavos(porcentaje(aCentavos('3590216'), '1.1')), '39492.38', '3.590.216 × 1,1 %');
igual(deCentavos(porcentaje(aCentavos('1000000'), 0.5)), '5000.00', '1.000.000 × 0,5 %');

// Ida y vuelta y formato.
igual(deCentavos(aCentavos('0.07')), '0.07', 'ida y vuelta de 0,07');
igual(deCentavos(-5), '-0.05', 'negativos con ceros a la izquierda');
igual(formatoCOP(aCentavos('3590216')), '$ 3.590.216,00', 'formatoCOP');
igual(formatoCOP(aCentavos('-1234.5')), '-$ 1.234,50', 'formatoCOP negativo');

try {
  aCentavos('abc');
  igual('no lanzó', 'lanza', 'texto no numérico lanza');
} catch {
  igual('lanza', 'lanza', 'texto no numérico lanza');
}

if (fallos > 0) {
  console.error(`\n${fallos} caso(s) fallido(s).`);
  process.exit(1);
}
console.log('\nTodos los casos pasaron.');
