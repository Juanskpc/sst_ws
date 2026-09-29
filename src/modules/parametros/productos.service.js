import { pool } from '../../config/db.js';
import { badRequest, conflict, notFound } from '../../utils/httpError.js';
import { textoPersona } from '../../utils/personas.js';

/**
 * A0-06 · Productos y tarifas de venta.
 *
 * Productos y tarifas se cargan por PANTALLA, no por semilla (ficha A0-06): lo
 * único que este archivo trae "de fábrica" es la validación, nunca una fila.
 */

const PRODUCTO_SELECT = `
  p.id, p.codigo, p.nombre, p.tratamiento_iva, p.tarifa_iva,
  p.unidad_medida_id, um.nombre AS unidad_medida_nombre, um.codigo_dian AS unidad_medida_codigo,
  p.tributo_id, tr.nombre AS tributo_nombre, tr.codigo_dian AS tributo_codigo,
  p.activo, p.creado_en, p.actualizado_en`;
const PRODUCTO_FROM = `
  FROM sst.productos p
  LEFT JOIN sst.unidades_medida um ON um.id = p.unidad_medida_id
  LEFT JOIN sst.tributos tr ON tr.id = p.tributo_id`;

export async function listarProductos({ soloActivos = false } = {}) {
  const r = await pool.query(
    `SELECT ${PRODUCTO_SELECT} ${PRODUCTO_FROM} ${soloActivos ? 'WHERE p.activo' : ''} ORDER BY p.codigo`,
  );
  return r.rows;
}

async function cargarProducto(id) {
  const r = await pool.query(`SELECT ${PRODUCTO_SELECT} ${PRODUCTO_FROM} WHERE p.id = $1`, [id]);
  return r.rows[0] ?? null;
}

const TRATAMIENTOS = ['GRAVADO', 'EXENTO', 'EXCLUIDO'];

async function validarProducto(b = {}) {
  const codigo = String(b.codigo ?? '').trim();
  if (!codigo) throw badRequest('El código del producto es obligatorio.');
  const nombre = textoPersona(b.nombre);
  if (!nombre) throw badRequest('El nombre del producto es obligatorio.');

  const tratamiento = String(b.tratamiento_iva || 'EXENTO').toUpperCase();
  if (!TRATAMIENTOS.includes(tratamiento)) throw badRequest('tratamiento_iva debe ser GRAVADO, EXENTO o EXCLUIDO.');
  const tarifaIva = tratamiento === 'GRAVADO' ? Number(b.tarifa_iva) : 0;
  if (tratamiento === 'GRAVADO' && (!Number.isFinite(tarifaIva) || tarifaIva < 0 || tarifaIva > 100)) {
    throw badRequest('La tarifa de IVA debe ser un número entre 0 y 100.');
  }

  let unidadMedidaId = null;
  if (b.unidad_medida_id) {
    const u = await pool.query(`SELECT id FROM sst.unidades_medida WHERE id = $1`, [b.unidad_medida_id]);
    if (!u.rows[0]) throw badRequest('La unidad de medida no existe en el catálogo.');
    unidadMedidaId = u.rows[0].id;
  }
  let tributoId = null;
  if (b.tributo_id) {
    const t = await pool.query(`SELECT id FROM sst.tributos WHERE id = $1`, [b.tributo_id]);
    if (!t.rows[0]) throw badRequest('El tributo no existe en el catálogo.');
    tributoId = t.rows[0].id;
  }

  return { codigo, nombre, tratamiento_iva: tratamiento, tarifa_iva: tarifaIva, unidad_medida_id: unidadMedidaId, tributo_id: tributoId };
}

export async function crearProducto(b) {
  const campos = await validarProducto(b);
  const dup = await pool.query(`SELECT id FROM sst.productos WHERE codigo = $1`, [campos.codigo]);
  if (dup.rows[0]) throw conflict(`Ya existe un producto con el código ${campos.codigo}.`);
  const r = await pool.query(
    `INSERT INTO sst.productos (codigo, nombre, tratamiento_iva, tarifa_iva, unidad_medida_id, tributo_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [campos.codigo, campos.nombre, campos.tratamiento_iva, campos.tarifa_iva, campos.unidad_medida_id, campos.tributo_id],
  );
  return cargarProducto(r.rows[0].id);
}

export async function actualizarProducto(id, b) {
  const campos = await validarProducto(b);
  const dup = await pool.query(`SELECT id FROM sst.productos WHERE codigo = $1 AND id <> $2`, [campos.codigo, id]);
  if (dup.rows[0]) throw conflict(`Ya existe un producto con el código ${campos.codigo}.`);
  const r = await pool.query(
    `UPDATE sst.productos
        SET codigo=$2, nombre=$3, tratamiento_iva=$4, tarifa_iva=$5, unidad_medida_id=$6, tributo_id=$7
      WHERE id = $1 RETURNING id`,
    [id, campos.codigo, campos.nombre, campos.tratamiento_iva, campos.tarifa_iva, campos.unidad_medida_id, campos.tributo_id],
  );
  if (!r.rows[0]) throw notFound('Producto no encontrado');
  return cargarProducto(id);
}

export async function setProductoActivo(id, activo) {
  const r = await pool.query(`UPDATE sst.productos SET activo = $2 WHERE id = $1 RETURNING id`, [id, activo]);
  if (!r.rows[0]) throw notFound('Producto no encontrado');
  return cargarProducto(id);
}

// ─── Tarifas de venta ───────────────────────────────────────────────────────────────────────

const TARIFA_SELECT = `
  t.id, t.pagador_tercero_id,
  COALESCE(p.razon_social, btrim(concat_ws(' ', p.nombres, p.apellidos))) AS pagador_nombre,
  t.tipo_orden_id, o.nombre AS tipo_orden_nombre,
  t.unidad, t.valor, to_char(t.vigente_desde, 'YYYY-MM-DD') AS vigente_desde, t.activo, t.creado_en`;
const TARIFA_FROM = `
  FROM sst.tarifas_venta t
  JOIN sst.terceros p ON p.id = t.pagador_tercero_id
  LEFT JOIN sst.tipos_orden o ON o.id = t.tipo_orden_id`;

export async function listarTarifas({ pagadorId } = {}) {
  const params = [];
  let where = '';
  if (pagadorId) { params.push(pagadorId); where = `WHERE t.pagador_tercero_id = $1`; }
  const r = await pool.query(
    `SELECT ${TARIFA_SELECT} ${TARIFA_FROM} ${where} ORDER BY pagador_nombre, o.nombre NULLS FIRST, t.vigente_desde DESC`,
    params,
  );
  return r.rows;
}

async function cargarTarifa(id) {
  const r = await pool.query(`SELECT ${TARIFA_SELECT} ${TARIFA_FROM} WHERE t.id = $1`, [id]);
  return r.rows[0] ?? null;
}

async function validarTarifa(b = {}) {
  if (!b.pagador_tercero_id) throw badRequest('El pagador es obligatorio.');
  const pagador = await pool.query(`SELECT id FROM sst.terceros WHERE id = $1`, [b.pagador_tercero_id]);
  if (!pagador.rows[0]) throw badRequest('El pagador no existe.');

  let tipoOrdenId = null;
  if (b.tipo_orden_id) {
    const to = await pool.query(`SELECT id FROM sst.tipos_orden WHERE id = $1`, [b.tipo_orden_id]);
    if (!to.rows[0]) throw badRequest('El tipo de orden no existe.');
    tipoOrdenId = to.rows[0].id;
  }

  const unidad = String(b.unidad || '').toUpperCase();
  if (!['HORA', 'UNIDAD'].includes(unidad)) throw badRequest('La unidad debe ser HORA o UNIDAD.');
  const valor = Number(b.valor);
  if (!Number.isFinite(valor) || valor < 0) throw badRequest('El valor debe ser un número positivo.');

  const vigenteDesde = String(b.vigente_desde || '').trim() || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(vigenteDesde)) throw badRequest('La vigencia debe ser una fecha AAAA-MM-DD.');

  return { pagador_tercero_id: pagador.rows[0].id, tipo_orden_id: tipoOrdenId, unidad, valor, vigente_desde: vigenteDesde };
}

export async function crearTarifa(b) {
  const c = await validarTarifa(b);
  try {
    const r = await pool.query(
      `INSERT INTO sst.tarifas_venta (pagador_tercero_id, tipo_orden_id, unidad, valor, vigente_desde)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [c.pagador_tercero_id, c.tipo_orden_id, c.unidad, c.valor, c.vigente_desde],
    );
    return cargarTarifa(r.rows[0].id);
  } catch (err) {
    if (err.code === '23505') throw conflict('Ya hay una tarifa para ese pagador, tipo de orden y fecha de vigencia.');
    throw err;
  }
}

export async function setTarifaActiva(id, activo) {
  const r = await pool.query(`UPDATE sst.tarifas_venta SET activo = $2 WHERE id = $1 RETURNING id`, [id, activo]);
  if (!r.rows[0]) throw notFound('Tarifa no encontrada');
  return cargarTarifa(id);
}
