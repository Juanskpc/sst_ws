import { OTRAS_DEDUCCIONES, OTROS_DEVENGADOS, PARAMETROS, TIPOS_HORA, TIPOS_LICENCIA } from './calculo.js';

/**
 * Tablas de la nómina electrónica que la pantalla necesita para sus selectores. Son las
 * del proveedor tecnológico (developers…/tablas-referencia-nomina, leídas el 8-oct-2026);
 * solo se ofrecen las que aplican a una empresa como JD&D.
 */
export const TIPOS_CONTRATO = [
  { codigo: '2', nombre: 'Término indefinido' },
  { codigo: '1', nombre: 'Término fijo' },
  { codigo: '3', nombre: 'Obra o labor' },
  { codigo: '4', nombre: 'Aprendizaje' },
  { codigo: '5', nombre: 'Prácticas o pasantías' },
];

export const TIPOS_TRABAJADOR = [
  { codigo: '01', nombre: 'Dependiente' },
  { codigo: '51', nombre: 'Trabajador de tiempo parcial' },
  { codigo: '12', nombre: 'Aprendiz del SENA en etapa lectiva' },
  { codigo: '19', nombre: 'Aprendiz del SENA en etapa productiva' },
];

export const SUBTIPOS_TRABAJADOR = [
  { codigo: '00', nombre: 'No aplica' },
  { codigo: '01', nombre: 'Pensionado por vejez activo' },
];

export const METODOS_PAGO = [
  { codigo: '47', nombre: 'Transferencia', conCuenta: true },
  { codigo: '42', nombre: 'Consignación', conCuenta: true },
  { codigo: '10', nombre: 'Efectivo', conCuenta: false },
];

export const TIPOS_CUENTA = [
  { codigo: '2', nombre: 'Ahorros' },
  { codigo: '3', nombre: 'Corriente' },
  { codigo: '1', nombre: 'Nómina' },
];

export function catalogosNomina() {
  return {
    tipos_contrato: TIPOS_CONTRATO,
    tipos_trabajador: TIPOS_TRABAJADOR,
    subtipos_trabajador: SUBTIPOS_TRABAJADOR,
    metodos_pago: METODOS_PAGO,
    tipos_cuenta: TIPOS_CUENTA,
    tipos_hora: Object.entries(TIPOS_HORA).map(([clave, t]) => ({ clave, nombre: t.nombre, porcentaje: t.porcentaje })),
    tipos_licencia: Object.entries(TIPOS_LICENCIA).map(([clave, t]) => ({ clave, nombre: t.nombre, remunerada: t.remunerada })),
    otros_devengados: Object.entries(OTROS_DEVENGADOS).map(([clave, t]) => ({ clave, nombre: t.nombre, salarial: t.salarial, conDescripcion: Boolean(t.conDescripcion) })),
    otras_deducciones: Object.entries(OTRAS_DEDUCCIONES).map(([clave, t]) => ({ clave, nombre: t.nombre, conDescripcion: Boolean(t.conDescripcion) })),
    parametros: Object.entries(PARAMETROS).map(([anio, p]) => ({ anio: Number(anio), smmlv: p.smmlv, auxilio_transporte: p.auxilioTransporte })),
  };
}
