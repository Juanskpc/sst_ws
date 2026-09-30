import { pool, withTransaction } from '../../config/db.js';
import { badRequest, conflict, notFound } from '../../utils/httpError.js';
import { aCentavos, deCentavos } from '../../utils/dinero.js';
import { hoyCO } from '../../utils/formato.js';
import { anularComprobante, crearComprobante } from '../contabilidad/comprobantes.service.js';

/**
 * B3-01 (CXC-01..04, CNT-05) · Cuentas por cobrar y recibos de caja.
 *
 * Cada factura contabilizada abre su documento de cartera por el total a pagar
 * (lo que su asiento cargó a la cuenta de clientes); las notas crédito y los
 * recibos lo bajan. El saldo de la cartera y el de la cuenta en el libro tienen
 * que coincidir: `conciliacion()` lo comprueba y la pantalla avisa si no.
 *
 * El recibo reproduce el asiento de Siigo (RC-1-97, RC-1-101, RC-1-105):
 *   D  banco ............................ lo consignado (una línea)
 *   D  retención a favor ................ lo que el pagador retuvo, por factura
 *   C  clientes ......................... lo que se cancela de cada factura
 */

const NOMBRE = `COALESCE(t.razon_social, NULLIF(btrim(concat_ws(' ', t.nombres, t.apellidos)), ''))`;
const conTransaccion = (client, fn) => (client ? fn(client) : withTransaction(fn));
const numeroDocumento = (d) => (!d.numero ? null
  : d.prefijo && !String(d.numero).startsWith(d.prefijo) ? `${d.prefijo}${d.numero}` : String(d.numero));

// ─── Nace y baja con los documentos (lo llama la contabilización, B2-01) ─────────

/**
 * Abre la cuenta por cobrar de una factura recién contabilizada, dentro de la
 * misma transacción que su asiento. `cuentaId` es la cuenta de clientes a la que
 * fue el total. Idempotente: si ya existe, no hace nada.
 */
export async function abrirCarteraDeFactura(client, documentoId, cuentaId) {
  const d = (await client.query(
    `SELECT id, tercero_id, prefijo, numero, reference_code, total_a_pagar,
            to_char(COALESCE(fecha_emision, creado_en::date), 'YYYY-MM-DD') AS fecha,
            to_char(COALESCE(fecha_vencimiento, fecha_emision, creado_en::date), 'YYYY-MM-DD') AS vencimiento
       FROM sst.documentos_electronicos WHERE id = $1`,
    [documentoId],
  )).rows[0];
  if (!d || aCentavos(d.total_a_pagar) <= 0) return null;
  const r = await client.query(
    `INSERT INTO sst.cartera_documentos (tipo, tercero_id, documento_id, numero, fecha, vencimiento, valor, saldo, cuenta_id)
     VALUES ('CXC', $1, $2, $3, $4, $5, $6, $6, $7)
     ON CONFLICT (documento_id) DO NOTHING RETURNING id`,
    [d.tercero_id, d.id, numeroDocumento(d) ?? d.reference_code, d.fecha, d.vencimiento, d.total_a_pagar, cuentaId],
  );
  return r.rows[0]?.id ?? null;
}

/**
 * Una nota crédito contabilizada baja el saldo de la factura que corrige, por lo
 * mismo que su asiento abonó a clientes. Si la factura todavía no tiene cartera
 * (no se ha contabilizado), falla: la nota espera a su factura.
 */
export async function aplicarNotaCredito(client, notaId) {
  const n = (await client.query(
    `SELECT id, documento_referencia_id, total_a_pagar, prefijo, numero,
            to_char(COALESCE(fecha_emision, creado_en::date), 'YYYY-MM-DD') AS fecha
       FROM sst.documentos_electronicos WHERE id = $1`,
    [notaId],
  )).rows[0];
  if (!n?.documento_referencia_id || aCentavos(n.total_a_pagar) <= 0) return;
  const ya = await client.query(
    `SELECT 1 FROM sst.cartera_aplicaciones WHERE origen_tipo = 'NOTA_CREDITO' AND origen_id = $1 AND NOT anulada`, [notaId],
  );
  if (ya.rows[0]) return;
  const cxc = (await client.query(
    `SELECT id, saldo FROM sst.cartera_documentos WHERE documento_id = $1 FOR UPDATE`, [n.documento_referencia_id],
  )).rows[0];
  if (!cxc) throw badRequest(`La factura que corrige la nota ${numeroDocumento(n)} aún no está contabilizada: contabilícela primero.`);
  const valor = aCentavos(n.total_a_pagar);
  if (valor > aCentavos(cxc.saldo)) {
    throw badRequest(`La nota ${numeroDocumento(n)} (${deCentavos(valor)}) supera el saldo pendiente de su factura (${cxc.saldo}): ya se recibió un pago que habría que anular primero.`);
  }
  await client.query(
    `INSERT INTO sst.cartera_aplicaciones (cartera_documento_id, origen_tipo, origen_id, fecha, valor_pagado)
     VALUES ($1, 'NOTA_CREDITO', $2, $3, $4)`,
    [cxc.id, notaId, n.fecha, deCentavos(valor)],
  );
  await client.query(`UPDATE sst.cartera_documentos SET saldo = saldo - $2 WHERE id = $1`, [cxc.id, deCentavos(valor)]);
}

// ─── Consultas ──────────────────────────────────────────────────────────────────

const diasVencido = (vencimiento, corte) =>
  Math.floor((Date.parse(`${corte}T00:00:00Z`) - Date.parse(`${vencimiento}T00:00:00Z`)) / 86400000);

/** Edad de una factura a la fecha de corte (CXC-03). */
function edad(vencimiento, corte) {
  const d = diasVencido(vencimiento, corte);
  if (d <= 0) return 'POR_VENCER';
  if (d <= 30) return 'D1_30';
  if (d <= 60) return 'D31_60';
  if (d <= 90) return 'D61_90';
  return 'MAS_90';
}
export const EDADES = ['POR_VENCER', 'D1_30', 'D31_60', 'D61_90', 'MAS_90'];

/** Documentos de cartera por cobrar, con su edad. `soloAbiertos` = con saldo. */
export async function listarCartera({ terceroId = null, soloAbiertos = true, corte = null, tipo = 'CXC' } = {}, db = pool) {
  const fechaCorte = corte || hoyCO();
  const r = await db.query(
    `SELECT c.id, c.tercero_id, ${NOMBRE} AS tercero_nombre, t.numero_documento AS tercero_documento,
            c.documento_id, c.numero, to_char(c.fecha, 'YYYY-MM-DD') AS fecha,
            to_char(c.vencimiento, 'YYYY-MM-DD') AS vencimiento, c.valor, c.saldo,
            COALESCE(d.subtotal, cm.subtotal) AS subtotal, d.tipo AS documento_tipo, c.compra_id
       FROM sst.cartera_documentos c
       JOIN sst.terceros t ON t.id = c.tercero_id
       LEFT JOIN sst.documentos_electronicos d ON d.id = c.documento_id
       LEFT JOIN sst.compras cm ON cm.id = c.compra_id
      WHERE c.tipo = $3 AND NOT c.anulado AND ($1::uuid IS NULL OR c.tercero_id = $1) AND (NOT $2 OR c.saldo > 0)
      ORDER BY c.vencimiento, c.numero`,
    [terceroId, soloAbiertos, tipo],
  );
  return r.rows.map((x) => ({ ...x, dias_vencido: Math.max(0, diasVencido(x.vencimiento, fechaCorte)), edad: edad(x.vencimiento, fechaCorte) }));
}

/** Antigüedad por cliente y edad (CXC-03), en centavos exactos. */
export async function antiguedad(corte = null, db = pool, tipo = 'CXC') {
  const fechaCorte = corte || hoyCO();
  const docs = await listarCartera({ corte: fechaCorte, tipo }, db);
  const porCliente = new Map();
  const total = Object.fromEntries([...EDADES, 'TOTAL'].map((e) => [e, 0]));
  for (const d of docs) {
    if (!porCliente.has(d.tercero_id)) {
      porCliente.set(d.tercero_id, { tercero_id: d.tercero_id, tercero_nombre: d.tercero_nombre, documentos: 0, ...Object.fromEntries([...EDADES, 'TOTAL'].map((e) => [e, 0])) });
    }
    const c = porCliente.get(d.tercero_id);
    const s = aCentavos(d.saldo);
    c[d.edad] += s; c.TOTAL += s; c.documentos++;
    total[d.edad] += s; total.TOTAL += s;
  }
  const aTexto = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, EDADES.includes(k) || k === 'TOTAL' ? deCentavos(v) : v]));
  return {
    corte: fechaCorte,
    clientes: [...porCliente.values()].sort((a, b) => b.TOTAL - a.TOTAL).map(aTexto),
    total: aTexto(total),
  };
}

/** Estado de cuenta de un cliente (CXC-04): cada factura con sus notas y pagos. */
export async function estadoCuenta(terceroId, db = pool, tipo = 'CXC') {
  const t = (await db.query(`SELECT id, ${NOMBRE} AS nombre, numero_documento, dv FROM sst.terceros t WHERE id = $1`, [terceroId])).rows[0];
  if (!t) throw notFound('Ese tercero no existe.');
  const documentos = await listarCartera({ terceroId, soloAbiertos: false, tipo }, db);
  const movs = (await db.query(
    `SELECT a.cartera_documento_id, a.origen_tipo, a.origen_id, to_char(a.fecha, 'YYYY-MM-DD') AS fecha,
            a.valor_pagado, a.valor_retenciones, a.valor_anticipo,
            CASE a.origen_tipo
              WHEN 'RECIBO_CAJA' THEN (SELECT tc.codigo || '-' || cp.numero FROM sst.recibos_caja rc
                                         JOIN sst.comprobantes cp ON cp.id = rc.comprobante_id
                                         JOIN sst.tipos_comprobante tc ON tc.id = cp.tipo_id WHERE rc.id = a.origen_id)
              WHEN 'EGRESO' THEN (SELECT 'CE-' || cp.numero FROM sst.egresos e
                                    JOIN sst.comprobantes cp ON cp.id = e.comprobante_id WHERE e.id = a.origen_id)
              ELSE (SELECT CASE WHEN d.prefijo IS NOT NULL AND d.numero NOT LIKE d.prefijo || '%' THEN d.prefijo || d.numero ELSE d.numero END
                      FROM sst.documentos_electronicos d WHERE d.id = a.origen_id)
            END AS soporte
       FROM sst.cartera_aplicaciones a
       JOIN sst.cartera_documentos c ON c.id = a.cartera_documento_id
      WHERE c.tercero_id = $1 AND c.tipo = $2 AND NOT a.anulada
      ORDER BY a.fecha, a.creado_en`,
    [terceroId, tipo],
  )).rows;
  const saldo = documentos.reduce((s, d) => s + aCentavos(d.saldo), 0);
  return {
    tercero: t,
    saldo: deCentavos(saldo),
    documentos: documentos.map((d) => ({ ...d, movimientos: movs.filter((m) => m.cartera_documento_id === d.id) })),
  };
}

/**
 * Conciliación (§5.1 del plan): el saldo de la cartera por cobrar contra el saldo
 * del libro en las cuentas marcadas como cartera CXC. Deben ser iguales; si no, algo
 * se contabilizó a mano contra clientes sin pasar por la cartera (o al revés).
 */
export async function conciliacion(db = pool, tipo = 'CXC') {
  // Por cobrar es saldo débito; por pagar, crédito.
  const libro = (await db.query(
    `SELECT COALESCE(sum(CASE WHEN $1 = 'CXC' THEN m.debito - m.credito ELSE m.credito - m.debito END), 0) AS saldo
       FROM sst.movimientos m
       JOIN sst.comprobantes c ON c.id = m.comprobante_id AND c.estado = 'CONTABILIZADO'
       JOIN sst.cuentas_contables cc ON cc.id = m.cuenta_id AND cc.es_cartera = $1`,
    [tipo],
  )).rows[0].saldo;
  const cartera = (await db.query(`SELECT COALESCE(sum(saldo), 0) AS saldo FROM sst.cartera_documentos WHERE tipo = $1`, [tipo])).rows[0].saldo;
  const diferencia = aCentavos(libro) - aCentavos(cartera);
  return { saldo_libro: deCentavos(aCentavos(libro)), saldo_cartera: deCentavos(aCentavos(cartera)), diferencia: deCentavos(diferencia), cuadra: diferencia === 0 };
}

// ─── Recibo de caja ─────────────────────────────────────────────────────────────

/**
 * Lo que se le propone a la persona al armar un recibo para un cliente: sus
 * facturas abiertas y, por cada una, la ReteICA que suele practicarle (A0-07,
 * condición del pagador) sobre el subtotal de la factura, en pesos enteros —
 * así la registra Siigo (9.690, 35.720…). Es solo la sugerencia: se corrige.
 */
export async function propuestaRecibo(terceroId, db = pool) {
  const docs = await listarCartera({ terceroId }, db);
  const reteica = (await db.query(
    `SELECT r.id, r.codigo, r.nombre, r.tarifa, r.cuenta_id
       FROM sst.condiciones_pagador cp JOIN sst.retenciones r ON r.id = cp.reteica_pago_id AND r.activa
      WHERE cp.tercero_id = $1`,
    [terceroId],
  )).rows[0] ?? null;
  return {
    reteica,
    facturas: docs.map((d) => {
      // Proporcional a lo que falta: si ya se abonó la mitad, la ReteICA sugerida es la mitad.
      const fraccion = aCentavos(d.valor) ? aCentavos(d.saldo) / aCentavos(d.valor) : 0;
      const base = Math.round(aCentavos(d.subtotal ?? d.valor) * fraccion);
      const sugerida = reteica ? Math.round((base * Number(reteica.tarifa)) / 100 / 100) * 100 : 0;
      return { ...d, base_reteica: deCentavos(base), reteica_sugerida: deCentavos(sugerida) };
    }),
  };
}

const validarFecha = (v) => {
  const f = String(v ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) throw badRequest('La fecha del recibo no es válida.');
  return f;
};

/**
 * Registra un recibo de caja y lo contabiliza (RC) en la misma transacción.
 *
 * `aplicaciones`: [{ cartera_documento_id, valor_pagado, retenciones: [{ retencion_id, valor, base? }] }].
 * Lo consignado es la suma de lo pagado; por cada factura, pagado + retenido no
 * puede superar su saldo.
 */
export async function crearReciboCaja(b = {}, usuarioId = null, { client = null } = {}) {
  return conTransaccion(client, async (db) => {
    const fecha = validarFecha(b.fecha);
    const terceroId = b.tercero_id;
    if (!terceroId) throw badRequest('Elija el cliente que pagó.');
    const banco = (await db.query(
      `SELECT id, codigo FROM sst.cuentas_contables WHERE id = $1 AND es_banco AND acepta_movimiento AND activa`, [b.cuenta_banco_id],
    )).rows[0];
    if (!banco) throw badRequest('Elija la cuenta de banco donde entró la plata (una cuenta marcada como banco en el plan).');
    const aplicaciones = Array.isArray(b.aplicaciones) ? b.aplicaciones.filter((a) => a && a.cartera_documento_id) : [];
    if (!aplicaciones.length) throw badRequest('Elija al menos una factura que cancela el recibo.');

    const retencionIds = [...new Set(aplicaciones.flatMap((a) => (a.retenciones ?? []).map((r) => r.retencion_id)).filter(Boolean))];
    const retenciones = new Map((await db.query(
      `SELECT r.id, r.codigo, r.nombre, r.cuenta_id, c.codigo AS cuenta_codigo
         FROM sst.retenciones r LEFT JOIN sst.cuentas_contables c ON c.id = r.cuenta_id AND c.acepta_movimiento AND c.activa
        WHERE r.id = ANY($1::uuid[])`,
      [retencionIds],
    )).rows.map((r) => [r.id, r]));

    let consignado = 0;
    const lineasRet = [];
    const lineasCxc = [];
    const aplicar = [];
    const vistos = new Set();
    for (const [i, a] of aplicaciones.entries()) {
      if (vistos.has(a.cartera_documento_id)) throw badRequest('Una misma factura aparece dos veces en el recibo.');
      vistos.add(a.cartera_documento_id);
      const doc = (await db.query(
        `SELECT id, tercero_id, numero, saldo, cuenta_id, documento_id FROM sst.cartera_documentos WHERE id = $1 AND tipo = 'CXC' FOR UPDATE`,
        [a.cartera_documento_id],
      )).rows[0];
      if (!doc) throw badRequest(`Fila ${i + 1}: esa factura no está en la cartera.`);
      if (doc.tercero_id !== terceroId) throw badRequest(`La factura ${doc.numero} es de otro cliente.`);
      const pagado = a.valor_pagado == null || a.valor_pagado === '' ? 0 : aCentavos(a.valor_pagado);
      if (!Number.isFinite(pagado) || pagado < 0) throw badRequest(`${doc.numero}: el valor pagado no es válido.`);
      const rets = [];
      for (const r of a.retenciones ?? []) {
        const v = r.valor == null || r.valor === '' ? 0 : aCentavos(r.valor);
        if (!v) continue;
        if (!Number.isFinite(v) || v < 0) throw badRequest(`${doc.numero}: el valor retenido no es válido.`);
        const def = retenciones.get(r.retencion_id);
        if (!def) throw badRequest(`${doc.numero}: elija qué retención practicó el cliente.`);
        if (!def.cuenta_id || !def.cuenta_codigo) {
          throw badRequest(`La retención ${def.codigo} no tiene cuenta contable (Parametrización → Retenciones).`);
        }
        rets.push({ ...def, valor: v, base: r.base == null || r.base === '' ? null : aCentavos(r.base) });
      }
      const retenido = rets.reduce((s, r) => s + r.valor, 0);
      const total = pagado + retenido;
      if (!total) throw badRequest(`${doc.numero}: escriba lo que se pagó o lo que se retuvo.`);
      if (total > aCentavos(doc.saldo)) {
        throw badRequest(`${doc.numero}: lo pagado más lo retenido (${deCentavos(total)}) supera su saldo (${doc.saldo}).`);
      }
      consignado += pagado;
      for (const r of rets) {
        lineasRet.push({ cuenta_id: r.cuenta_id, tercero_id: terceroId, debito: deCentavos(r.valor), base: r.base != null ? deCentavos(r.base) : null,
          descripcion: r.nombre, documento_cruce: doc.numero, documento_cruce_id: doc.documento_id });
      }
      lineasCxc.push({ cuenta_id: doc.cuenta_id, tercero_id: terceroId, credito: deCentavos(total), documento_cruce: doc.numero, documento_cruce_id: doc.documento_id });
      aplicar.push({ doc, pagado, retenido, rets });
    }
    if (!consignado) throw badRequest('El recibo no tiene plata consignada: escriba lo que se pagó.');

    const recibo = (await db.query(
      `INSERT INTO sst.recibos_caja (tercero_id, fecha, cuenta_banco_id, valor_consignado, observaciones, creado_por)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [terceroId, fecha, banco.id, deCentavos(consignado), b.observaciones ? String(b.observaciones).trim().slice(0, 1000) : null, usuarioId],
    )).rows[0];
    const nombre = (await db.query(`SELECT ${NOMBRE} AS n FROM sst.terceros t WHERE id = $1`, [terceroId])).rows[0].n;
    // Mismo orden que el auxiliar de Siigo: banco, clientes, retenciones.
    const comp = await crearComprobante({
      tipo: 'RC', fecha, descripcion: `Recibo de caja · ${nombre}`,
      lineas: [{ cuenta_id: banco.id, tercero_id: terceroId, debito: deCentavos(consignado), descripcion: 'Consignación' }, ...lineasCxc, ...lineasRet],
      origen_tipo: 'RECIBO_CAJA', origen_id: recibo.id, contabilizar: true,
    }, usuarioId, { client: db });
    await db.query(`UPDATE sst.recibos_caja SET comprobante_id = $2 WHERE id = $1`, [recibo.id, comp.id]);

    for (const a of aplicar) {
      const ap = (await db.query(
        `INSERT INTO sst.cartera_aplicaciones (cartera_documento_id, origen_tipo, origen_id, fecha, valor_pagado, valor_retenciones)
         VALUES ($1, 'RECIBO_CAJA', $2, $3, $4, $5) RETURNING id`,
        [a.doc.id, recibo.id, fecha, deCentavos(a.pagado), deCentavos(a.retenido)],
      )).rows[0];
      for (const r of a.rets) {
        await db.query(
          `INSERT INTO sst.cartera_aplicacion_retenciones (aplicacion_id, retencion_id, cuenta_id, base, valor) VALUES ($1, $2, $3, $4, $5)`,
          [ap.id, r.id, r.cuenta_id, r.base != null ? deCentavos(r.base) : null, deCentavos(r.valor)],
        );
      }
      await db.query(`UPDATE sst.cartera_documentos SET saldo = saldo - $2 WHERE id = $1`, [a.doc.id, deCentavos(a.pagado + a.retenido)]);
    }
    return obtenerRecibo(recibo.id, db);
  });
}

export async function obtenerRecibo(id, db = pool) {
  const r = (await db.query(
    `SELECT rc.id, rc.tercero_id, ${NOMBRE} AS tercero_nombre, to_char(rc.fecha, 'YYYY-MM-DD') AS fecha,
            rc.cuenta_banco_id, cb.codigo AS cuenta_banco_codigo, cb.nombre AS cuenta_banco_nombre,
            rc.valor_consignado, rc.observaciones, rc.estado, rc.motivo_anulacion, rc.comprobante_id,
            CASE WHEN cp.numero IS NULL THEN NULL ELSE 'RC-' || cp.numero END AS numero
       FROM sst.recibos_caja rc
       JOIN sst.terceros t ON t.id = rc.tercero_id
       JOIN sst.cuentas_contables cb ON cb.id = rc.cuenta_banco_id
       LEFT JOIN sst.comprobantes cp ON cp.id = rc.comprobante_id
      WHERE rc.id = $1`,
    [id],
  )).rows[0];
  if (!r) throw notFound('Ese recibo no existe.');
  const aplicaciones = (await db.query(
    `SELECT a.id, c.numero, a.valor_pagado, a.valor_retenciones, a.anulada,
            COALESCE(json_agg(json_build_object('retencion', rt.codigo, 'nombre', rt.nombre, 'valor', ar.valor)) FILTER (WHERE ar.id IS NOT NULL), '[]') AS retenciones
       FROM sst.cartera_aplicaciones a
       JOIN sst.cartera_documentos c ON c.id = a.cartera_documento_id
       LEFT JOIN sst.cartera_aplicacion_retenciones ar ON ar.aplicacion_id = a.id
       LEFT JOIN sst.retenciones rt ON rt.id = ar.retencion_id
      WHERE a.origen_tipo = 'RECIBO_CAJA' AND a.origen_id = $1
      GROUP BY a.id, c.numero ORDER BY c.numero`,
    [id],
  )).rows;
  return { ...r, aplicaciones };
}

export async function listarRecibos({ terceroId = null, desde = null, hasta = null } = {}) {
  const r = await pool.query(
    `SELECT rc.id, ${NOMBRE} AS tercero_nombre, to_char(rc.fecha, 'YYYY-MM-DD') AS fecha, rc.valor_consignado, rc.estado,
            CASE WHEN cp.numero IS NULL THEN NULL ELSE 'RC-' || cp.numero END AS numero,
            (SELECT COALESCE(sum(a.valor_retenciones), 0) FROM sst.cartera_aplicaciones a WHERE a.origen_tipo = 'RECIBO_CAJA' AND a.origen_id = rc.id) AS retenido,
            (SELECT string_agg(c.numero, ', ' ORDER BY c.numero) FROM sst.cartera_aplicaciones a JOIN sst.cartera_documentos c ON c.id = a.cartera_documento_id
              WHERE a.origen_tipo = 'RECIBO_CAJA' AND a.origen_id = rc.id) AS facturas
       FROM sst.recibos_caja rc
       JOIN sst.terceros t ON t.id = rc.tercero_id
       LEFT JOIN sst.comprobantes cp ON cp.id = rc.comprobante_id
      WHERE ($1::uuid IS NULL OR rc.tercero_id = $1) AND ($2::date IS NULL OR rc.fecha >= $2) AND ($3::date IS NULL OR rc.fecha <= $3)
      ORDER BY rc.fecha DESC, rc.creado_en DESC LIMIT 500`,
    [terceroId, desde || null, hasta || null],
  );
  return r.rows;
}

/**
 * Anula un recibo: anula su comprobante RC (queda con su número), marca sus
 * aplicaciones como anuladas y devuelve el saldo a cada factura.
 */
export async function anularRecibo(id, motivo, usuarioId = null, { client = null } = {}) {
  const texto = String(motivo ?? '').trim();
  if (texto.length < 5) throw badRequest('Escriba el motivo de la anulación.');
  return conTransaccion(client, async (db) => {
    const r = (await db.query(`SELECT id, estado, comprobante_id FROM sst.recibos_caja WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!r) throw notFound('Ese recibo no existe.');
    if (r.estado !== 'CONTABILIZADO') throw conflict('El recibo ya está anulado.');
    await anularComprobante(r.comprobante_id, texto, usuarioId, { client: db, permitirOrigen: true });
    const aps = (await db.query(
      `UPDATE sst.cartera_aplicaciones SET anulada = true
        WHERE origen_tipo = 'RECIBO_CAJA' AND origen_id = $1 AND NOT anulada
        RETURNING cartera_documento_id, valor_pagado + valor_retenciones AS total`,
      [id],
    )).rows;
    for (const a of aps) {
      await db.query(`UPDATE sst.cartera_documentos SET saldo = saldo + $2 WHERE id = $1`, [a.cartera_documento_id, a.total]);
    }
    await db.query(
      `UPDATE sst.recibos_caja SET estado = 'ANULADO', motivo_anulacion = $2, anulado_por = $3, anulado_en = now() WHERE id = $1`,
      [id, texto, usuarioId],
    );
    return obtenerRecibo(id, db);
  });
}

/**
 * Backfill: abre la cartera de las facturas que se contabilizaron antes de que
 * existiera B3-01 y aplica sus notas crédito. Idempotente.
 */
export async function sincronizarCartera(db = pool) {
  const facturas = (await db.query(
    `SELECT d.id, (SELECT m.cuenta_id FROM sst.movimientos m JOIN sst.cuentas_contables cc ON cc.id = m.cuenta_id
                    WHERE m.comprobante_id = d.comprobante_id AND cc.es_cartera = 'CXC' AND m.debito > 0 LIMIT 1) AS cuenta_id
       FROM sst.documentos_electronicos d
      WHERE d.tipo = 'FACTURA' AND d.comprobante_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM sst.cartera_documentos c WHERE c.documento_id = d.id)
      ORDER BY d.fecha_emision, d.creado_en`,
  )).rows;
  let abiertas = 0;
  for (const f of facturas) {
    if (!f.cuenta_id) continue;
    if (await abrirCarteraDeFactura(db, f.id, f.cuenta_id)) abiertas++;
  }
  const notas = (await db.query(
    `SELECT d.id FROM sst.documentos_electronicos d
      WHERE d.tipo = 'NOTA_CREDITO' AND d.comprobante_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM sst.cartera_aplicaciones a WHERE a.origen_tipo = 'NOTA_CREDITO' AND a.origen_id = d.id AND NOT a.anulada)
      ORDER BY d.fecha_emision, d.creado_en`,
  )).rows;
  for (const n of notas) await aplicarNotaCredito(db, n.id);
  return { facturas_abiertas: abiertas, notas_aplicadas: notas.length };
}
