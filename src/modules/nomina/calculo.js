/**
 * A5-01 · Liquidación de la nómina de UN trabajador en UN periodo mensual.
 *
 * Puro (sin base de datos ni red): recibe el salario y las novedades del mes y devuelve
 * los devengados, las deducciones y el neto. Es lo que después se emite como nómina
 * electrónica (`payload.js`) y lo que mostrará la pantalla antes de emitir.
 *
 * ⚠️ TODAS LAS FÓRMULAS DE ESTE ARCHIVO LAS DEBE VALIDAR LA CONTADORA (plan, A5-01).
 * Están aquí juntas, con la norma al lado, para que se revisen en un solo sitio. Lo que
 * está marcado con ❓ es una interpretación nuestra que no se ha confirmado con ella.
 *
 * Importes en pesos con dos decimales; se redondea cada concepto (no solo el total)
 * porque el documento electrónico informa concepto por concepto y la DIAN suma esos.
 */

/** Cifras del año. Se cambian cada enero con el decreto del salario mínimo. */
export const PARAMETROS = {
  2026: {
    // Decretos de diciembre de 2025. El auxilio coincide con el del ejemplo oficial
    // del proveedor tecnológico (249.095). ❓ Confirmar ambas cifras con la contadora.
    smmlv: 1_750_905,
    auxilioTransporte: 249_095,
  },
};

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const iso = (anio, mes, dia) => `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;

export function parametrosDe(anio) {
  const p = PARAMETROS[anio];
  if (!p) throw new Error(`No hay parámetros de nómina (salario mínimo, auxilio de transporte) para ${anio}.`);
  return p;
}

/**
 * Horas de la jornada mensual, el divisor del valor de la hora ordinaria.
 * Ley 2101 de 2021: la jornada semanal baja por etapas; 44 h desde el 15-jul-2025 y
 * 42 h desde el 15-jul-2026. Mensual = semanal × 5 (30 días / 6 días de trabajo).
 * ❓ La contadora confirma si JD&D liquida con 220/210 o con otra jornada pactada.
 */
export function horasMes(anio, mes) {
  return iso(anio, mes, 15) >= '2026-07-15' ? 210 : 220;
}

/**
 * Horas extra y recargos. `codigo` es el de la tabla de la nómina electrónica y
 * `porcentaje` el que esa tabla fija para cada tipo (el documento se valida con él).
 *
 *  - HORA EXTRA: se paga la hora completa más el recargo → factor 1 + porcentaje.
 *  - RECARGO (nocturno o dominical en jornada ordinaria): la hora ya va en el sueldo;
 *    se paga SOLO el recargo → factor = porcentaje.
 *
 * CST art. 168 y 179. ❓ La Ley 2466 de 2025 sube por etapas el recargo dominical
 * (80 % desde jul-2025, 90 % desde jul-2026, 100 % desde jul-2027); la tabla de la nómina
 * electrónica sigue en 75 %. Hasta que la contadora diga cómo lo reporta, se liquida con
 * el porcentaje de la tabla.
 */
export const TIPOS_HORA = {
  HED: { codigo: 1, nombre: 'Hora extra diurna', porcentaje: 25, extra: true },
  HEN: { codigo: 2, nombre: 'Hora extra nocturna', porcentaje: 75, extra: true },
  HRN: { codigo: 3, nombre: 'Recargo nocturno', porcentaje: 35, extra: false },
  HEDDF: { codigo: 4, nombre: 'Hora extra diurna dominical o festiva', porcentaje: 100, extra: true },
  HRDDF: { codigo: 5, nombre: 'Recargo diurno dominical o festivo', porcentaje: 75, extra: false },
  HENDF: { codigo: 6, nombre: 'Hora extra nocturna dominical o festiva', porcentaje: 150, extra: true },
  HRNDF: { codigo: 7, nombre: 'Recargo nocturno dominical o festivo', porcentaje: 110, extra: false },
};

/** Licencias (tabla de la nómina electrónica). Las dos primeras se pagan; la tercera no. */
export const TIPOS_LICENCIA = {
  MATERNIDAD: { codigo: 1, nombre: 'Licencia de maternidad o paternidad', remunerada: true },
  REMUNERADA: { codigo: 2, nombre: 'Licencia remunerada', remunerada: true },
  NO_REMUNERADA: { codigo: 3, nombre: 'Licencia no remunerada', remunerada: false },
};

/**
 * Otros pagos al trabajador (8-oct-2026). `salarial` decide si entran a la base de
 * cotización de salud y pensión. `concepto` y `codigo` son los de la nómina electrónica.
 * ❓ Ley 1393 de 2010, art. 30: si lo NO salarial pasa del 40 % de la remuneración total,
 * el exceso también cotiza. Aquí no se aplica ese tope: lo revisa la contadora.
 */
export const OTROS_DEVENGADOS = {
  BONIFICACION_NO_SALARIAL: { nombre: 'Bonificación no salarial', salarial: false, concepto: 'boni', codigo: 2 },
  AUXILIO_SALARIAL: { nombre: 'Auxilio salarial', salarial: true, concepto: 'auxi', codigo: 1 },
  AUXILIO_NO_SALARIAL: { nombre: 'Auxilio no salarial', salarial: false, concepto: 'auxi', codigo: 2 },
  VIATICO_SALARIAL: { nombre: 'Viáticos (manutención y alojamiento, salariales)', salarial: true, concepto: 'tra', codigo: 2 },
  VIATICO_NO_SALARIAL: { nombre: 'Viáticos (no salariales)', salarial: false, concepto: 'tra', codigo: 3 },
  OTRO_SALARIAL: { nombre: 'Otro pago salarial', salarial: true, concepto: 'otro', codigo: 1, conDescripcion: true },
  OTRO_NO_SALARIAL: { nombre: 'Otro pago no salarial', salarial: false, concepto: 'otro', codigo: 2, conDescripcion: true },
};

/**
 * Otras deducciones (las autoriza el trabajador o las ordena un juez; no las calcula
 * ORBITA: se escribe el valor). `unica`: el documento electrónico solo admite una fila
 * de ese concepto, así que varias del mismo tipo se suman al emitir.
 */
export const OTRAS_DEDUCCIONES = {
  LIBRANZA: { nombre: 'Libranza', concepto: 'libr', conDescripcion: true },
  RETENCION_FUENTE: { nombre: 'Retención en la fuente', concepto: 'rete', unica: true },
  EMBARGO: { nombre: 'Embargo', concepto: 'emba', unica: true },
  COOPERATIVA: { nombre: 'Aporte a cooperativa', concepto: 'coop', unica: true },
  ANTICIPO: { nombre: 'Anticipo de nómina', concepto: 'anti' },
  DEUDA_EMPRESA: { nombre: 'Deuda con la empresa', concepto: 'deud', unica: true },
  PENSION_VOLUNTARIA: { nombre: 'Pensión voluntaria', concepto: 'pevo', unica: true },
  AFC: { nombre: 'Ahorro AFC', concepto: 'afco', unica: true },
  OTRA: { nombre: 'Otra deducción', concepto: 'otra' },
};

/**
 * Fondo de solidaridad pensional (Ley 797 de 2003, art. 7): lo paga el trabajador cuando
 * su ingreso base es de 4 salarios mínimos o más. 1 % hasta 16 SMMLV y sube por tramos.
 * La mitad va a solidaridad y la mitad a subsistencia; los puntos adicionales, a subsistencia.
 */
export function porcentajeFondoSolidaridad(ibc, smmlv) {
  const veces = ibc / smmlv;
  if (veces < 4) return 0;
  if (veces < 16) return 1;
  if (veces < 17) return 1.2;
  if (veces < 18) return 1.4;
  if (veces < 19) return 1.6;
  if (veces < 20) return 1.8;
  return 2;
}

/**
 * @param {object} e
 * @param {number} e.salario            salario básico mensual
 * @param {{anio:number, mes:number}} e.periodo
 * @param {boolean} [e.salarioIntegral] el integral no tiene auxilio, prima ni cesantías, y cotiza sobre el 70 %
 * @param {object} [e.novedades]
 * @param {{tipo:string, cantidad:number, inicio?:string, fin?:string}[]} [e.novedades.horas]  tipo: clave de TIPOS_HORA
 * @param {{dias:number, compensadas?:boolean, inicio?:string, fin?:string}[]} [e.novedades.vacaciones]
 * @param {{tipo:string, dias:number, inicio?:string, fin?:string}[]} [e.novedades.licencias]   tipo: clave de TIPOS_LICENCIA
 * @param {{dias:number, inicio?:string, fin?:string}[]} [e.novedades.incapacidades]            enfermedad común
 * @param {number} [e.novedades.comisiones]
 * @param {number} [e.novedades.bonificacion]       bonificación salarial
 * @param {{dias:number}} [e.novedades.prima]       días del semestre que se pagan (180 = semestre completo)
 * @param {{dias:number}} [e.novedades.cesantias]   días del año que se liquidan (360 = año completo); paga también los intereses
 * @param {{tipo:string, valor:number, descripcion?:string}[]} [e.novedades.otrosDevengados]   tipo: clave de OTROS_DEVENGADOS
 * @param {{tipo:string, valor:number, descripcion?:string}[]} [e.novedades.otrasDeducciones]  tipo: clave de OTRAS_DEDUCCIONES
 */
export function liquidar({ salario, periodo, salarioIntegral = false, novedades = {} }) {
  const { smmlv, auxilioTransporte } = parametrosDe(periodo.anio);
  const sal = Number(salario);
  if (!(sal > 0)) throw new Error('El salario debe ser mayor que cero.');
  const dia = sal / 30; // el mes laboral tiene 30 días, también febrero y los de 31
  const hora = sal / horasMes(periodo.anio, periodo.mes);

  // ── Días: los de vacaciones disfrutadas, licencia e incapacidad no son días laborados.
  const vacaciones = (novedades.vacaciones ?? []).filter((v) => v.dias > 0);
  const licencias = (novedades.licencias ?? []).filter((l) => l.dias > 0);
  const incapacidades = (novedades.incapacidades ?? []).filter((i) => i.dias > 0);
  const diasAusente = vacaciones.filter((v) => !v.compensadas).reduce((s, v) => s + v.dias, 0)
    + licencias.reduce((s, l) => s + l.dias, 0)
    + incapacidades.reduce((s, i) => s + i.dias, 0);
  if (diasAusente > 30) throw new Error('Las novedades suman más de 30 días en el mes.');
  const diasTrabajados = 30 - diasAusente;

  // ── Devengados
  const sueldo = r2(dia * diasTrabajados);

  const horas = (novedades.horas ?? []).filter((h) => h.cantidad > 0).map((h) => {
    const t = TIPOS_HORA[h.tipo];
    if (!t) throw new Error(`Tipo de hora extra o recargo desconocido: ${h.tipo}.`);
    const factor = (t.extra ? 1 : 0) + t.porcentaje / 100;
    return { tipo: h.tipo, codigo: t.codigo, cantidad: h.cantidad, porcentaje: t.porcentaje, valor: r2(hora * h.cantidad * factor), inicio: h.inicio ?? null, fin: h.fin ?? null };
  });

  // Vacaciones (CST art. 186 y 192): 15 días hábiles por año; se pagan con el salario
  // ordinario, sin horas extra. Las compensadas en dinero (art. 189) se pagan igual y
  // no restan días laborados.
  const vacacionesLiq = vacaciones.map((v) => ({
    codigo: v.compensadas ? 2 : 1, dias: v.dias, valor: r2(dia * v.dias), inicio: v.inicio ?? null, fin: v.fin ?? null,
  }));

  const licenciasLiq = licencias.map((l) => {
    const t = TIPOS_LICENCIA[l.tipo];
    if (!t) throw new Error(`Tipo de licencia desconocido: ${l.tipo}.`);
    return { tipo: l.tipo, codigo: t.codigo, dias: l.dias, valor: t.remunerada ? r2(dia * l.dias) : 0, inicio: l.inicio ?? null, fin: l.fin ?? null };
  });

  // Incapacidad por enfermedad común (Ley 100, D. 1406/1999 y D. 2943/2013): 66,67 % del
  // salario, sin bajar del mínimo diario (sentencia C-543 de 2007). Los dos primeros días
  // los paga el empleador y del tercero en adelante la EPS: al trabajador le llega igual.
  const incapacidadesLiq = incapacidades.map((i) => ({
    codigo: 1, dias: i.dias, valor: r2(Math.max(dia * 2 / 3, smmlv / 30) * i.dias), inicio: i.inicio ?? null, fin: i.fin ?? null,
  }));

  const comisiones = r2(novedades.comisiones ?? 0);
  const bonificacion = r2(novedades.bonificacion ?? 0);
  const otros = (novedades.otrosDevengados ?? []).filter((o) => o.valor > 0).map((o) => {
    const t = OTROS_DEVENGADOS[o.tipo];
    if (!t) throw new Error(`Tipo de pago desconocido: ${o.tipo}.`);
    return { tipo: o.tipo, valor: r2(o.valor), descripcion: o.descripcion ?? null, salarial: t.salarial };
  });
  const otrosSalariales = otros.filter((o) => o.salarial).reduce((s, o) => s + o.valor, 0);
  const otrosNoSalariales = otros.filter((o) => !o.salarial).reduce((s, o) => s + o.valor, 0);

  // Auxilio de transporte (Ley 15 de 1959): para quien gana hasta 2 salarios mínimos,
  // proporcional a los días efectivamente laborados. No es salario para la seguridad
  // social, pero SÍ es base de la prima y las cesantías (Ley 1 de 1963, art. 7).
  const conAuxilio = !salarioIntegral && sal <= 2 * smmlv;
  const auxilio = conAuxilio ? r2(auxilioTransporte / 30 * diasTrabajados) : 0;
  const basePrestaciones = sal + (conAuxilio ? auxilioTransporte : 0);

  // Prima de servicios (CST art. 306): un mes de salario por año, mitad en junio y mitad
  // en diciembre → base × días del semestre / 360.
  const prima = !salarioIntegral && novedades.prima?.dias > 0
    ? { dias: novedades.prima.dias, valor: r2(basePrestaciones * novedades.prima.dias / 360) }
    : null;

  // Cesantías (CST art. 249): un mes de salario por año → base × días / 360.
  // Intereses (Ley 52 de 1975): 12 % anual sobre las cesantías → cesantías × días × 0,12 / 360.
  let cesantias = null;
  if (!salarioIntegral && novedades.cesantias?.dias > 0) {
    const d = novedades.cesantias.dias;
    const valor = r2(basePrestaciones * d / 360);
    cesantias = { dias: d, valor, intereses: r2(valor * d * 0.12 / 360), porcentajeIntereses: r2(d * 12 / 360) };
  }

  // ── Ingreso base de cotización (Ley 100, art. 18; Ley 1393 de 2010, art. 30): lo que
  // es salario. No entran el auxilio de transporte ni las prestaciones sociales. Las
  // vacaciones disfrutadas y las licencias remuneradas sí cotizan; las vacaciones
  // COMPENSADAS en dinero no (no remuneran trabajo ni descanso: solo cuentan para
  // parafiscales). ❓ La incapacidad cotiza sobre lo pagado (así se deja). Mínimo 1 SMMLV
  // proporcional a los días; máximo 25 SMMLV. El salario integral cotiza sobre el 70 %.
  const compensadas = vacacionesLiq.filter((v) => v.codigo === 2).reduce((s, v) => s + v.valor, 0);
  const salarial = sueldo + horas.reduce((s, h) => s + h.valor, 0) + comisiones + bonificacion + otrosSalariales
    + vacacionesLiq.reduce((s, v) => s + v.valor, 0)
    + licenciasLiq.reduce((s, l) => s + l.valor, 0)
    + incapacidadesLiq.reduce((s, i) => s + i.valor, 0);
  const diasCotizados = 30 - licencias.filter((l) => !TIPOS_LICENCIA[l.tipo].remunerada).reduce((s, l) => s + l.dias, 0);
  const baseCotizacion = salarial - compensadas;
  const ibc = r2(Math.min(Math.max(salarioIntegral ? baseCotizacion * 0.7 : baseCotizacion, smmlv / 30 * diasCotizados), 25 * smmlv));

  // ── Deducciones del trabajador (Ley 100, art. 204 y 20): salud 4 % y pensión 4 %.
  const pctFsp = porcentajeFondoSolidaridad(ibc, smmlv);
  const deducciones = {
    salud: { porcentaje: 4, valor: r2(ibc * 0.04) },
    pension: { porcentaje: 4, valor: r2(ibc * 0.04) },
    fondoSolidaridad: pctFsp ? { porcentaje: pctFsp, valor: r2(ibc * pctFsp / 100) } : null,
    otras: (novedades.otrasDeducciones ?? []).filter((o) => o.valor > 0).map((o) => {
      if (!OTRAS_DEDUCCIONES[o.tipo]) throw new Error(`Tipo de deducción desconocido: ${o.tipo}.`);
      return { tipo: o.tipo, valor: r2(o.valor), descripcion: o.descripcion ?? null };
    }),
  };

  const devengados = {
    sueldo, auxilioTransporte: auxilio, horas, comisiones, bonificacion,
    vacaciones: vacacionesLiq, licencias: licenciasLiq, incapacidades: incapacidadesLiq, prima, cesantias, otros,
  };
  const totalDevengado = r2(salarial + otrosNoSalariales + auxilio + (prima?.valor ?? 0) + (cesantias ? cesantias.valor + cesantias.intereses : 0));
  const totalDeducido = r2(deducciones.salud.valor + deducciones.pension.valor + (deducciones.fondoSolidaridad?.valor ?? 0)
    + deducciones.otras.reduce((s, o) => s + o.valor, 0));
  // No se puede pagar un neto negativo: las deducciones se reparten en varios meses.
  if (totalDeducido > totalDevengado) throw new Error('Las deducciones superan lo devengado: el neto a pagar no puede ser negativo.');

  return {
    diasTrabajados, ibc, devengados, deducciones,
    totales: { devengado: totalDevengado, deducido: totalDeducido, neto: r2(totalDevengado - totalDeducido) },
  };
}
