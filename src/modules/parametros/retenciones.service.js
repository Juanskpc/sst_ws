import { pool } from '../../config/db.js';
import { badRequest, conflict, notFound } from '../../utils/httpError.js';
import { textoPersona } from '../../utils/personas.js';

/**
 * A0-07 · Retenciones, autorretención, UVT y condiciones por pagador.
 *
 * `factus_tributo_id` es el código de `items.*.withholding_taxes[].code` que
 * Factus v2 confirma en su ejemplo "estandar-autorrentenciones": 05 = Retención
 * sobre el IVA, 06 = Retención sobre renta. El ReteICA NO tiene código ahí
 * porque se practica al pagar, no en la factura (§3.5 del plan): su fila queda
 * con `factus_tributo_id` en null a propósito.
 */

const TIPOS = ['RETEFUENTE', 'RETEICA', 'RETEIVA', 'AUTORRETENCION'];
/** Cada tipo solo puede mapear a este código de Factus (o a ninguno). */
const CODIGO_FACTUS_PERMITIDO = { RETEFUENTE: '06', AUTORRETENCION: '06', RETEIVA: '05', RETEICA: null };

// ─── UVT ────────────────────────────────────────────────────────────────────────────────────

export async function listarUvt() {
  const r = await pool.query(`SELECT anio, valor FROM sst.uvt ORDER BY anio DESC`);
  return r.rows;
}

export async function guardarUvt(b = {}) {
  const anio = Number.parseInt(b.anio, 10);
  const valor = Number(b.valor);
  if (!Number.isInteger(anio) || anio < 2000 || anio > 2100) throw badRequest('El año debe ser válido (2000-2100).');
  if (!Number.isFinite(valor) || valor <= 0) throw badRequest('El valor de la UVT debe ser un número positivo.');
  await pool.query(
    `INSERT INTO sst.uvt (anio, valor) VALUES ($1,$2)
     ON CONFLICT (anio) DO UPDATE SET valor = EXCLUDED.valor`,
    [anio, valor],
  );
  return listarUvt();
}

// ─── Retenciones ────────────────────────────────────────────────────────────────────────────

export async function listarRetenciones({ soloActivas = false } = {}) {
  const r = await pool.query(
    `SELECT id, codigo, nombre, tipo, tarifa, base_minima_uvt, aplica_a, factus_tributo_id, activa
       FROM sst.retenciones ${soloActivas ? 'WHERE activa' : ''} ORDER BY tipo, codigo`,
  );
  return r.rows;
}

function validarRetencion(b = {}) {
  const codigo = String(b.codigo ?? '').trim().toUpperCase();
  if (!codigo) throw badRequest('El código de la retención es obligatorio.');
  const nombre = textoPersona(b.nombre);
  if (!nombre) throw badRequest('El nombre de la retención es obligatorio.');

  const tipo = String(b.tipo || '').toUpperCase();
  if (!TIPOS.includes(tipo)) throw badRequest(`El tipo debe ser uno de: ${TIPOS.join(', ')}.`);

  const tarifa = Number(b.tarifa);
  if (!Number.isFinite(tarifa) || tarifa < 0 || tarifa > 100) throw badRequest('La tarifa debe ser un número entre 0 y 100 (admite decimales: 1.1, 0.5…).');
  const baseMinima = b.base_minima_uvt == null || b.base_minima_uvt === '' ? 0 : Number(b.base_minima_uvt);
  if (!Number.isFinite(baseMinima) || baseMinima < 0) throw badRequest('La base mínima en UVT debe ser un número positivo.');

  const aplicaA = String(b.aplica_a || '').toUpperCase();
  if (!['VENTA', 'COMPRA'].includes(aplicaA)) throw badRequest('aplica_a debe ser VENTA o COMPRA.');

  const permitido = CODIGO_FACTUS_PERMITIDO[tipo];
  let factusTributoId = b.factus_tributo_id === undefined ? undefined : (String(b.factus_tributo_id || '').trim() || null);
  if (factusTributoId === undefined) factusTributoId = permitido; // por defecto, el que corresponde al tipo
  if (factusTributoId !== null && factusTributoId !== permitido) {
    throw badRequest(
      permitido
        ? `Una retención ${tipo} solo puede ir con el código de tributo "${permitido}" del proveedor tecnológico (o vacío, para no enviarla en el XML).`
        : `La ${tipo} no va en el XML de la factura (se practica al pagar): el código de tributo debe quedar vacío.`,
    );
  }

  return { codigo, nombre, tipo, tarifa, base_minima_uvt: baseMinima, aplica_a: aplicaA, factus_tributo_id: factusTributoId };
}

async function cargarRetencion(id) {
  const r = await pool.query(
    `SELECT id, codigo, nombre, tipo, tarifa, base_minima_uvt, aplica_a, factus_tributo_id, activa FROM sst.retenciones WHERE id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

export async function crearRetencion(b) {
  const c = validarRetencion(b);
  const dup = await pool.query(`SELECT id FROM sst.retenciones WHERE codigo = $1`, [c.codigo]);
  if (dup.rows[0]) throw conflict(`Ya existe una retención con el código ${c.codigo}.`);
  const r = await pool.query(
    `INSERT INTO sst.retenciones (codigo, nombre, tipo, tarifa, base_minima_uvt, aplica_a, factus_tributo_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [c.codigo, c.nombre, c.tipo, c.tarifa, c.base_minima_uvt, c.aplica_a, c.factus_tributo_id],
  );
  return cargarRetencion(r.rows[0].id);
}

export async function actualizarRetencion(id, b) {
  const c = validarRetencion(b);
  const dup = await pool.query(`SELECT id FROM sst.retenciones WHERE codigo = $1 AND id <> $2`, [c.codigo, id]);
  if (dup.rows[0]) throw conflict(`Ya existe una retención con el código ${c.codigo}.`);
  const r = await pool.query(
    `UPDATE sst.retenciones SET codigo=$2, nombre=$3, tipo=$4, tarifa=$5, base_minima_uvt=$6, aplica_a=$7, factus_tributo_id=$8
      WHERE id = $1 RETURNING id`,
    [id, c.codigo, c.nombre, c.tipo, c.tarifa, c.base_minima_uvt, c.aplica_a, c.factus_tributo_id],
  );
  if (!r.rows[0]) throw notFound('Retención no encontrada');
  return cargarRetencion(id);
}

export async function setRetencionActiva(id, activa) {
  const r = await pool.query(`UPDATE sst.retenciones SET activa = $2 WHERE id = $1 RETURNING id`, [id, activa]);
  if (!r.rows[0]) throw notFound('Retención no encontrada');
  return cargarRetencion(id);
}

// ─── Condiciones por pagador ────────────────────────────────────────────────────────────────

const CONDICION_SELECT = `
  c.tercero_id,
  COALESCE(t.razon_social, btrim(concat_ws(' ', t.nombres, t.apellidos))) AS pagador_nombre,
  c.retenciones_ids,
  c.reteica_pago_id, ri.nombre AS reteica_pago_nombre,
  c.descuento_comercial_pct, c.plazo_dias, c.formato_descripcion, c.actualizado_en`;
const CONDICION_FROM = `
  FROM sst.condiciones_pagador c
  JOIN sst.terceros t ON t.id = c.tercero_id
  LEFT JOIN sst.retenciones ri ON ri.id = c.reteica_pago_id`;

export async function listarCondiciones() {
  const r = await pool.query(`SELECT ${CONDICION_SELECT} ${CONDICION_FROM} ORDER BY pagador_nombre`);
  return r.rows;
}

export async function obtenerCondicion(terceroId) {
  const r = await pool.query(`SELECT ${CONDICION_SELECT} ${CONDICION_FROM} WHERE c.tercero_id = $1`, [terceroId]);
  return r.rows[0] ?? null;
}

export async function guardarCondicion(terceroId, b = {}) {
  const pagador = await pool.query(`SELECT id FROM sst.terceros WHERE id = $1`, [terceroId]);
  if (!pagador.rows[0]) throw badRequest('El tercero no existe.');

  const ids = [...new Set((Array.isArray(b.retenciones_ids) ? b.retenciones_ids : []).filter(Boolean))];
  if (ids.length) {
    // El ReteICA nunca va aquí: se practica al pagar y tiene su propio campo
    // (reteica_pago_id). Meterlo en la factura sería inventarle a Factus un
    // tributo que no modela para ese tipo.
    const ok = await pool.query(`SELECT id FROM sst.retenciones WHERE id = ANY($1) AND aplica_a = 'VENTA' AND tipo <> 'RETEICA' AND activa`, [ids]);
    const validos = new Set(ok.rows.map((x) => x.id));
    const malos = ids.filter((i) => !validos.has(i));
    if (malos.length) throw badRequest('Una o más retenciones seleccionadas no existen, no son de VENTA (o son ReteICA, que va en "ReteICA al pagar"), o están inactivas.');
  }

  let reteicaPagoId = null;
  if (b.reteica_pago_id) {
    const r = await pool.query(`SELECT id FROM sst.retenciones WHERE id = $1 AND tipo = 'RETEICA' AND activa`, [b.reteica_pago_id]);
    if (!r.rows[0]) throw badRequest('El ReteICA de pago debe ser una retención de tipo RETEICA activa.');
    reteicaPagoId = r.rows[0].id;
  }

  const descuento = b.descuento_comercial_pct == null || b.descuento_comercial_pct === '' ? 0 : Number(b.descuento_comercial_pct);
  if (!Number.isFinite(descuento) || descuento < 0) throw badRequest('El descuento comercial debe ser un número positivo.');
  const plazo = b.plazo_dias == null || b.plazo_dias === '' ? 0 : Number.parseInt(b.plazo_dias, 10);
  if (!Number.isInteger(plazo) || plazo < 0) throw badRequest('El plazo en días debe ser un entero positivo.');
  const formato = b.formato_descripcion == null ? null : String(b.formato_descripcion).trim() || null;

  await pool.query(
    `INSERT INTO sst.condiciones_pagador (tercero_id, retenciones_ids, reteica_pago_id, descuento_comercial_pct, plazo_dias, formato_descripcion)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (tercero_id) DO UPDATE
        SET retenciones_ids = EXCLUDED.retenciones_ids, reteica_pago_id = EXCLUDED.reteica_pago_id,
            descuento_comercial_pct = EXCLUDED.descuento_comercial_pct, plazo_dias = EXCLUDED.plazo_dias,
            formato_descripcion = EXCLUDED.formato_descripcion, actualizado_en = now()`,
    [terceroId, ids, reteicaPagoId, descuento, plazo, formato],
  );
  return obtenerCondicion(terceroId);
}
