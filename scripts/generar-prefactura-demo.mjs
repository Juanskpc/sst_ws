/**
 * Genera una prefactura de PRUEBA, con el formato del "DETALLE PREFACTURA" de
 * Bolívar, que cuadra con las órdenes de `2-pruebas/ordenes/bolivar/demo-bolivar-sipab.xlsx`.
 *
 *   node scripts/generar-prefactura-demo.mjs                  → 170601, cuadra al peso
 *   node scripts/generar-prefactura-demo.mjs --valor-hora 70000 --numero 170602
 *
 * Lee las filas del propio Excel (cronograma, secuencia, NIT, razón social,
 * programa, horas y los gastos de las columnas "Valor …"), así que si el Excel se
 * regenera la prefactura se regenera con él. Valor de cada fila = horas × valor
 * hora + transporte + alojamiento + alimentación + tiempo muerto + material, la
 * misma cuenta del modal de cobro de Orbita. El valor hora por defecto es la
 * tarifa de venta de Bolívar en jdd_dev al 30-sep-2026 ($71.457).
 *
 * Sale en `2-pruebas/prefacturas/bolivar/` (raíz del monorepo, fuera de git). El
 * PDF lleva un pie en rojo que dice que NO es un documento real de Bolívar.
 * Basado en el script desechable con el que se hicieron 170501/170502 (29-sep).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..', '..', '2-pruebas');
const EXCEL = path.join(RAIZ, 'ordenes', 'bolivar', 'demo-bolivar-sipab.xlsx');
const DEST = path.join(RAIZ, 'prefacturas', 'bolivar');

const arg = (nombre, defecto) => {
  const i = process.argv.indexOf(`--${nombre}`);
  return i > 0 ? process.argv[i + 1] : defecto;
};
const VALOR_HORA = Number(arg('valor-hora', 71457));
const NUMERO = arg('numero', '170601');
const CORTE = arg('corte', '15/10/2026');

const peso = (n) => '$' + Math.round(n).toLocaleString('en-US');
const norm = (s) => String(s ?? '').trim().toLowerCase();
const num = (v) => Number(String(v?.result ?? v ?? '').replace(/[^\d.-]/g, '')) || 0;

// ─── 1 · Filas del Excel demo ───
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(EXCEL);
const ws = wb.worksheets[0];
const cab = ws.getRow(1).values.map(norm);
const col = (n) => {
  const i = cab.indexOf(n);
  if (i < 0) throw new Error(`El Excel no trae la columna "${n}"`);
  return i;
};
const C = {
  nit: col('nit empresa'), razon: col('razon social'), cron: col('numero cronograma'),
  sec: col('actividad cronograma'), programa: col('actividad programa'), unidad: col('unidad medida'),
  horas: col('act programadas'), transporte: col('valor transporte'), alojamiento: col('valor alojamiento'),
  alimentacion: col('valor alimentacion'), tiempo: col('valor tiempo muerto'), material: col('valor material complementario'),
};
const filas = [];
for (let r = 2; r <= ws.rowCount; r++) {
  const v = ws.getRow(r).values;
  if (!v[C.cron]) continue;
  const horas = /hora/i.test(String(v[C.unidad] ?? '')) ? num(v[C.horas]) : 0;
  const f = {
    cron: String(v[C.cron]), sec: String(v[C.sec]), nit: String(v[C.nit]), razon: String(v[C.razon]),
    programa: String(v[C.programa]), horas,
    actividad: horas * VALOR_HORA,
    alimentacion: num(v[C.alimentacion]), alojamiento: num(v[C.alojamiento]), transporte: num(v[C.transporte]),
    material: num(v[C.material]), tiempo: num(v[C.tiempo]),
  };
  f.total = f.actividad + f.alimentacion + f.alojamiento + f.transporte + f.material + f.tiempo;
  filas.push(f);
}

// ─── 2 · El PDF, con la disposición del original (A4 apaisado) ───
const doc = await PDFDocument.create();
const fuente = await doc.embedFont(StandardFonts.Helvetica);
const negrita = await doc.embedFont(StandardFonts.HelveticaBold);
const p = doc.addPage([842, 595]);
const T = (t, x, y, s = 7, font = fuente, c = rgb(0, 0, 0)) => p.drawText(String(t), { x, y, size: s, font, color: c });
const total = filas.reduce((a, f) => a + f.total, 0);
const honorarios = filas.reduce((a, f) => a + f.actividad, 0);

T('DETALLE PREFACTURA', 330, 560, 14, negrita);
T('Sistema de Información de Prevención', 250, 542, 9, negrita);
T('Fecha de Reporte:', 470, 542, 9, negrita); T(`${CORTE} 15:29`, 560, 542, 8);
T('Módulo: FACTURACIÓN', 300, 528, 9, negrita);
[
  ['NUMERO PREFACTURA:', NUMERO, 'VALOR FACTURA:', peso(total)],
  ['PLAN:', '1', 'DESCRIPCION PLAN:', 'PLAN ESPECIFICO DE CAPACITACION Y ASISTENCIA TECNICA PECAT - PECAT'],
  ['PROVEEDOR:', '6484', 'NOMBRE COMERCIAL:', 'JD Y D CONSULTORES EN SISTEMAS DE GESTION SAS'],
  ['NIT PROVEEDOR:', '901203812', 'RAZON SOCIAL:', 'JD Y D CONSULTORES EN SISTEMAS DE GESTION SAS'],
  ['NUMERO AUTORIZACIÓN:', '', 'CON NUMERO AUTORIZACION:', 'N'],
  ['VALOR DEBITO:', '$0', 'VALOR TOTAL FACTURA:', peso(total)],
  ['FECHA CORTE:', CORTE, 'ESTADO FACTURADO:', 'N'],
].forEach((r, i) => {
  const y = 505 - i * 14;
  T(r[0], 40, y, 7, negrita); T(r[1], 150, y); T(r[2], 290, y, 7, negrita); T(r[3], 410, y);
});
T('CLASE SERVICIO', 40, 395, 7, negrita); T('TOTAL', 150, 395, 7, negrita);
T('HONORARIOS', 40, 383); T(peso(honorarios), 150, 383);
if (total > honorarios) { T('ALOJA ALIMENTA', 40, 371); T(peso(total - honorarios), 150, 371); }

const cols = [['Numero Cronograma', 30], ['Secuencia Actividad', 95], ['NIT Empresa', 150], ['Razón Social', 205],
  ['Actividad Programa', 390], ['Vlr Actividad', 450], ['Vlr Alimentación', 505], ['Vlr Alojamiento', 565],
  ['Vlr Transporte', 625], ['Material', 685], ['Tiempo M.', 730], ['Vlr a Facturar', 780]];
cols.forEach(([t, x]) => T(t, x, 350, 6, negrita));
filas.forEach((f, i) => {
  const y = 332 - i * 16;
  [f.cron, f.sec, f.nit, f.razon.slice(0, 38), f.programa, peso(f.actividad), peso(f.alimentacion),
    peso(f.alojamiento), peso(f.transporte), peso(f.material), peso(f.tiempo), peso(f.total)]
    .forEach((v, k) => T(v, cols[k][1], y, 6.5));
});
T(`EJEMPLO DE PRUEBA para Orbita — no es un documento real de Seguros Bolívar. Cruza con demo-bolivar-sipab.xlsx a ${peso(VALOR_HORA)}/hora.`,
  30, 30, 7, negrita, rgb(0.8, 0.1, 0.1));
T('Pagina 1 de 1', 760, 18, 7);

fs.mkdirSync(DEST, { recursive: true });
const ruta = path.join(DEST, `${NUMERO}-demo-bolivar.pdf`);
fs.writeFileSync(ruta, await doc.save());
console.log(ruta);
for (const f of filas) console.log(`  ${f.cron}-${f.sec}  ${String(f.horas).padStart(2)} h  ${peso(f.actividad).padStart(10)} + gastos ${peso(f.total - f.actividad).padStart(9)} = ${peso(f.total)}`);
console.log(`  TOTAL ${peso(total)}`);
