// 8-oct-2026 · EXPLORACIÓN del API de nómina en el ambiente de pruebas: casos raros y
// casos mal armados A PROPÓSITO, para saber qué acepta el proveedor, qué rechaza y con qué
// mensaje, antes de construir el módulo. No comprueba nuestras fórmulas: parte de una
// nómina sana y le cambia una cosa cada vez.
//
//   node --import tsx scripts/nomina-exploracion-sandbox.mjs            → lista los casos, no envía
//   node --import tsx scripts/nomina-exploracion-sandbox.mjs --enviar   → los envía todos
//   opciones: --solo=<n>[,<n>…]   --desde=<n>
//
// Solo ambiente de pruebas y con las credenciales propias del NIT. Trabajadores inventados.
// Lo que queda creado sin validar se elimina (o se reenvía) para no bloquear el siguiente.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../src/config/env.js';
import { request } from '../src/modules/facturacion/adaptadores/factus.cliente.js';
import { proveedorFE } from '../src/modules/facturacion/index.js';
import { liquidar } from '../src/modules/nomina/calculo.js';

const args = process.argv.slice(2);
const opcion = (n) => args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const ENVIAR = args.includes('--enviar');
const SOLO = opcion('solo')?.split(',').map(Number) ?? null;
const DESDE = Number(opcion('desde') ?? 1);
const P = { perfil: 'nomina' };
const sello = new Date().toISOString().replace(/\D/g, '').slice(2, 12);
const fe = proveedorFE();
const $ = (n) => Number(n).toFixed(2);

/** Nómina sana de partida: salario 2.400.000, mes completo, transferencia. */
function base(n, { salario = 2_400_000, mes = 3, anio = 2026 } = {}) {
  return fe.cuerpoNomina({
    referenceCode: `ORB-NOM-EXP-${String(n).padStart(2, '0')}-${sello}`,
    periodo: { anio, mes },
    pago: { metodoCodigo: '47', banco: 'Banco de Bogotá', tipoCuenta: '2', numeroCuenta: `4410000${String(n).padStart(4, '0')}`, fecha: `${anio}-${String(mes).padStart(2, '0')}-28` },
    trabajador: {
      numeroDocumento: `10853020${String(n).padStart(2, '0')}`, primerNombre: 'Prueba', otrosNombres: `Caso${n}`, primerApellido: 'Exploración', segundoApellido: 'Nómina',
      direccion: `Calle ${n} No. 10-20`, municipioDane: '52001', tipoContratoCodigo: '2', codigoEmpleado: `E${n}`, salario, fechaIngreso: '2022-01-10',
    },
    liquidacion: liquidar({ salario, periodo: { anio: 2026, mes } }),
  });
}

// [título, qué se espera aprender, (cuerpo, n) => cuerpo modificado, opciones de base]
const CASOS = [
  // ── Periodo
  ['Quincenal, primera quincena (pay_period_half 1, entero)', '¿qué valores admite pay_period_half?', (c) => { c.settlement_period.payroll_period_code = '4'; c.settlement_period.pay_period_half = 1; c.worker.days_worked = '15.00'; c.accruals.suel.amount = $(1_200_000); c.deductions.salu.amount = $(48_000); c.deductions.pens.amount = $(48_000); delete c.accruals.tra; }],
  ['Quincenal, segunda quincena (pay_period_half 2, entero)', '', (c) => { c.settlement_period.payroll_period_code = '4'; c.settlement_period.pay_period_half = 2; c.worker.days_worked = '15.00'; c.accruals.suel.amount = $(1_200_000); c.deductions.salu.amount = $(48_000); c.deductions.pens.amount = $(48_000); delete c.accruals.tra; }],
  ['Quincenal SIN decir cuál quincena', 'mensaje de validación', (c) => { c.settlement_period.payroll_period_code = '4'; }],
  ['Periodo de un año anterior (diciembre de 2025)', '¿deja emitir nóminas atrasadas?', (c) => { c.settlement_period.year = '2025'; c.settlement_period.month = '12'; c.payment.payment_date = '2025-12-30'; }],
  ['Periodo futuro (noviembre de 2026)', '¿deja emitir por adelantado?', (c) => { c.settlement_period.month = '11'; c.payment.payment_date = '2026-11-30'; }],
  ['Fecha de pago en otro mes que el periodo', '', (c) => { c.payment.payment_date = '2026-04-05'; }],
  // ── Trabajador
  ['Ingresó a mitad de mes (16 días)', '', (c) => { c.worker.entry_date = '2026-03-15'; c.worker.days_worked = '16.00'; c.accruals.suel.amount = $(1_280_000); c.accruals.tra[0].amount = $(132_850.67); c.deductions.salu.amount = $(51_200); c.deductions.pens.amount = $(51_200); }],
  ['Retiro en el mes: liquidación final', 'retirement_date, cesantías, prima, vacaciones compensadas e indemnización juntas', (c) => { c.worker.retirement_date = '2026-03-20'; c.worker.days_worked = '20.00'; c.accruals.suel.amount = $(1_600_000); c.accruals.tra[0].amount = $(166_063.33); c.accruals.cesa = [{ amount: $(588_688), accrual_type_code: 1 }, { amount: $(15_698), percentage: '2.67', accrual_type_code: 2 }]; c.accruals.prim = { quantity: 80, amount: $(588_688), accrual_type_code: 1 }; c.accruals.vaca = [{ quantity: 8, amount: $(640_000), accrual_type_code: 2 }]; c.accruals.inde = { amount: $(2_400_000) }; c.deductions.salu.amount = $(64_000); c.deductions.pens.amount = $(64_000); }],
  ['Aprendiz SENA en etapa lectiva (apoyo de sostenimiento)', 'sueldo en cero y sin aportes', (c) => { c.worker.worker_type_code = '12'; c.worker.contract_type = '4'; c.worker.salary = $(1_313_179); c.accruals = { suel: { amount: '0.00' }, apoy: { amount: $(1_313_179) } }; c.deductions.salu = { amount: '0.00', percentage: '0.00' }; c.deductions.pens = { amount: '0.00', percentage: '0.00' }; }],
  ['Aprendiz SENA en etapa productiva', '', (c) => { c.worker.worker_type_code = '19'; c.worker.contract_type = '4'; c.worker.salary = $(1_750_905); c.accruals = { suel: { amount: '0.00' }, apoy: { amount: $(1_750_905) } }; c.deductions.salu = { amount: '0.00', percentage: '0.00' }; c.deductions.pens = { amount: '0.00', percentage: '0.00' }; }],
  ['Pensionado activo (subtipo 01), sin aporte a pensión', '', (c) => { c.worker.worker_subtype = '01'; c.deductions.pens = { amount: '0.00', percentage: '0.00' }; }],
  ['Tiempo parcial (tipo 51), 12 días', '', (c) => { c.worker.worker_type_code = '51'; c.worker.days_worked = '12.00'; c.accruals.suel.amount = $(960_000); c.accruals.tra[0].amount = $(99_638); c.deductions.salu.amount = $(38_400); c.deductions.pens.amount = $(38_400); }],
  ['Extranjero con cédula de extranjería (22)', '', (c) => { c.worker.identification_document_code = '22'; c.worker.identification_number = '725431'; }],
  ['Pasaporte (41) con letras en el número', '', (c) => { c.worker.identification_document_code = '41'; c.worker.identification_number = 'AX458712'; }],
  ['Actividad de alto riesgo', '', (c) => { c.worker.has_high_risk = true; }],
  ['Persona con UN solo apellido (sin second_surname)', 'la doc lo marca obligatorio: ¿de verdad?', (c) => { delete c.worker.second_surname; }],
  ['Nombres con ñ, tildes y apóstrofo', '', (c) => { c.worker.first_name = 'Íñigo'; c.worker.other_names = 'José María'; c.worker.first_surname = "D'Áñez"; c.worker.second_surname = 'Muñoz-Peña'; }],
  ['Municipio que no existe', 'mensaje de validación', (c) => { c.worker.municipality_code = '99999'; }],
  ['Contrato por obra o labor (3) y de prácticas (5)', '', (c) => { c.worker.contract_type = '3'; }],
  // ── Devengados
  ['Incapacidad profesional (2) y laboral (3)', '', (c) => { c.worker.days_worked = '24.00'; c.accruals.suel.amount = $(1_920_000); c.accruals.tra[0].amount = $(199_276); c.accruals.inca = [{ quantity: 3, amount: $(240_000), start_date: '2026-03-03', end_date: '2026-03-05', accrual_type_code: 2 }, { quantity: 3, amount: $(240_000), start_date: '2026-03-10', end_date: '2026-03-12', accrual_type_code: 3 }]; }],
  ['Vacaciones todo el mes (0 días laborados)', '¿admite days_worked y sueldo en cero?', (c) => { c.worker.days_worked = '0.00'; c.accruals = { suel: { amount: '0.00' }, vaca: [{ quantity: 30, amount: $(2_400_000), start_date: '2026-03-01', end_date: '2026-03-30', accrual_type_code: 1 }] }; }],
  ['Licencia de maternidad todo el mes', '', (c) => { c.worker.days_worked = '0.00'; c.accruals = { suel: { amount: '0.00' }, lice: [{ quantity: 30, amount: $(2_400_000), start_date: '2026-03-01', end_date: '2026-03-30', accrual_type_code: 1 }] }; }],
  ['Pagos no salariales: bonificación, auxilios, bonos y otros', '', (c) => { c.accruals.boni = [{ amount: $(200_000), accrual_type_code: 2 }]; c.accruals.auxi = [{ amount: $(150_000), accrual_type_code: 1 }, { amount: $(100_000), accrual_type_code: 2 }]; c.accruals.bono = [{ amount: $(50_000), accrual_type_code: 1 }, { amount: $(50_000), accrual_type_code: 2 }, { amount: $(80_000), accrual_type_code: 3 }, { amount: $(80_000), accrual_type_code: 4 }]; c.accruals.otro = [{ amount: $(60_000), description: 'Auxilio de conectividad', accrual_type_code: 2 }, { amount: $(40_000), description: 'Prima extralegal', accrual_type_code: 1 }]; c.accruals.comp = [{ amount: $(30_000), accrual_type_code: 1 }, { amount: $(30_000), accrual_type_code: 2 }]; }],
  ['Viáticos, dotación, teletrabajo, reintegro, anticipo y pago a terceros', '', (c) => { c.accruals.tra.push({ amount: $(300_000), accrual_type_code: 2 }, { amount: $(120_000), accrual_type_code: 3 }); c.accruals.dota = { amount: $(180_000) }; c.accruals.tele = { amount: $(90_000) }; c.accruals.rein = { amount: $(25_000) }; c.accruals.anti = [{ amount: $(100_000) }]; c.accruals.terc = [{ amount: $(70_000) }]; c.accruals.prim = { amount: $(200_000), accrual_type_code: 2 }; }],
  ['Horas extra con fracción (2,5 horas)', 'la doc dice que la cantidad es entera', (c) => { c.accruals.hora = [{ quantity: '2.5', percentage: '25.00', amount: $(34_090.91), start_date: '2026-03-04 17:00:00', end_date: '2026-03-04 19:30:00', accrual_type_code: '1' }]; }],
  ['Horas extra sin fechas', 'las fechas son opcionales', (c) => { c.accruals.hora = [{ quantity: '4', percentage: '25.00', amount: $(54_545.45), accrual_type_code: '1' }]; }],
  ['Horas extra con la fecha en formato T', 'el otro formato que menciona la doc', (c) => { c.accruals.hora = [{ quantity: '4', percentage: '25.00', amount: $(54_545.45), start_date: '2026-03-04T17:00:00', end_date: '2026-03-04T21:00:00', accrual_type_code: '1' }]; }],
  ['Recargo dominical con el porcentaje de la reforma (80 %) en vez del de la tabla (75 %)', '¿la DIAN valida el porcentaje contra el tipo?', (c) => { c.accruals.hora = [{ quantity: '8', percentage: '80.00', amount: $(69_818.18), start_date: '2026-03-08 08:00:00', end_date: '2026-03-08 16:00:00', accrual_type_code: '5' }]; }],
  ['Huelga legal (2 días)', '', (c) => { c.worker.days_worked = '28.00'; c.accruals.suel.amount = $(2_240_000); c.accruals.huel = [{ quantity: 2, start_date: '2026-03-16', end_date: '2026-03-17' }]; }],
  // ── Deducciones
  ['Libranza, sindicato, sanciones, anticipo y otras', '', (c) => { c.deductions.libr = [{ amount: $(250_000), description: 'Libranza Banco Popular' }]; c.deductions.sind = [{ amount: $(24_000), percentage: '1.00' }]; c.deductions.sanc = [{ amount: $(20_000), deduction_type_code: 1 }, { amount: $(15_000), deduction_type_code: 2 }]; c.deductions.anti = [{ amount: $(100_000) }]; c.deductions.otra = [{ amount: $(30_000) }]; }],
  ['Pensión voluntaria, retención, AFC, cooperativa, embargo, plan, educación, reintegro y deuda', '', (c) => { for (const k of ['pevo', 'rete', 'afco', 'coop', 'emba', 'plan', 'educ', 'rein', 'deud']) c.deductions[k] = { amount: $(50_000) }; }],
  ['Pago a terceros en deducciones, como OBJETO', 'la doc no dice si es objeto o lista', (c) => { c.deductions.terc = { amount: $(40_000) }; }],
  ['Pago a terceros en deducciones, como LISTA', '', (c) => { c.deductions.terc = [{ amount: $(40_000) }]; }],
  ['Deducciones mayores que lo devengado (neto negativo)', '¿lo deja pasar?', (c) => { c.deductions.libr = [{ amount: $(3_500_000), description: 'Libranza' }]; }],
  ['Salario de 4 mínimos o más SIN fondo de solidaridad', 'la doc lo marca obligatorio', (c) => { delete c.deductions.dedu; }, { salario: 9_000_000 }],
  ['Fondo de solidaridad con una sola fila (solo solidaridad)', '', (c) => { c.deductions.dedu = [{ amount: $(90_000), percentage: '1.00', deduction_type_code: 1 }]; }, { salario: 9_000_000 }],
  // ── Pago
  ['Consignación (42) a cuenta corriente (3)', '', (c) => { c.payment.payment_method_code = '42'; c.payment.account_type = '3'; }],
  ['Transferencia SIN banco ni cuenta', 'mensaje de validación', (c) => { delete c.payment.bank_name; delete c.payment.account_type; delete c.payment.account_number; }],
  ['Medio de pago "ZZZ" (el «Otro» de las facturas)', '¿existe en nómina?', (c) => { c.payment = { payment_method_code: 'ZZZ', payment_date: c.payment.payment_date }; }],
  // ── Formato y reglas
  ['Importes sin decimales y como número', '', (c) => { c.worker.salary = 2400000; c.accruals.suel.amount = 2400000; c.deductions.salu.amount = '96000'; c.deductions.pens.amount = '96000'; c.deductions.salu.percentage = 4; c.deductions.pens.percentage = 4; }],
  ['Salario por debajo del mínimo en jornada completa', '¿la DIAN lo rechaza?', (c) => c, { salario: 1_000_000 }],
  ['Salario integral por debajo de 13 mínimos', '', (c) => { c.worker.has_integral_salary = true; delete c.accruals.tra; }],
  ['Aportes a salud y pensión que no son el 4 %', '¿valida el porcentaje o el valor?', (c) => { c.deductions.salu = { amount: $(10_000), percentage: '1.00' }; c.deductions.pens = { amount: $(10_000), percentage: '1.00' }; }],
  ['Sueldo que no corresponde a los días (30 días, medio sueldo)', '¿cruza días con valores?', (c) => { c.accruals.suel.amount = $(1_200_000); }],
  ['Observación de más de 500 caracteres', '', (c) => { c.observation = 'Observación muy larga. '.repeat(40); }],
  // ── Repeticiones (dependen del orden: van al final)
  ['Segunda nómina del MISMO trabajador en el MISMO mes', '¿una por trabajador y periodo?', (c, n, previos) => { c.worker.identification_number = previos.documentoDe(6); c.observation = 'Segunda del mismo trabajador y mes'; }],
  ['Reenviar una referencia que YA quedó validada', '¿devuelve la misma o crea otra?', (c, n, previos) => previos.cuerpoDe(6)],
];

if (!ENVIAR) {
  CASOS.forEach(([t, q], i) => console.log(`${String(i + 1).padStart(2)}. ${t}${q ? `  — ${q}` : ''}`));
  console.log(`\n${CASOS.length} casos. No se envió nada. Para enviar: --enviar`);
  process.exit(0);
}
if (!env.factusNomina.url.includes('sandbox')) { console.error(`✗ ${env.factusNomina.url} no es el ambiente de pruebas.`); process.exit(1); }
if (!env.factusNomina.propias) { console.error('✗ Faltan las credenciales de pruebas propias del NIT (FACTUS_NOMINA_*).'); process.exit(1); }

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '2-pruebas', 'nomina', `exploracion-${sello}`);
fs.mkdirSync(DIR, { recursive: true });
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
const enviados = new Map(); // n → cuerpo enviado
const previos = { documentoDe: (n) => enviados.get(n)?.worker.identification_number ?? base(n).worker.identification_number, cuerpoDe: (n) => structuredClone(enviados.get(n) ?? base(n)) };
const corto = (x) => JSON.stringify(x ?? null).slice(0, 700);

/** Envía y devuelve { resultado, numero, mensajes }. Deja limpio lo que quede sin validar. */
async function probar(cuerpo) {
  for (let intento = 1; intento <= 3; intento++) {
    try {
      const r = await request('POST', '/v2/payrolls', cuerpo, P);
      const d = r.data?.payroll ?? r.data ?? {};
      if (d.is_validated) return { resultado: 'VALIDADA', numero: d.number, mensajes: d.errors ? corto(d.errors) : null, totales: `${d.total_accruals ?? '?'} − ${d.total_deductions ?? '?'} = ${d.net_balance ?? '?'}`, intento };
      // Creada pero la DIAN no la validó: se anota por qué y se elimina para no bloquear.
      let limpieza;
      try { await request('DELETE', `/v2/payrolls/reference/${encodeURIComponent(cuerpo.reference_code)}`, undefined, P); limpieza = 'eliminada'; } catch (e) { limpieza = `no se pudo eliminar (${e.status} ${e.message})`; }
      if (limpieza !== 'eliminada' && intento < 3) { await espera(4000); continue; }
      return { resultado: 'NO VALIDADA POR LA DIAN', numero: d.number, mensajes: corto(d.errors), limpieza, intento };
    } catch (e) {
      const repetir = e.status === 500 || e.status === 0 || (e.status === 409 && /pendiente/i.test(e.message));
      if (repetir && intento < 3) { await espera(4000); continue; }
      // Hallazgo del 8-oct: cuando es la DIAN la que rechaza (reglas NIE…, no un campo mal
      // formado), el proveedor responde con error PERO deja la nómina creada y pendiente, y
      // esa bloquea todas las siguientes con 409. Hay que eliminarla por su referencia.
      if (/errores de validaci/i.test(e.message)) {
        let limpieza = 'eliminada';
        try { await request('DELETE', `/v2/payrolls/reference/${encodeURIComponent(cuerpo.reference_code)}`, undefined, P); } catch (x) { limpieza = `no se pudo eliminar (${x.status} ${x.message})`; }
        return { resultado: 'RECHAZADA POR LA DIAN', mensajes: corto(e.detalle), limpieza, intento };
      }
      return { resultado: e.status === 422 ? 'RECHAZO DE FORMATO' : `HTTP ${e.status}`, mensajes: `${e.message} ${corto(e.detalle)}`, intento };
    }
  }
  return { resultado: 'SIN RESPUESTA' };
}

const resultados = [];
for (const [i, [titulo, pregunta, mutar, opcionesBase]] of CASOS.entries()) {
  const n = i + 1;
  if (SOLO ? !SOLO.includes(n) : n < DESDE) continue;
  let cuerpo = base(n, opcionesBase);
  cuerpo = mutar(cuerpo, n, previos) ?? cuerpo;
  enviados.set(n, structuredClone(cuerpo));
  fs.writeFileSync(path.join(DIR, `${String(n).padStart(2, '0')}-cuerpo.json`), JSON.stringify(cuerpo, null, 2));
  const r = await probar(cuerpo);
  resultados.push({ n, titulo, pregunta, ...r });
  const marca = r.resultado === 'VALIDADA' ? '✓' : r.resultado === 'RECHAZO DE FORMATO' ? '·' : '✗';
  console.log(`${marca} ${String(n).padStart(2)}. ${titulo}\n     ${r.resultado}${r.numero ? ` ${r.numero}` : ''}${r.totales ? ` · ${r.totales}` : ''}${r.intento > 1 ? ` · al intento ${r.intento}` : ''}${r.limpieza ? ` · ${r.limpieza}` : ''}${r.mensajes ? `\n     ${r.mensajes}` : ''}`);
  fs.writeFileSync(path.join(DIR, 'resumen.json'), JSON.stringify(resultados, null, 2));
  // El proveedor habilita un documento a la vez: si apagó la nómina, no tiene sentido seguir.
  if (r.resultado === 'HTTP 403') { console.log('El proveedor ya no deja crear nóminas en este ambiente: se detiene.'); break; }
}
const cuenta = (t) => resultados.filter((x) => x.resultado === t).length;
console.log(`\n${resultados.length} casos · ${cuenta('VALIDADA')} validadas · ${cuenta('RECHAZO DE FORMATO')} rechazos de formato · ${resultados.length - cuenta('VALIDADA') - cuenta('RECHAZO DE FORMATO')} otros. Detalle en ${DIR}`);
process.exit(0);
