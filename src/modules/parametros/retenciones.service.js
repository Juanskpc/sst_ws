import { pool, withTransaction } from '../../config/db.js';
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
    `SELECT r.id, r.codigo, r.nombre, r.tipo, r.tarifa, r.base_minima_uvt, r.aplica_a, r.factus_tributo_id, r.activa,
            r.cuenta_id, cc.codigo AS cuenta_codigo, cc.nombre AS cuenta_nombre,
            r.cuenta_devolucion_id, cd.codigo AS cuenta_devolucion_codigo, cd.nombre AS cuenta_devolucion_nombre
       FROM sst.retenciones r LEFT JOIN sst.cuentas_contables cc ON cc.id = r.cuenta_id
       LEFT JOIN sst.cuentas_contables cd ON cd.id = r.cuenta_devolucion_id
      ${soloActivas ? 'WHERE r.activa' : ''} ORDER BY r.tipo, r.codigo`,
  );
  return r.rows;
}

function validarRetencion(b = {}) {
  const codigo = String(b.codigo ?? '').trim().toUpperCase();
  if (!codigo) throw badRequest('Escriba el código de la retención (p. ej. el de su software contable, o uno corto como RF-11).');
  const nombre = textoPersona(b.nombre);
  if (!nombre) throw badRequest('Escriba el nombre de la retención (p. ej. «Retefuente 11 %»).');

  const tipo = String(b.tipo || '').toUpperCase();
  if (!TIPOS.includes(tipo)) throw badRequest('Elija el tipo: retención en la fuente, ReteICA, ReteIVA o autorretención.');

  const tarifa = Number(b.tarifa);
  if (!Number.isFinite(tarifa) || tarifa < 0 || tarifa > 100) throw badRequest('La tarifa es un porcentaje entre 0 y 100, con punto decimal: 11 para el 11 %, 1.1 para el 1,1 %, 0.6 para el 6 por mil.');
  const baseMinima = b.base_minima_uvt == null || b.base_minima_uvt === '' ? 0 : Number(b.base_minima_uvt);
  if (!Number.isFinite(baseMinima) || baseMinima < 0) throw badRequest('La base mínima en UVT debe ser un número igual o mayor que cero (0 si no tiene base mínima).');

  const aplicaA = String(b.aplica_a || '').toUpperCase();
  if (!['VENTA', 'COMPRA'].includes(aplicaA)) throw badRequest('Indique si la retención es de ventas (la practica el cliente a JD&D) o de compras (la practica JD&D a su proveedor).');

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

  // B3-01 · Cuenta contable donde va lo retenido (p. ej. la ReteICA que practica el
  // cliente al pagar). `undefined` = no se toca al editar; vacío = sin cuenta.
  const cuentaId = b.cuenta_id === undefined ? undefined : (String(b.cuenta_id || '').trim() || null);
  // 9-oct-2026 · La de devolución (la usa la nota crédito). Misma convención que `cuenta_id`.
  const cuentaDevolucionId = b.cuenta_devolucion_id === undefined ? undefined : (String(b.cuenta_devolucion_id || '').trim() || null);

  return {
    codigo, nombre, tipo, tarifa, base_minima_uvt: baseMinima, aplica_a: aplicaA, factus_tributo_id: factusTributoId,
    cuenta_id: cuentaId, cuenta_devolucion_id: cuentaDevolucionId,
  };
}

async function validarCuentaRetencion(cuentaId, cual = 'La cuenta') {
  if (!cuentaId) return;
  const c = (await pool.query(`SELECT codigo, acepta_movimiento, activa FROM sst.cuentas_contables WHERE id = $1`, [cuentaId])).rows[0];
  if (!c) throw badRequest(`${cual} elegida no existe en el plan de cuentas.`);
  if (!c.acepta_movimiento || !c.activa) throw badRequest(`${cual} ${c.codigo} no recibe movimiento (o está inactiva): elija una cuenta auxiliar.`);
}

/**
 * Solo puede haber UNA autorretención activa por tipo de operación: la contabilización
 * usa una sola, y dos (p. ej. una con la cuenta débito y otra con la crédito, como se
 * crearon en producción el 9-oct-2026) se veían repetidas en la factura. Las dos cuentas
 * de la autorretención no van aquí sino en Contabilidad → Reglas.
 */
async function validarAutorretencionUnica(tipo, aplicaA, excluirId = null) {
  if (tipo !== 'AUTORRETENCION') return;
  const otra = (await pool.query(
    `SELECT codigo, nombre FROM sst.retenciones
      WHERE tipo = 'AUTORRETENCION' AND aplica_a = $1 AND activa AND ($2::uuid IS NULL OR id <> $2::uuid)`,
    [aplicaA, excluirId],
  )).rows[0];
  if (otra) {
    throw conflict(`Ya hay una autorretención activa: «${otra.nombre}» (${otra.codigo}). Solo se usa una. Sus dos cuentas `
      + '(anticipo y por pagar) se configuran en Contabilidad → Reglas: «Autorretención (anticipo)» y «Autorretención por pagar».');
  }
}

async function cargarRetencion(id) {
  const r = await pool.query(
    `SELECT r.id, r.codigo, r.nombre, r.tipo, r.tarifa, r.base_minima_uvt, r.aplica_a, r.factus_tributo_id, r.activa,
            r.cuenta_id, cc.codigo AS cuenta_codigo, cc.nombre AS cuenta_nombre,
            r.cuenta_devolucion_id, cd.codigo AS cuenta_devolucion_codigo, cd.nombre AS cuenta_devolucion_nombre
       FROM sst.retenciones r LEFT JOIN sst.cuentas_contables cc ON cc.id = r.cuenta_id
       LEFT JOIN sst.cuentas_contables cd ON cd.id = r.cuenta_devolucion_id WHERE r.id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

export async function crearRetencion(b) {
  const c = validarRetencion(b);
  await validarCuentaRetencion(c.cuenta_id);
  await validarCuentaRetencion(c.cuenta_devolucion_id, 'La cuenta de devolución');
  const dup = await pool.query(`SELECT id FROM sst.retenciones WHERE codigo = $1`, [c.codigo]);
  if (dup.rows[0]) throw conflict(`Ya existe una retención con el código ${c.codigo}: use otro código o edite la que ya está.`);
  await validarAutorretencionUnica(c.tipo, c.aplica_a);
  const r = await pool.query(
    `INSERT INTO sst.retenciones (codigo, nombre, tipo, tarifa, base_minima_uvt, aplica_a, factus_tributo_id, cuenta_id, cuenta_devolucion_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [c.codigo, c.nombre, c.tipo, c.tarifa, c.base_minima_uvt, c.aplica_a, c.factus_tributo_id, c.cuenta_id ?? null, c.cuenta_devolucion_id ?? null],
  );
  return cargarRetencion(r.rows[0].id);
}

export async function actualizarRetencion(id, b) {
  const c = validarRetencion(b);
  await validarCuentaRetencion(c.cuenta_id);
  await validarCuentaRetencion(c.cuenta_devolucion_id, 'La cuenta de devolución');
  const dup = await pool.query(`SELECT id FROM sst.retenciones WHERE codigo = $1 AND id <> $2`, [c.codigo, id]);
  if (dup.rows[0]) throw conflict(`Ya existe otra retención con el código ${c.codigo}: use otro código.`);
  const actual = (await pool.query(`SELECT activa FROM sst.retenciones WHERE id = $1`, [id])).rows[0];
  if (!actual) throw notFound('Esa retención ya no existe: recargue la página.');
  if (actual.activa) await validarAutorretencionUnica(c.tipo, c.aplica_a, id);
  const r = await pool.query(
    `UPDATE sst.retenciones SET codigo=$2, nombre=$3, tipo=$4, tarifa=$5, base_minima_uvt=$6, aplica_a=$7, factus_tributo_id=$8,
            cuenta_id = CASE WHEN $9 THEN $10::uuid ELSE cuenta_id END,
            cuenta_devolucion_id = CASE WHEN $11 THEN $12::uuid ELSE cuenta_devolucion_id END
      WHERE id = $1 RETURNING id`,
    [id, c.codigo, c.nombre, c.tipo, c.tarifa, c.base_minima_uvt, c.aplica_a, c.factus_tributo_id, c.cuenta_id !== undefined, c.cuenta_id ?? null,
      c.cuenta_devolucion_id !== undefined, c.cuenta_devolucion_id ?? null],
  );
  if (!r.rows[0]) throw notFound('Retención no encontrada');
  return cargarRetencion(id);
}

export async function setRetencionActiva(id, activa) {
  if (activa) {
    const r0 = (await pool.query(`SELECT tipo, aplica_a FROM sst.retenciones WHERE id = $1`, [id])).rows[0];
    if (r0) await validarAutorretencionUnica(r0.tipo, r0.aplica_a, id);
  }
  const r = await pool.query(`UPDATE sst.retenciones SET activa = $2 WHERE id = $1 RETURNING id`, [id, activa]);
  if (!r.rows[0]) throw notFound('Retención no encontrada');
  return cargarRetencion(id);
}

/**
 * 9-oct-2026 · Eliminar una retención (pedido de la contadora: se equivocó de tarifa al crear
 * una y quería borrarla, no solo inactivarla).
 *
 * Se borra si NO está en nada ya contabilizado o enviado a la DIAN: facturas o notas que
 * salieron del borrador, compras y recibos o pagos de cartera (ahí es historia y solo se
 * puede inactivar). Lo que sí se limpia solo, y se dice en la respuesta:
 *   · los BORRADORES de factura que la tenían: se les quita y se recalcula su total;
 *   · las condiciones de los pagadores que la tenían en su lista o como ReteICA al pagar.
 */
export async function eliminarRetencion(id) {
  return withTransaction(async (client) => {
    const r = (await client.query(`SELECT id, codigo, nombre FROM sst.retenciones WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!r) throw notFound('Esa retención ya no existe: recargue la página.');

    const usos = (await client.query(
      `SELECT
         (SELECT count(DISTINCT d.id) FROM sst.documento_item_tributos t
            JOIN sst.documento_items i ON i.id = t.item_id JOIN sst.documentos_electronicos d ON d.id = i.documento_id
           WHERE t.retencion_id = $1 AND d.estado <> 'BORRADOR')::int AS documentos,
         (SELECT count(*) FROM sst.compra_retenciones WHERE retencion_id = $1)::int AS compras,
         (SELECT count(*) FROM sst.cartera_aplicacion_retenciones WHERE retencion_id = $1)::int AS cartera`,
      [id],
    )).rows[0];
    const donde = [
      usos.documentos && `${usos.documentos} factura(s) o nota(s) ya emitida(s)`,
      usos.compras && `${usos.compras} compra(s)`,
      usos.cartera && `${usos.cartera} recibo(s) o pago(s) de cartera`,
    ].filter(Boolean);
    if (donde.length) {
      throw conflict(`«${r.nombre}» no se puede eliminar porque ya se usó en ${donde.join(', ')}: borrarla dañaría esa contabilidad. `
        + 'Inactívela (botón de encendido): deja de ofrecerse en lo nuevo y lo anterior queda igual.');
    }

    // Borradores que la tenían: se le quita y se recalcula su total a pagar.
    const borradores = (await client.query(
      `SELECT DISTINCT d.id FROM sst.documento_item_tributos t
         JOIN sst.documento_items i ON i.id = t.item_id JOIN sst.documentos_electronicos d ON d.id = i.documento_id
        WHERE t.retencion_id = $1 AND d.estado = 'BORRADOR'`,
      [id],
    )).rows.map((x) => x.id);
    for (const docId of borradores) {
      await client.query(
        `DELETE FROM sst.documento_item_tributos t USING sst.documento_items i
          WHERE i.id = t.item_id AND i.documento_id = $1 AND t.retencion_id = $2`,
        [docId, id],
      );
      // Solo la retefuente y la ReteIVA restan del total (calculo.js).
      await client.query(
        `UPDATE sst.documentos_electronicos d
            SET total_retenciones = x.ret, total_a_pagar = d.subtotal + d.total_iva - x.ret
           FROM (SELECT COALESCE(sum(t.valor), 0) AS ret FROM sst.documento_item_tributos t
                   JOIN sst.documento_items i ON i.id = t.item_id JOIN sst.retenciones rr ON rr.id = t.retencion_id
                  WHERE i.documento_id = $1 AND rr.tipo IN ('RETEFUENTE', 'RETEIVA')) x
          WHERE d.id = $1`,
        [docId],
      );
    }

    const condiciones = (await client.query(
      `UPDATE sst.condiciones_pagador
          SET retenciones_ids = array_remove(retenciones_ids, $1::uuid),
              reteica_pago_id = CASE WHEN reteica_pago_id = $1 THEN NULL ELSE reteica_pago_id END
        WHERE $1 = ANY(retenciones_ids) OR reteica_pago_id = $1
        RETURNING tercero_id`,
      [id],
    )).rowCount;

    await client.query(`DELETE FROM sst.retenciones WHERE id = $1`, [id]);
    return { codigo: r.codigo, nombre: r.nombre, borradores: borradores.length, condiciones };
  });
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
