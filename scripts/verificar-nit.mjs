// Verifica el algoritmo del DV del NIT contra los NIT reales del plan (§3).
// Uso: node scripts/verificar-nit.mjs
//
// `src/utils/nit.js` es el de ADMIN_APP/admin_ws/app_core/helpers/nit.js (ya
// verificado allá contra NIT reales) portado a ESM sin tocar el algoritmo. Los
// cinco primeros casos son los de la ficha A0-01 del plan de facturación; los
// dos siguientes son NIT públicos (DIAN y Bancolombia) que ancla el algoritmo.
import { calcularDv, esDvValido, separarNit } from '../src/utils/nit.js';

const casos = [
  ['901203812', 4, 'JD&D'],
  ['860002183', 9, 'AXA Colpatria'],
  ['800226175', 3, 'Colmena'],
  ['830008686', 1, 'La Equidad'],
  ['891200297', 1, 'Transporte de Sandoná'],
  ['800197268', 4, 'DIAN'],
  ['890903938', 8, 'Bancolombia'],
];

let fallos = 0;
const comprobar = (ok, texto) => {
  if (!ok) fallos++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${texto}`);
};

for (const [nit, esperado, quien] of casos) {
  const obtenido = calcularDv(nit);
  comprobar(obtenido === esperado, `${quien}: NIT ${nit} → DV ${obtenido} (esperado ${esperado})`);
  comprobar(esDvValido(nit, esperado), `${quien}: esDvValido(${nit}, ${esperado})`);
}

// Formatos que se ven en la vida real: puntos, guion y espacios.
const sep = separarNit('860.002.183-9');
comprobar(sep.numero === '860002183' && sep.dv === '9' && sep.coherente === true, `separarNit('860.002.183-9') → ${JSON.stringify(sep)}`);
// El DV pegado no se adivina: hay que dejar que lo capture una persona.
const pegado = separarNit('8600021839');
comprobar(pegado.numero === '8600021839' && pegado.dv === null, `separarNit('8600021839') no adivina el DV → ${JSON.stringify(pegado)}`);
comprobar(calcularDv('') === null && calcularDv('abc') === null, 'un NIT vacío o sin dígitos da null');

if (fallos > 0) {
  console.error(`\n${fallos} caso(s) fallido(s).`);
  process.exit(1);
}
console.log('\nTodos los casos pasaron.');
