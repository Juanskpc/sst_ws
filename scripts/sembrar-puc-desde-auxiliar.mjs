// B0-01 · Siembra en jdd_dev el plan de cuentas que usa hoy JD&D, sacado del
// MOVIMIENTO AUXILIAR de septiembre que exportó Siigo (§3.5 del plan): son las 78
// cuentas con movimiento en el mes. No es el PUC completo — ese llega con Q-22 y se
// carga por la pantalla (Contabilidad → Plan de cuentas → Importar).
//
//   node --import tsx scripts/sembrar-puc-desde-auxiliar.mjs [ruta.xlsx] [--simular]
//
// Por defecto lee ../1-cliente-jdd/contabilidad-siigo/puc.xlsx (fuera de git a propósito:
// trae movimientos reales de la empresa). Solo corre contra jdd_dev.
//
// Los niveles superiores que el auxiliar no trae se crean con el nombre del PUC
// del Decreto 2650 solo cuando es inequívoco (clases, grupos, cuentas y las
// subcuentas estándar de abajo). Donde Siigo usa una numeración propia (4180,
// 7305, 511030…) se deja "(por confirmar)": inventar el nombre sería peor.
import { readFile } from 'node:fs/promises';
import { pool } from '../src/config/db.js';
import { importarCuentas, leerExcelCuentas } from '../src/modules/contabilidad/cuentas.service.js';

if (!/@localhost:5433\/jdd_dev\b/.test(process.env.DATABASE_URL ?? '')) {
  console.error('Este script solo corre contra jdd_dev (túnel en localhost:5433).');
  process.exit(1);
}

const NOMBRES_PUC = {
  1: 'Activo', 2: 'Pasivo', 3: 'Patrimonio', 4: 'Ingresos', 5: 'Gastos', 6: 'Costos de ventas',
  7: 'Costos de producción o de operación',
  11: 'Disponible', 13: 'Deudores', 14: 'Inventarios', 23: 'Cuentas por pagar',
  24: 'Impuestos, gravámenes y tasas', 25: 'Obligaciones laborales', 41: 'Operacionales',
  42: 'No operacionales', 51: 'Operacionales de administración', 53: 'No operacionales',
  73: 'Costos indirectos',
  1105: 'Caja', 1110: 'Bancos', 1305: 'Clientes', 1330: 'Anticipos y avances',
  1355: 'Anticipo de impuestos y contribuciones o saldos a favor', 2335: 'Costos y gastos por pagar',
  2365: 'Retención en la fuente', 2370: 'Retenciones y aportes de nómina', 2380: 'Acreedores varios',
  2408: 'Impuesto sobre las ventas por pagar', 2505: 'Salarios por pagar', 2510: 'Cesantías consolidadas',
  4135: 'Comercio al por mayor y al por menor', 4175: 'Devoluciones en ventas (DB)', 4295: 'Diversos',
  5105: 'Gastos de personal', 5110: 'Honorarios', 5120: 'Arrendamientos', 5135: 'Servicios',
  5140: 'Gastos legales', 5145: 'Mantenimiento y reparaciones', 5195: 'Diversos', 5305: 'Financieros',
  5395: 'Gastos diversos',
  110505: 'Caja general', 111005: 'Moneda nacional', 130505: 'Nacionales', 133005: 'A proveedores',
  135515: 'Retención en la fuente', 135517: 'Impuesto a las ventas retenido',
  135518: 'Impuesto de industria y comercio retenido', 233525: 'Honorarios', 233595: 'Otros',
  236575: 'Autorretenciones', 237005: 'Aportes a entidades promotoras de salud, EPS',
  238030: 'Fondos de cesantías y/o pensiones', 250505: 'Salarios por pagar',
  510506: 'Sueldos', 510527: 'Auxilio de transporte', 510530: 'Cesantías', 510533: 'Intereses sobre cesantías',
  510536: 'Prima de servicios', 510539: 'Vacaciones', 510548: 'Bonificaciones',
  510551: 'Dotación y suministro a trabajadores', 510568: 'Aportes a administradoras de riesgos laborales',
  510570: 'Aportes a fondos de pensiones y/o cesantías', 510572: 'Aportes cajas de compensación familiar',
  512010: 'Construcciones y edificaciones', 513520: 'Procesamiento electrónico de datos',
  513525: 'Acueducto y alcantarillado', 513530: 'Energía eléctrica', 513535: 'Teléfono',
  514010: 'Registro mercantil', 514525: 'Equipo de computación y comunicación',
  519535: 'Combustibles y lubricantes', 519545: 'Taxis y buses', 519560: 'Casino y restaurante',
  519595: 'Otros', 530505: 'Gastos bancarios', 530515: 'Comisiones',
  530535: 'Descuentos comerciales condicionados', 539595: 'Otros',
};

const ruta = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? '../1-cliente-jdd/contabilidad-siigo/puc.xlsx';
const simular = process.argv.includes('--simular');

try {
  const lista = leerExcelCuentas(await readFile(ruta));
  const resumen = await importarCuentas(lista, {
    simular,
    nombresPadres: Object.fromEntries(Object.entries(NOMBRES_PUC).map(([k, v]) => [String(k), v])),
  });

  // Indicadores que se desprenden de cómo contabiliza hoy Siigo (§3.5): la cuenta de
  // clientes lleva la cartera por cobrar, la de honorarios por pagar la de los
  // documentos soporte, la de moneda nacional es el banco, y todo lo que se cruza
  // con un cliente, proveedor o empleado (deudores, cuentas por pagar, impuestos y
  // obligaciones laborales) exige tercero. La contadora los revisa en la pantalla.
  if (!simular) {
    await pool.query(`UPDATE sst.cuentas_contables SET es_cartera = 'CXC' WHERE codigo = '13050501' AND es_cartera IS NULL`);
    await pool.query(`UPDATE sst.cuentas_contables SET es_cartera = 'CXP' WHERE codigo IN ('23352501', '23359501') AND es_cartera IS NULL`);
    await pool.query(`UPDATE sst.cuentas_contables SET es_banco = true WHERE codigo = '11100501'`);
    await pool.query(
      `UPDATE sst.cuentas_contables SET exige_tercero = true
        WHERE acepta_movimiento AND left(codigo, 2) IN ('13', '23', '24', '25') AND NOT exige_tercero`,
    );
  }

  console.log(`${simular ? '[SIMULACIÓN] ' : ''}Cuentas leídas del Excel: ${lista.length}`);
  console.log(`Creadas: ${resumen.creadas} · actualizadas: ${resumen.actualizadas} · sin cambios: ${resumen.sin_cambios} · total del plan: ${resumen.total_plan}`);
  if (resumen.padres_provisionales.length) {
    console.log(`Niveles con nombre "(por confirmar)" (${resumen.padres_provisionales.length}): ${resumen.padres_provisionales.join(', ')}`);
  }
  if (resumen.errores.length) console.log('Filas con error:', resumen.errores);
} catch (e) {
  console.error('No se sembró nada:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
