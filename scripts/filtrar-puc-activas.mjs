// Q-22 · Deja el PUC exportado de Siigo solo con las cuentas ACTIVAS.
//
// El informe "Cuentas contables" de Siigo trae todo el plan, incluidas las cuentas
// que la contadora no usa. Las de movimiento ("Transaccional") vienen marcadas en la
// columna "Activo"; las que agrupan no traen marca. Aquí se conservan las
// transaccionales con "Activo = Sí" y los niveles superiores de cada una. Una cuenta
// que agrupa y se queda sin ninguna activa debajo NO pasa: al importarla quedaría
// como hoja y recibiría movimiento.
//
//   node scripts/filtrar-puc-activas.mjs <entrada.xlsx> <salida.xlsx>
//
// La salida (Código, Nombre) se carga por la pantalla (Contabilidad → Plan de
// cuentas → Importar) o con sembrar-puc-desde-auxiliar.mjs en jdd_dev.
import XLSX from 'xlsx';
import { LONGITUDES, codigoPadre } from '../src/modules/contabilidad/cuentas.service.js';

const [entrada, salida] = process.argv.slice(2);
if (!entrada || !salida) {
  console.error('Uso: node scripts/filtrar-puc-activas.mjs <entrada.xlsx> <salida.xlsx>');
  process.exit(1);
}

const normalizar = (s) => String(s ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const wb = XLSX.readFile(entrada);
const filas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false });
const cab = filas.findIndex((f) => f.map(normalizar).includes('codigo') && f.map(normalizar).includes('activo'));
if (cab < 0) {
  console.error('No se encontró la fila de encabezados con las columnas "Código" y "Activo".');
  process.exit(1);
}
const col = Object.fromEntries(filas[cab].map((c, i) => [normalizar(c), i]));

const todas = new Map();
for (const f of filas.slice(cab + 1)) {
  const codigo = String(f[col.codigo] ?? '').trim();
  if (!/^[0-9]+$/.test(codigo)) continue;
  todas.set(codigo, {
    codigo,
    nombre: String(f[col.nombre] ?? '').trim(),
    transaccional: normalizar(f[col['nivel agrupacion']]) === 'transaccional',
    activa: normalizar(f[col.activo]) === 'si',
  });
}

const elegidas = new Map();
const longitudInvalida = [];
const sinNombreEnElExcel = new Set();
for (const c of todas.values()) {
  if (!c.transaccional || !c.activa) continue;
  if (!LONGITUDES.includes(c.codigo.length)) { longitudInvalida.push(c); continue; }
  elegidas.set(c.codigo, c);
  for (let p = codigoPadre(c.codigo); p; p = codigoPadre(p)) {
    if (todas.has(p)) elegidas.set(p, todas.get(p));
    else sinNombreEnElExcel.add(p);
  }
}

const orden = [...elegidas.values()].sort((a, b) => a.codigo.localeCompare(b.codigo));
const hoja = XLSX.utils.aoa_to_sheet([['Código', 'Nombre'], ...orden.map((c) => [c.codigo, c.nombre])]);
// Texto, no número: Excel le quitaría los ceros y pondría notación científica a los de 10 dígitos.
for (let i = 0; i < orden.length; i++) hoja[XLSX.utils.encode_cell({ r: i + 1, c: 0 })].t = 's';
const libro = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(libro, hoja, 'Cuentas activas');
XLSX.writeFile(libro, salida);

const transaccionales = [...todas.values()].filter((c) => c.transaccional);
console.log(`Cuentas en el archivo: ${todas.size} · de movimiento: ${transaccionales.length} · activas: ${transaccionales.filter((c) => c.activa).length}`);
console.log(`Escritas en ${salida}: ${orden.length} (${orden.filter((c) => c.transaccional).length} de movimiento + ${orden.filter((c) => !c.transaccional).length} niveles superiores)`);
if (longitudInvalida.length) {
  console.log('Activas que NO pasan por la longitud del código (válidas: 1, 2, 4, 6, 8 o 10 dígitos):');
  for (const c of longitudInvalida) console.log(`  ${c.codigo}  ${c.nombre}`);
}
if (sinNombreEnElExcel.size) {
  console.log(`Niveles superiores que el Excel no trae (se crearán "por confirmar"): ${[...sinNombreEnElExcel].sort().join(', ')}`);
}
