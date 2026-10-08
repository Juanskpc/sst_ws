// 8-oct-2026 · Las 20 pruebas de NÓMINA ELECTRÓNICA que pide el proveedor tecnológico
// para habilitar la nota de ajuste y, después, la producción. Cubre lo que exige su
// lista: salarios y colaboradores distintos, prima, cesantías, vacaciones, licencia,
// horas extra y recargos, y meses diferentes.
//
//   node --import tsx scripts/nomina-pruebas-sandbox.mjs                 → SIMULA: arma y revisa las 20, no envía nada
//   node --import tsx scripts/nomina-pruebas-sandbox.mjs --enviar --solo=1   → envía solo la n.º 1 (para probar el formato)
//   node --import tsx scripts/nomina-pruebas-sandbox.mjs --enviar            → envía las 20
//   opciones: --rango=<id del rango de nómina>   --fecha-hora=T (por defecto, con espacio, como el ejemplo oficial)
//
// Solo corre contra el ambiente de PRUEBAS y, para enviar, exige las credenciales de
// pruebas propias del NIT (FACTUS_NOMINA_* en .env): con las genéricas las pruebas no
// le cuentan a JD&D. Los trabajadores son inventados. Guarda cada cuerpo y cada
// respuesta en 2-pruebas/nomina/ (fuera de git).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../src/config/env.js';
import { proveedorFE } from '../src/modules/facturacion/index.js';
import { liquidar, parametrosDe } from '../src/modules/nomina/calculo.js';

const args = process.argv.slice(2);
const opcion = (n) => args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const ENVIAR = args.includes('--enviar');
const SOLO = opcion('solo') ? Number(opcion('solo')) : null;
const SEPARADOR = opcion('fecha-hora') === 'T' ? 'T' : ' ';
const SMMLV = parametrosDe(2026).smmlv;

/** Fecha y hora de 2026; una hora de 24 en adelante cae en el día siguiente (turno que pasa la medianoche). */
const hora = (dia, h, mes) => new Date(Date.UTC(2026, mes - 1, dia, h)).toISOString().slice(0, 19).replace('T', SEPARADOR);
const fecha = (mes, dia) => `2026-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
/** Horas extra o recargo de `n` horas el día `dia`, empezando a la hora `desde`. */
const he = (tipo, n, mes, dia, desde) => ({ tipo, cantidad: n, inicio: hora(dia, desde, mes), fin: hora(dia, desde + n, mes) });

// nombre, documento, salario, mes, contrato (1 fijo · 2 indefinido), ingreso, qué prueba, novedades
const CASOS = [
  ['Mateo Andrés Gómez Forero', '1085301201', SMMLV, 1, 2, '2023-03-15', 'Salario mínimo, mes completo', {}],
  ['Laura Sofía Rosero Benavides', '1085301202', 2_000_000, 2, 2, '2022-08-01', 'Horas extra diurnas y nocturnas', { horas: [he('HED', 5, 2, 10, 17), he('HEN', 2, 2, 12, 21)] }],
  ['Carlos Eduardo Narváez Ortiz', '1085301203', 2_800_000, 3, 1, '2024-01-10', 'Recargo nocturno', { horas: [he('HRN', 8, 3, 17, 21)] }],
  ['Diana Marcela Erazo Luna', '1085301204', 3_200_000, 4, 2, '2021-05-03', 'Dominical: hora extra y recargo diurnos', { horas: [he('HEDDF', 4, 4, 12, 14), he('HRDDF', 6, 4, 19, 8)] }],
  ['Andrés Felipe Burbano Cabrera', '1085301205', 1_900_000, 5, 1, '2025-02-17', 'Dominical nocturno: hora extra y recargo', { horas: [he('HENDF', 3, 5, 17, 21), he('HRNDF', 2, 5, 24, 21)] }],
  ['Paola Andrea Muñoz Delgado', '1085301206', SMMLV, 6, 2, '2020-11-02', 'Prima de servicios, semestre completo', { prima: { dias: 180 } }],
  ['Jorge Luis Chaves Pantoja', '1085301207', 2_500_000, 6, 1, '2026-04-01', 'Prima proporcional (ingresó en abril)', { prima: { dias: 90 } }],
  ['Natalia Guerrero Santacruz', '1085301208', 2_200_000, 2, 2, '2019-07-22', 'Cesantías e intereses, año completo', { cesantias: { dias: 360 } }],
  ['Óscar Iván Mora Villota', '1085301209', 1_800_000, 8, 1, '2026-04-01', 'Cesantías e intereses proporcionales', { cesantias: { dias: 120 } }],
  ['Camila Alejandra Córdoba Rivas', '1085301210', 2_600_000, 3, 2, '2022-02-14', 'Vacaciones disfrutadas (15 días)', { vacaciones: [{ dias: 15, inicio: fecha(3, 9), fin: fecha(3, 23) }] }],
  ['Santiago Jurado Enríquez', '1085301211', 3_000_000, 7, 2, '2018-09-10', 'Vacaciones compensadas en dinero', { vacaciones: [{ dias: 7, compensadas: true }] }],
  ['Valentina Rodríguez Zambrano', '1085301212', 2_100_000, 4, 1, '2024-06-03', 'Licencia remunerada (3 días)', { licencias: [{ tipo: 'REMUNERADA', dias: 3, inicio: fecha(4, 14), fin: fecha(4, 16) }] }],
  ['Julián David Arteaga Bravo', '1085301213', SMMLV, 5, 2, '2023-10-02', 'Licencia no remunerada (5 días)', { licencias: [{ tipo: 'NO_REMUNERADA', dias: 5, inicio: fecha(5, 11), fin: fecha(5, 15) }] }],
  ['Sebastián Lasso Insuasty', '1085301214', 4_500_000, 8, 2, '2021-01-18', 'Licencia de paternidad (14 días)', { licencias: [{ tipo: 'MATERNIDAD', dias: 14, inicio: fecha(8, 3), fin: fecha(8, 16) }] }],
  ['María Fernanda Timaná López', '1085301215', 2_300_000, 9, 1, '2025-08-11', 'Incapacidad por enfermedad común (4 días)', { incapacidades: [{ dias: 4, inicio: fecha(9, 7), fin: fecha(9, 10) }] }],
  ['Ricardo Alfonso Paz Coral', '1085301216', 8_000_000, 6, 2, '2017-03-01', 'Salario alto: fondo de solidaridad pensional', {}],
  ['Gloria Patricia Meneses Ruales', '1085301217', 12_000_000, 9, 2, '2016-06-13', 'Salario alto con comisiones', { comisiones: 1_500_000 }],
  ['Daniel Esteban Portilla Yela', '1085301218', 1_950_000, 7, 1, '2025-11-04', 'Bonificación y horas extra tras el cambio de jornada', { bonificacion: 300_000, horas: [he('HED', 10, 7, 21, 8)] }],
  ['Adriana Lucía Solarte Montenegro', '1085301219', 13 * SMMLV, 8, 2, '2015-02-02', 'Salario integral', { integral: true }],
  ['Felipe Ernesto Zúñiga Realpe', '1085301220', 2_750_000, 9, 2, '2020-04-20', 'Varias novedades en el mismo mes', { horas: [he('HED', 6, 9, 3, 17), he('HRN', 8, 9, 22, 21)], vacaciones: [{ dias: 5, inicio: fecha(9, 14), fin: fecha(9, 18) }], comisiones: 400_000 }],
];

const sello = new Date().toISOString().replace(/\D/g, '').slice(2, 12);
const fe = proveedorFE();
const pesos = (n) => Number(n).toLocaleString('es-CO', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

const pruebas = CASOS.map(([nombre, documento, salario, mes, contrato, ingreso, titulo, nov], i) => {
  const n = i + 1;
  const [primerNombre, ...resto] = nombre.split(' ');
  // Los dos últimos son los apellidos; lo que queda entre medias, el segundo nombre.
  const segundoApellido = resto.pop();
  const primerApellido = resto.pop();
  const { integral, ...novedades } = nov;
  const liquidacion = liquidar({ salario, periodo: { anio: 2026, mes }, salarioIntegral: Boolean(integral), novedades });
  const transferencia = n % 2 === 0; // la mitad por transferencia, la otra mitad en efectivo
  const datos = {
    referenceCode: `ORB-NOM-PRUEBA-${String(n).padStart(2, '0')}-${sello}`,
    observacion: `Prueba ${n}: ${titulo}`,
    rangoId: opcion('rango'),
    periodo: { anio: 2026, mes },
    pago: transferencia
      ? { metodoCodigo: '47', banco: 'Bancolombia', tipoCuenta: '2', numeroCuenta: `8520000${String(n).padStart(4, '0')}`, fecha: fecha(mes, mes === 2 ? 27 : 30) }
      : { metodoCodigo: '10', fecha: fecha(mes, mes === 2 ? 27 : 30) },
    trabajador: {
      numeroDocumento: documento, primerNombre, otrosNombres: resto.join(' ') || undefined, primerApellido, segundoApellido,
      direccion: `Carrera ${20 + n} No. ${10 + n}-${30 + n}`, municipioDane: '52001',
      salarioIntegral: Boolean(integral), tipoContratoCodigo: String(contrato), codigoEmpleado: String(n).padStart(3, '0'),
      salario, fechaIngreso: ingreso,
    },
    liquidacion,
  };
  return { n, titulo, nombre, salario, mes, datos, cuerpo: fe.cuerpoNomina(datos) };
});

// ── Revisión local: lo que se va a enviar tiene que cuadrar consigo mismo.
let fallos = 0;
const suma = (o) => Object.values(o).flatMap((v) => (Array.isArray(v) ? v : [v])).reduce((s, x) => s + Number(x.amount ?? 0), 0);
for (const p of pruebas) {
  const { totales, diasTrabajados } = p.datos.liquidacion;
  const problemas = [];
  if (Math.abs(suma(p.cuerpo.accruals) - totales.devengado) > 0.005) problemas.push(`devengados ${suma(p.cuerpo.accruals)} ≠ ${totales.devengado}`);
  if (Math.abs(suma(p.cuerpo.deductions) - totales.deducido) > 0.005) problemas.push(`deducciones ${suma(p.cuerpo.deductions)} ≠ ${totales.deducido}`);
  if (!(totales.neto > 0)) problemas.push('neto no positivo');
  if (p.salario >= 4 * SMMLV && !p.cuerpo.deductions.dedu) problemas.push('falta el fondo de solidaridad');
  if (diasTrabajados < 0 || diasTrabajados > 30) problemas.push(`días ${diasTrabajados}`);
  p.problemas = problemas;
  fallos += problemas.length;
}
const cobertura = {
  'salarios distintos': new Set(pruebas.map((p) => p.salario)).size,
  'colaboradores distintos': new Set(pruebas.map((p) => p.datos.trabajador.numeroDocumento)).size,
  'meses distintos': new Set(pruebas.map((p) => p.mes)).size,
  'con prima': pruebas.filter((p) => p.cuerpo.accruals.prim).length,
  'con cesantías': pruebas.filter((p) => p.cuerpo.accruals.cesa).length,
  'con vacaciones': pruebas.filter((p) => p.cuerpo.accruals.vaca).length,
  'con licencia': pruebas.filter((p) => p.cuerpo.accruals.lice).length,
  'con horas extra o recargos': pruebas.filter((p) => p.cuerpo.accruals.hora).length,
};

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '2-pruebas', 'nomina', `sandbox-${sello}`);
fs.mkdirSync(DIR, { recursive: true });
const elegidas = pruebas.filter((p) => !SOLO || p.n === SOLO);

console.log(`Nómina · ${env.factusNomina.url || '(sin URL)'} · usuario ${env.factusNomina.username || '(sin usuario)'}${env.factusNomina.propias ? '' : ' (credenciales de FACTURACIÓN, no propias de nómina)'}\n`);
for (const p of elegidas) {
  const t = p.datos.liquidacion.totales;
  console.log(`${String(p.n).padStart(2)}. ${p.titulo}\n    ${p.nombre} · mes ${p.mes} · salario ${pesos(p.salario)} · ${p.datos.liquidacion.diasTrabajados} días · devengado ${pesos(t.devengado)} · deducido ${pesos(t.deducido)} · neto ${pesos(t.neto)}${p.problemas.length ? `\n    ✗ ${p.problemas.join('; ')}` : ''}`);
  fs.writeFileSync(path.join(DIR, `${String(p.n).padStart(2, '0')}-cuerpo.json`), JSON.stringify(p.cuerpo, null, 2));
}
console.log(`\nCobertura: ${Object.entries(cobertura).map(([k, v]) => `${v} ${k}`).join(' · ')}`);
if (fallos) { console.error(`\n✗ ${fallos} problema(s) en la revisión local: no se envía nada.`); process.exit(1); }

if (!ENVIAR) {
  console.log(`\nSIMULACIÓN: no se envió nada. Los cuerpos quedaron en ${DIR}\nPara enviar: --enviar --solo=1 (una sola, para probar el formato) y luego --enviar.`);
  process.exit(0);
}

// ── Envío
if (!env.factusNomina.url.includes('sandbox')) { console.error(`\n✗ ${env.factusNomina.url} no es el ambiente de pruebas: este script no emite nóminas reales.`); process.exit(1); }
if (!env.factusNomina.propias && !args.includes('--con-credenciales-de-facturacion')) {
  console.error('\n✗ Faltan en .env las credenciales de pruebas propias del NIT (FACTUS_NOMINA_CLIENT_ID, FACTUS_NOMINA_CLIENT_SECRET,\n  FACTUS_NOMINA_USERNAME, FACTUS_NOMINA_PASSWORD). Con las de facturación las pruebas no quedan a nombre de JD&D.');
  process.exit(1);
}
const rangos = await fe.listarRangosNomina();
console.log(`\nRangos de nómina: ${rangos.filter((r) => r.activo).map((r) => `${r.prefijo}${r.esNotaAjuste ? ' (nota de ajuste)' : ''} sig. ${r.actual} [${r.proveedorId}]`).join(' · ') || '(ninguno)'}`);
const rango = opcion('rango') ?? (() => {
  const deNomina = rangos.filter((r) => r.activo && !r.esNotaAjuste);
  return deNomina.length === 1 ? null : deNomina[0]?.proveedorId; // con uno solo el proveedor lo elige
})();

const resultados = [];
for (const p of elegidas) {
  const datos = { ...p.datos, rangoId: rango ?? undefined };
  try {
    const r = await fe.emitirNominaElectronica(datos);
    fs.writeFileSync(path.join(DIR, `${String(p.n).padStart(2, '0')}-respuesta.json`), JSON.stringify(r.respuestaCruda, null, 2));
    const avisos = [...r.eventos.rechazos, ...r.eventos.avisos].map(([k, v]) => `${k}: ${v}`);
    console.log(`${r.validado ? '✓' : '✗'} ${String(p.n).padStart(2)}. ${r.numeroDocumento ?? 'sin número'} · ${r.validado ? `VALIDADA · CUNE ${String(r.cufe).slice(0, 16)}…` : 'NO validada'}${avisos.length ? `\n     ${avisos.join('\n     ')}` : ''}`);
    resultados.push({ n: p.n, titulo: p.titulo, referencia: datos.referenceCode, numero: r.numeroDocumento, validada: r.validado, cune: r.cufe, avisos });
  } catch (err) {
    fs.writeFileSync(path.join(DIR, `${String(p.n).padStart(2, '0')}-error.json`), JSON.stringify({ status: err.status, mensaje: err.message, detalle: err.detalle }, null, 2));
    console.log(`✗ ${String(p.n).padStart(2)}. HTTP ${err.status ?? '—'} · ${err.message}\n     ${JSON.stringify(err.detalle ?? {}).slice(0, 600)}`);
    resultados.push({ n: p.n, titulo: p.titulo, referencia: datos.referenceCode, validada: false, error: err.message, detalle: err.detalle });
    // Un rechazo de formato se repetiría en todas: se para para corregir antes de gastar más intentos.
    if (!SOLO && resultados.filter((x) => x.validada).length === 0) { console.log('\nLa primera falló: se detiene para corregir el formato.'); break; }
  }
}
fs.writeFileSync(path.join(DIR, 'resumen.json'), JSON.stringify(resultados, null, 2));
const ok = resultados.filter((x) => x.validada).length;
console.log(`\n${ok} de ${resultados.length} validadas. Detalle en ${DIR}`);
process.exit(ok === resultados.length ? 0 : 1);
