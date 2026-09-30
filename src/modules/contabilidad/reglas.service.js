import { pool, withTransaction } from '../../config/db.js';
import { badRequest, notFound } from '../../utils/httpError.js';

/**
 * B2-01 (CNT-13) · Reglas de contabilización: qué cuenta usa cada concepto.
 *
 * El catálogo de conceptos es fijo (lo que un documento puede mover); la cuenta
 * de cada uno la decide la contadora. Una regla general vale para todos; una con
 * producto o tercero la reemplaza en ese caso (p. ej. el ingreso de un servicio
 * a otra cuenta, o el costo por ARL cuando llegue el documento soporte).
 */

/** Conceptos, en el orden en que se leen en un asiento. `lado` es solo para mostrar. */
export const CONCEPTOS = [
  { concepto: 'FV_CXC', documento: 'FACTURA', nombre: 'Cuenta por cobrar al cliente (total a pagar)', lado: 'D' },
  { concepto: 'FV_RETEFUENTE', documento: 'FACTURA', nombre: 'Retención en la fuente que practica el cliente', lado: 'D' },
  { concepto: 'FV_RETEIVA', documento: 'FACTURA', nombre: 'Retención de IVA que practica el cliente', lado: 'D' },
  { concepto: 'FV_DESCUENTO', documento: 'FACTURA', nombre: 'Descuento comercial', lado: 'D' },
  { concepto: 'FV_AUTORRET_DB', documento: 'FACTURA', nombre: 'Autorretención (anticipo)', lado: 'D' },
  { concepto: 'FV_AUTORRET_CR', documento: 'FACTURA', nombre: 'Autorretención por pagar', lado: 'C' },
  { concepto: 'FV_INGRESO', documento: 'FACTURA', nombre: 'Ingreso por servicios (una línea por ítem)', lado: 'C' },
  { concepto: 'FV_IVA', documento: 'FACTURA', nombre: 'IVA generado', lado: 'C' },
  { concepto: 'NC_DEVOLUCION', documento: 'NOTA_CREDITO', nombre: 'Devolución en servicios (una línea por ítem)', lado: 'D' },
  { concepto: 'NC_IVA', documento: 'NOTA_CREDITO', nombre: 'IVA de la devolución', lado: 'D' },
  { concepto: 'NC_CXC', documento: 'NOTA_CREDITO', nombre: 'Disminución de la cuenta por cobrar', lado: 'C' },
  { concepto: 'NC_RETEFUENTE', documento: 'NOTA_CREDITO', nombre: 'Devolución de la retención en la fuente', lado: 'C' },
  { concepto: 'NC_RETEIVA', documento: 'NOTA_CREDITO', nombre: 'Devolución de la retención de IVA', lado: 'C' },
  { concepto: 'NC_DESCUENTO', documento: 'NOTA_CREDITO', nombre: 'Reverso del descuento comercial', lado: 'C' },
  // B5-01 / B4-01 · Compras, egresos y anticipos. El gasto de cada ítem NO es una
  // regla: la cuenta se elige al registrar la compra (combustible, arriendo…).
  { concepto: 'CP_CXP', documento: 'COMPRA', nombre: 'Cuenta por pagar al proveedor', lado: 'C' },
  { concepto: 'CP_CXP_HONORARIOS', documento: 'COMPRA', nombre: 'Honorarios por pagar (servicios profesionales)', lado: 'C' },
  { concepto: 'CP_IVA_DESCONTABLE', documento: 'COMPRA', nombre: 'IVA descontable de la compra', lado: 'D' },
  { concepto: 'CE_ANTICIPO', documento: 'COMPRA', nombre: 'Anticipos a proveedores', lado: 'D' },
];
const CONCEPTOS_VALIDOS = new Set(CONCEPTOS.map((c) => c.concepto));

/**
 * Las cuentas que usa HOY Siigo para cada concepto (§3.5 del plan, sacadas del
 * auxiliar de septiembre: FV-1-809, FV-1-807, NC-1-87). La reversa de la
 * autorretención en la nota crédito usa las mismas dos cuentas que la factura.
 * Las de ReteIVA y del IVA de una devolución no aparecen en el auxiliar: se
 * proponen las del PUC que ya existen y la contadora las confirma.
 */
const CUENTAS_SIIGO = {
  FV_CXC: '13050501', FV_RETEFUENTE: '13551509', FV_RETEIVA: '13551701', FV_DESCUENTO: '53053501',
  FV_AUTORRET_DB: '13551816', FV_AUTORRET_CR: '23657502', FV_INGRESO: '41800101', FV_IVA: '24080601',
  NC_DEVOLUCION: '41750502', NC_IVA: '24082001', NC_CXC: '13050501', NC_RETEFUENTE: '13551510',
  NC_RETEIVA: '13551701', NC_DESCUENTO: '53053501',
  // FC-1-10 (23359501 Otros), DS-1-1316 (23352501 Honorarios), RP-1-2 (13300501 A proveedores).
  CP_CXP: '23359501', CP_CXP_HONORARIOS: '23352501', CP_IVA_DESCONTABLE: '24081001', CE_ANTICIPO: '13300501',
};

/** Cuentas "Rete Ica N" del auxiliar de Siigo, por tarifa en porcentaje (5 ‰ = 0,5 %). */
const RETEICA_POR_TARIFA = {
  '0.400': '13551813', '0.500': '13551819', '0.600': '13551820', '0.690': '13551811', '0.800': '13551807',
};

const SELECT = `
  r.id, r.concepto, r.cuenta_id, c.codigo AS cuenta_codigo, c.nombre AS cuenta_nombre,
  c.acepta_movimiento AS cuenta_acepta_movimiento, c.activa AS cuenta_activa,
  r.producto_id, p.nombre AS producto_nombre, r.tercero_id,
  COALESCE(t.razon_social, NULLIF(btrim(concat_ws(' ', t.nombres, t.apellidos)), '')) AS tercero_nombre,
  r.activa, r.actualizado_en`;
const FROM = `
  FROM sst.reglas_contables r
  JOIN sst.cuentas_contables c ON c.id = r.cuenta_id
  LEFT JOIN sst.productos p ON p.id = r.producto_id
  LEFT JOIN sst.terceros t ON t.id = r.tercero_id`;

export async function listarReglas(db = pool) {
  const reglas = (await db.query(`SELECT ${SELECT} ${FROM} ORDER BY r.concepto, r.tercero_id NULLS FIRST, r.producto_id NULLS FIRST`)).rows;
  return { conceptos: CONCEPTOS, reglas };
}

/** Crea o actualiza la regla de un concepto para un alcance (general, producto o tercero). */
export async function guardarRegla(b = {}, usuarioId = null) {
  const concepto = String(b.concepto ?? '').toUpperCase();
  if (!CONCEPTOS_VALIDOS.has(concepto)) throw badRequest('Ese concepto no existe.');
  if (!b.cuenta_id) throw badRequest('Elija la cuenta.');
  if (b.producto_id && b.tercero_id) throw badRequest('Una regla es general, o de un producto, o de un tercero: no de los dos a la vez.');
  return withTransaction(async (client) => {
    const cuenta = (await client.query(
      `SELECT codigo, acepta_movimiento, activa FROM sst.cuentas_contables WHERE id = $1`, [b.cuenta_id],
    )).rows[0];
    if (!cuenta) throw badRequest('Esa cuenta no existe.');
    if (!cuenta.acepta_movimiento || !cuenta.activa) {
      throw badRequest(`La cuenta ${cuenta.codigo} no recibe movimiento (o está inactiva): elija una auxiliar.`);
    }
    const r = await client.query(
      `INSERT INTO sst.reglas_contables (concepto, cuenta_id, producto_id, tercero_id, actualizado_por)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (concepto, COALESCE(producto_id, '00000000-0000-0000-0000-000000000000'),
                    COALESCE(tercero_id, '00000000-0000-0000-0000-000000000000'))
       DO UPDATE SET cuenta_id = EXCLUDED.cuenta_id, activa = true, actualizado_por = EXCLUDED.actualizado_por
       RETURNING id`,
      [concepto, b.cuenta_id, b.producto_id || null, b.tercero_id || null, usuarioId],
    );
    return (await client.query(`SELECT ${SELECT} ${FROM} WHERE r.id = $1`, [r.rows[0].id])).rows[0];
  });
}

/** Quita una regla específica. La general no se quita: se cambia su cuenta (sin ella el concepto no se puede contabilizar). */
export async function eliminarRegla(id) {
  const r = await pool.query(`SELECT producto_id, tercero_id FROM sst.reglas_contables WHERE id = $1`, [id]);
  if (!r.rows[0]) throw notFound('Esa regla no existe.');
  if (!r.rows[0].producto_id && !r.rows[0].tercero_id) {
    throw badRequest('La regla general de un concepto no se elimina: cambie su cuenta.');
  }
  await pool.query(`DELETE FROM sst.reglas_contables WHERE id = $1`, [id]);
}

/**
 * Carga las reglas GENERALES que faltan con las cuentas de Siigo, si esas cuentas
 * existen en el plan. No toca las que ya están (pueden haberse cambiado a mano).
 */
export async function sembrarReglasSiigo(usuarioId = null, db = null) {
  const correr = (fn) => (db ? fn(db) : withTransaction(fn));
  return correr(async (client) => {
    const cuentas = new Map((await client.query(
      `SELECT codigo, id FROM sst.cuentas_contables WHERE codigo = ANY($1) AND acepta_movimiento AND activa`,
      [Object.values(CUENTAS_SIIGO)],
    )).rows.map((c) => [c.codigo, c.id]));
    const creadas = [];
    const sinCuenta = [];
    for (const [concepto, codigo] of Object.entries(CUENTAS_SIIGO)) {
      const cuentaId = cuentas.get(codigo);
      if (!cuentaId) { sinCuenta.push({ concepto, codigo }); continue; }
      const r = await client.query(
        `INSERT INTO sst.reglas_contables (concepto, cuenta_id, actualizado_por) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING RETURNING id`,
        [concepto, cuentaId, usuarioId],
      );
      if (r.rows[0]) creadas.push(concepto);
    }
    // B3-01 · La cuenta de cada retención de VENTA que aún no la tenga, como en el
    // auxiliar de Siigo: la ReteICA va a la "Rete Ica N" de su tarifa (5 ‰ →
    // 13551819, 6 ‰ → 13551820…) y la retefuente y la ReteIVA que retiene el cliente,
    // a las mismas cuentas de anticipo que usa la factura.
    const cuentaDeRetencion = (r) => {
      if (r.tipo === 'RETEFUENTE') return CUENTAS_SIIGO.FV_RETEFUENTE;
      if (r.tipo === 'RETEIVA') return CUENTAS_SIIGO.FV_RETEIVA;
      if (r.tipo === 'AUTORRETENCION') return CUENTAS_SIIGO.FV_AUTORRET_DB;
      if (r.tipo === 'RETEICA') return RETEICA_POR_TARIFA[Number(r.tarifa).toFixed(3)] ?? null;
      return null;
    };
    const sinCuentaRet = (await client.query(
      `SELECT id, codigo, tipo, tarifa FROM sst.retenciones WHERE aplica_a = 'VENTA' AND cuenta_id IS NULL`,
    )).rows;
    const retencionesConCuenta = [];
    for (const r of sinCuentaRet) {
      const codigo = cuentaDeRetencion(r);
      const cuenta = codigo && (await client.query(
        `SELECT id FROM sst.cuentas_contables WHERE codigo = $1 AND acepta_movimiento AND activa`, [codigo],
      )).rows[0];
      if (!cuenta) continue;
      await client.query(`UPDATE sst.retenciones SET cuenta_id = $2 WHERE id = $1`, [r.id, cuenta.id]);
      retencionesConCuenta.push(`${r.codigo} → ${codigo}`);
    }
    return { creadas, sin_cuenta: sinCuenta, retenciones: retencionesConCuenta };
  });
}

/**
 * Resuelve la cuenta de cada concepto para un documento: gana la regla del
 * tercero, luego la del producto, luego la general. Devuelve una función
 * `cuenta(concepto, productoId?)` que lanza si no hay regla (el mensaje dice cuál falta).
 */
export async function resolvedorDeCuentas(client, terceroId) {
  const reglas = (await client.query(
    `SELECT r.concepto, r.cuenta_id, r.producto_id, r.tercero_id, c.codigo
       FROM sst.reglas_contables r JOIN sst.cuentas_contables c ON c.id = r.cuenta_id
      WHERE r.activa AND (r.tercero_id IS NULL OR r.tercero_id = $1)`,
    [terceroId],
  )).rows;
  return (concepto, productoId = null) => {
    const candidatas = reglas.filter((r) => r.concepto === concepto && (!r.producto_id || r.producto_id === productoId));
    const regla = candidatas.find((r) => r.tercero_id)
      ?? candidatas.find((r) => r.producto_id)
      ?? candidatas.find((r) => !r.tercero_id && !r.producto_id);
    if (!regla) {
      const def = CONCEPTOS.find((c) => c.concepto === concepto);
      throw badRequest(`Falta la regla contable de «${def?.nombre ?? concepto}» (Contabilidad → Reglas).`);
    }
    return regla.cuenta_id;
  };
}
