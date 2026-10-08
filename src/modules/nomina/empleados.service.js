import { pool, withTransaction } from '../../config/db.js';
import { badRequest, conflict, notFound } from '../../utils/httpError.js';
import { METODOS_PAGO, SUBTIPOS_TRABAJADOR, TIPOS_CONTRATO, TIPOS_CUENTA, TIPOS_TRABAJADOR } from './catalogos.js';

/**
 * A5-01 · Empleados: la ficha laboral de un tercero.
 *
 * La persona (documento, nombres, dirección, municipio) se mantiene en Terceros; aquí solo
 * va el contrato y cómo se le paga. Al crear la ficha el tercero queda marcado con el rol
 * «Empleado», para que no haya que acordarse de hacerlo en dos pantallas.
 */

const EMPLEADO_SELECT = `
  e.id, e.tercero_id, e.cargo, e.salario, e.salario_integral, e.tipo_contrato, e.tipo_trabajador,
  e.subtipo_trabajador, e.alto_riesgo,
  to_char(e.fecha_ingreso, 'YYYY-MM-DD') AS fecha_ingreso, to_char(e.fecha_retiro, 'YYYY-MM-DD') AS fecha_retiro,
  e.metodo_pago, e.banco, e.tipo_cuenta, e.numero_cuenta,
  e.eps, e.fondo_pension, e.fondo_cesantias, e.arl, e.caja_compensacion, e.activo,
  COALESCE(t.razon_social, btrim(concat_ws(' ', t.nombres, t.apellidos))) AS nombre,
  t.tipo_persona, t.nombres, t.apellidos, t.numero_documento, t.direccion,
  td.codigo_dian AS tipo_documento_codigo, td.nombre AS tipo_documento_nombre,
  m.codigo_dian AS municipio_codigo, m.nombre AS municipio_nombre`;
const EMPLEADO_FROM = `
  FROM sst.empleados e
  JOIN sst.terceros t ON t.id = e.tercero_id
  JOIN sst.tipos_documento_identidad td ON td.id = t.tipo_documento_id
  LEFT JOIN sst.municipios m ON m.id = t.municipio_id`;

/**
 * Qué le falta a la ficha (o a su tercero) para poder emitirle una nómina electrónica.
 * Va en cada empleado para que la pantalla lo avise ANTES de llegar al botón de emitir.
 */
export function faltantesParaNomina(e) {
  const faltan = [];
  if (e.tipo_persona !== 'NATURAL') faltan.push('que el tercero sea una persona natural');
  if (!String(e.nombres ?? '').trim()) faltan.push('los nombres');
  if (!String(e.apellidos ?? '').trim()) faltan.push('los apellidos');
  // 8-oct-2026 · La DIAN rechaza (regla NIE045) un documento con letras, puntos o espacios.
  if (!/^\d+$/.test(String(e.numero_documento ?? ''))) faltan.push('un documento solo con números');
  if (!String(e.direccion ?? '').trim()) faltan.push('la dirección');
  if (!e.municipio_codigo) faltan.push('el municipio');
  return faltan;
}

const conFaltantes = (e) => ({ ...e, faltantes: faltantesParaNomina(e) });

export async function listarEmpleados(client = pool) {
  const r = await client.query(`SELECT ${EMPLEADO_SELECT} ${EMPLEADO_FROM} ORDER BY e.activo DESC, nombre`);
  return r.rows.map(conFaltantes);
}

export async function obtenerEmpleado(id, client = pool) {
  const r = await client.query(`SELECT ${EMPLEADO_SELECT} ${EMPLEADO_FROM} WHERE e.id = $1`, [id]);
  if (!r.rows[0]) throw notFound('Ese empleado no existe.');
  return conFaltantes(r.rows[0]);
}

const fechaIso = (v, campo, { obligatoria = false } = {}) => {
  const s = String(v ?? '').trim();
  if (!s) { if (obligatoria) throw badRequest(`${campo} es obligatoria.`); return null; }
  const d = new Date(`${s}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw badRequest(`${campo} debe ser una fecha válida.`);
  return s;
};
const texto = (v, max = 120) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max) || null;
const uno = (lista, v, campo) => {
  const s = String(v ?? '');
  if (!lista.some((x) => x.codigo === s)) throw badRequest(`${campo} no es válido.`);
  return s;
};

/** Valida el formulario y devuelve las columnas listas para guardar. */
export function validarEmpleado(b = {}) {
  const salario = Number(b.salario);
  if (!Number.isFinite(salario) || salario <= 0) throw badRequest('El salario debe ser mayor que cero.');
  const fechaIngreso = fechaIso(b.fecha_ingreso, 'La fecha de ingreso', { obligatoria: true });
  const fechaRetiro = fechaIso(b.fecha_retiro, 'La fecha de retiro');
  if (fechaRetiro && fechaRetiro < fechaIngreso) throw badRequest('La fecha de retiro no puede ser anterior a la de ingreso.');

  const metodoPago = uno(METODOS_PAGO, b.metodo_pago ?? '47', 'El medio de pago');
  const conCuenta = METODOS_PAGO.find((m) => m.codigo === metodoPago).conCuenta;
  const banco = conCuenta ? texto(b.banco, 80) : null;
  const numeroCuenta = conCuenta ? String(b.numero_cuenta ?? '').replace(/\D/g, '') || null : null;
  if (conCuenta && (!banco || !numeroCuenta)) throw badRequest('Para pagar por transferencia o consignación indique el banco y el número de cuenta.');
  const tipoCuenta = conCuenta ? uno(TIPOS_CUENTA, b.tipo_cuenta, 'El tipo de cuenta') : null;

  return {
    cargo: texto(b.cargo),
    salario: Math.round(salario * 100) / 100,
    salario_integral: b.salario_integral === true,
    tipo_contrato: uno(TIPOS_CONTRATO, b.tipo_contrato ?? '2', 'El tipo de contrato'),
    tipo_trabajador: uno(TIPOS_TRABAJADOR, b.tipo_trabajador ?? '01', 'El tipo de trabajador'),
    subtipo_trabajador: uno(SUBTIPOS_TRABAJADOR, b.subtipo_trabajador ?? '00', 'El subtipo de trabajador'),
    alto_riesgo: b.alto_riesgo === true,
    fecha_ingreso: fechaIngreso,
    fecha_retiro: fechaRetiro,
    metodo_pago: metodoPago,
    banco,
    tipo_cuenta: tipoCuenta,
    numero_cuenta: numeroCuenta,
    eps: texto(b.eps, 80),
    fondo_pension: texto(b.fondo_pension, 80),
    fondo_cesantias: texto(b.fondo_cesantias, 80),
    arl: texto(b.arl, 80),
    caja_compensacion: texto(b.caja_compensacion, 80),
  };
}

const CAMPOS = [
  'cargo', 'salario', 'salario_integral', 'tipo_contrato', 'tipo_trabajador', 'subtipo_trabajador', 'alto_riesgo',
  'fecha_ingreso', 'fecha_retiro', 'metodo_pago', 'banco', 'tipo_cuenta', 'numero_cuenta',
  'eps', 'fondo_pension', 'fondo_cesantias', 'arl', 'caja_compensacion',
];

export async function crearEmpleado(body, usuarioId) {
  const campos = validarEmpleado(body);
  return withTransaction(async (client) => {
    const t = (await client.query(`SELECT id, activo FROM sst.terceros WHERE id = $1`, [body.tercero_id])).rows[0];
    if (!t) throw badRequest('Elija a la persona en Terceros (si no existe, créela allí primero).');
    if (!t.activo) throw badRequest('Ese tercero está inactivo.');
    const ya = await client.query(`SELECT 1 FROM sst.empleados WHERE tercero_id = $1`, [t.id]);
    if (ya.rowCount) throw conflict('Esa persona ya tiene ficha de empleado.');
    const r = await client.query(
      `INSERT INTO sst.empleados (tercero_id, ${CAMPOS.join(', ')}, creado_por, actualizado_por)
       VALUES ($1, ${CAMPOS.map((_, i) => `$${i + 2}`).join(', ')}, $${CAMPOS.length + 2}, $${CAMPOS.length + 2}) RETURNING id`,
      [t.id, ...CAMPOS.map((c) => campos[c]), usuarioId],
    );
    await client.query(`UPDATE sst.terceros SET es_empleado = true WHERE id = $1 AND NOT es_empleado`, [t.id]);
    return obtenerEmpleado(r.rows[0].id, client);
  });
}

export async function actualizarEmpleado(id, body, usuarioId) {
  const campos = validarEmpleado(body);
  const r = await pool.query(
    `UPDATE sst.empleados SET ${CAMPOS.map((c, i) => `${c} = $${i + 2}`).join(', ')}, actualizado_por = $${CAMPOS.length + 2}
      WHERE id = $1 RETURNING id`,
    [id, ...CAMPOS.map((c) => campos[c]), usuarioId],
  );
  if (!r.rows[0]) throw notFound('Ese empleado no existe.');
  return obtenerEmpleado(id);
}

export async function cambiarEstadoEmpleado(id, activo, usuarioId) {
  const r = await pool.query(`UPDATE sst.empleados SET activo = $2, actualizado_por = $3 WHERE id = $1 RETURNING id`, [id, activo === true, usuarioId]);
  if (!r.rows[0]) throw notFound('Ese empleado no existe.');
  return obtenerEmpleado(id);
}
