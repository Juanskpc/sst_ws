import { pool, withTransaction } from '../../config/db.js';
import { badRequest, conflict, notFound } from '../../utils/httpError.js';
import { aCentavos, deCentavos } from '../../utils/dinero.js';
import { anularComprobante, crearComprobante } from '../contabilidad/comprobantes.service.js';
import { resolvedorDeCuentas } from '../contabilidad/reglas.service.js';

/**
 * B4-01 (CXP-01..04, CNT-04) · Anticipos a proveedores y comprobantes de egreso.
 *
 * El espejo del recibo de caja:
 *   Anticipo (RP, como RP-1-2):   D  anticipos a proveedores (13300501)   C  banco
 *   Egreso (CE):                  D  cuenta por pagar de cada obligación (lo que se cancela)
 *                                 C  banco (lo que sale)
 *                                 C  retención que JD&D practica al pagar (a la cuenta de la retención)
 *                                 C  anticipos a proveedores (lo que se cruza de anticipos anteriores)
 */

const NOMBRE = `COALESCE(t.razon_social, NULLIF(btrim(concat_ws(' ', t.nombres, t.apellidos)), ''))`;
const conTransaccion = (client, fn) => (client ? fn(client) : withTransaction(fn));
const fecha = (v) => {
  const f = String(v ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) throw badRequest('La fecha no es válida.');
  return f;
};
const importe = (v, texto) => {
  const c = v == null || v === '' ? 0 : aCentavos(v);
  if (!Number.isFinite(c) || c < 0) throw badRequest(`${texto}: el valor no es válido.`);
  return c;
};
async function banco(db, id) {
  const b = (await db.query(`SELECT id, codigo FROM sst.cuentas_contables WHERE id = $1 AND es_banco AND acepta_movimiento AND activa`, [id])).rows[0];
  if (!b) throw badRequest('Elija la cuenta de banco de donde sale la plata (una cuenta marcada como banco en el plan).');
  return b;
}
const nombreTercero = async (db, id) => (await db.query(`SELECT ${NOMBRE} AS n FROM sst.terceros t WHERE id = $1`, [id])).rows[0]?.n;

// ─── Anticipos ────────────────────────────────────────────────────────────────

export async function crearAnticipo(b = {}, usuarioId = null, { client = null } = {}) {
  return conTransaccion(client, async (db) => {
    const nombre = await nombreTercero(db, b.tercero_id);
    if (!nombre) throw badRequest('Elija el proveedor.');
    const f = fecha(b.fecha);
    const cb = await banco(db, b.cuenta_banco_id);
    const valor = importe(b.valor, 'Anticipo');
    if (!valor) throw badRequest('Escriba el valor del anticipo.');
    const cuentaAnticipo = (await resolvedorDeCuentas(db, b.tercero_id))('CE_ANTICIPO');
    const a = (await db.query(
      `INSERT INTO sst.anticipos_proveedor (tercero_id, fecha, cuenta_banco_id, cuenta_id, valor, saldo, observaciones, creado_por)
       VALUES ($1, $2, $3, $4, $5, $5, $6, $7) RETURNING id`,
      [b.tercero_id, f, cb.id, cuentaAnticipo, deCentavos(valor), String(b.observaciones ?? '').trim().slice(0, 1000) || null, usuarioId],
    )).rows[0];
    const comp = await crearComprobante({
      tipo: 'RP', fecha: f, descripcion: `Anticipo · ${nombre}`,
      lineas: [
        { cuenta_id: cuentaAnticipo, tercero_id: b.tercero_id, debito: deCentavos(valor), descripcion: 'Anticipo' },
        { cuenta_id: cb.id, tercero_id: b.tercero_id, credito: deCentavos(valor) },
      ],
      origen_tipo: 'ANTICIPO', origen_id: a.id, contabilizar: true,
    }, usuarioId, { client: db });
    await db.query(`UPDATE sst.anticipos_proveedor SET comprobante_id = $2 WHERE id = $1`, [a.id, comp.id]);
    return obtenerAnticipo(a.id, db);
  });
}

export async function obtenerAnticipo(id, db = pool) {
  const a = (await db.query(
    `SELECT a.id, a.tercero_id, ${NOMBRE} AS tercero_nombre, to_char(a.fecha, 'YYYY-MM-DD') AS fecha, a.valor, a.saldo,
            a.observaciones, a.estado, a.motivo_anulacion, 'RP-' || cp.numero AS numero
       FROM sst.anticipos_proveedor a JOIN sst.terceros t ON t.id = a.tercero_id
       LEFT JOIN sst.comprobantes cp ON cp.id = a.comprobante_id WHERE a.id = $1`,
    [id],
  )).rows[0];
  if (!a) throw notFound('Ese anticipo no existe.');
  return a;
}

export async function listarAnticipos({ terceroId = null, conSaldo = false } = {}, db = pool) {
  return (await db.query(
    `SELECT a.id, a.tercero_id, ${NOMBRE} AS tercero_nombre, to_char(a.fecha, 'YYYY-MM-DD') AS fecha, a.valor, a.saldo, a.estado,
            'RP-' || cp.numero AS numero
       FROM sst.anticipos_proveedor a JOIN sst.terceros t ON t.id = a.tercero_id
       LEFT JOIN sst.comprobantes cp ON cp.id = a.comprobante_id
      WHERE ($1::uuid IS NULL OR a.tercero_id = $1) AND (NOT $2 OR (a.saldo > 0 AND a.estado = 'CONTABILIZADO'))
      ORDER BY a.fecha, a.creado_en`,
    [terceroId, conSaldo],
  )).rows;
}

/** Un anticipo se anula solo si no se ha cruzado (con cruces, primero se anula el egreso). */
export async function anularAnticipo(id, motivo, usuarioId = null) {
  const texto = String(motivo ?? '').trim();
  if (texto.length < 5) throw badRequest('Escriba el motivo de la anulación.');
  return withTransaction(async (db) => {
    const a = (await db.query(`SELECT id, estado, valor, saldo, comprobante_id FROM sst.anticipos_proveedor WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!a) throw notFound('Ese anticipo no existe.');
    if (a.estado !== 'CONTABILIZADO') throw conflict('El anticipo ya está anulado.');
    if (a.saldo !== a.valor) throw conflict('El anticipo ya se cruzó en un egreso: anule primero ese egreso.');
    await anularComprobante(a.comprobante_id, texto, usuarioId, { client: db, permitirOrigen: true });
    await db.query(`UPDATE sst.anticipos_proveedor SET estado = 'ANULADO', saldo = 0, motivo_anulacion = $2 WHERE id = $1`, [id, texto]);
    return obtenerAnticipo(id, db);
  });
}

// ─── Egresos ──────────────────────────────────────────────────────────────────

/**
 * Lo que se le propone a la persona al pagar a un proveedor: sus obligaciones
 * abiertas y el anticipo que tiene disponible para cruzar.
 */
export async function propuestaEgreso(terceroId, db = pool) {
  const obligaciones = (await db.query(
    `SELECT c.id, c.numero, to_char(c.fecha, 'YYYY-MM-DD') AS fecha, to_char(c.vencimiento, 'YYYY-MM-DD') AS vencimiento, c.valor, c.saldo
       FROM sst.cartera_documentos c WHERE c.tipo = 'CXP' AND c.tercero_id = $1 AND c.saldo > 0 ORDER BY c.vencimiento, c.numero`,
    [terceroId],
  )).rows;
  const anticipos = await listarAnticipos({ terceroId, conSaldo: true }, db);
  const disponible = anticipos.reduce((s, a) => s + aCentavos(a.saldo), 0);
  return { obligaciones, anticipos, anticipo_disponible: deCentavos(disponible) };
}

/**
 * Registra el egreso y lo contabiliza (CE).
 * aplicaciones: [{ cartera_documento_id, valor_pagado, valor_anticipo?, retenciones: [{ retencion_id, valor, base? }] }]
 * Lo cruzado con anticipos se toma de los anticipos abiertos del proveedor, del más
 * antiguo al más nuevo.
 */
export async function crearEgreso(b = {}, usuarioId = null, { client = null } = {}) {
  return conTransaccion(client, async (db) => {
    const terceroId = b.tercero_id;
    const nombre = await nombreTercero(db, terceroId);
    if (!nombre) throw badRequest('Elija el proveedor al que se le paga.');
    const f = fecha(b.fecha);
    const aplicaciones = Array.isArray(b.aplicaciones) ? b.aplicaciones.filter((a) => a?.cartera_documento_id) : [];
    if (!aplicaciones.length) throw badRequest('Elija al menos una cuenta por pagar.');

    let pagado = 0;
    let anticipoTotal = 0;
    const lineasCxp = [];
    const lineasRet = [];
    const aplicar = [];
    const vistos = new Set();
    for (const a of aplicaciones) {
      if (vistos.has(a.cartera_documento_id)) throw badRequest('Una misma obligación aparece dos veces en el egreso.');
      vistos.add(a.cartera_documento_id);
      const doc = (await db.query(
        `SELECT id, tercero_id, numero, saldo, cuenta_id FROM sst.cartera_documentos WHERE id = $1 AND tipo = 'CXP' FOR UPDATE`,
        [a.cartera_documento_id],
      )).rows[0];
      if (!doc) throw badRequest('Esa obligación no está en las cuentas por pagar.');
      if (doc.tercero_id !== terceroId) throw badRequest(`${doc.numero} es de otro proveedor.`);
      const p = importe(a.valor_pagado, doc.numero);
      const ant = importe(a.valor_anticipo, doc.numero);
      const rets = [];
      for (const r of a.retenciones ?? []) {
        const v = importe(r.valor, doc.numero);
        if (!v) continue;
        const def = (await db.query(
          `SELECT r.id, r.codigo, r.nombre, r.aplica_a, r.cuenta_id, c.codigo AS cuenta_codigo
             FROM sst.retenciones r LEFT JOIN sst.cuentas_contables c ON c.id = r.cuenta_id AND c.acepta_movimiento AND c.activa
            WHERE r.id = $1`,
          [r.retencion_id],
        )).rows[0];
        if (!def) throw badRequest(`${doc.numero}: elija qué retención se practicó.`);
        if (def.aplica_a !== 'COMPRA') throw badRequest(`${def.codigo} es una retención de venta; al pagar se practican las de compra.`);
        if (!def.cuenta_codigo) throw badRequest(`La retención ${def.codigo} no tiene cuenta contable (Parametrización → Retenciones).`);
        rets.push({ ...def, valor: v, base: r.base == null || r.base === '' ? null : importe(r.base, def.codigo) });
      }
      const retenido = rets.reduce((s, r) => s + r.valor, 0);
      const total = p + ant + retenido;
      if (!total) throw badRequest(`${doc.numero}: escriba lo que se paga.`);
      if (total > aCentavos(doc.saldo)) throw badRequest(`${doc.numero}: lo pagado, cruzado y retenido (${deCentavos(total)}) supera su saldo (${doc.saldo}).`);
      pagado += p;
      anticipoTotal += ant;
      lineasCxp.push({ cuenta_id: doc.cuenta_id, tercero_id: terceroId, debito: deCentavos(total), documento_cruce: doc.numero });
      for (const r of rets) {
        lineasRet.push({ cuenta_id: r.cuenta_id, tercero_id: terceroId, credito: deCentavos(r.valor), base: r.base != null ? deCentavos(r.base) : null,
          descripcion: r.nombre, documento_cruce: doc.numero });
      }
      aplicar.push({ doc, p, ant, retenido, rets });
    }

    // Anticipos a cruzar: del más antiguo al más nuevo.
    const cruces = [];
    if (anticipoTotal) {
      let falta = anticipoTotal;
      const abiertos = (await db.query(
        `SELECT id, saldo, cuenta_id FROM sst.anticipos_proveedor
          WHERE tercero_id = $1 AND estado = 'CONTABILIZADO' AND saldo > 0 ORDER BY fecha, creado_en FOR UPDATE`,
        [terceroId],
      )).rows;
      for (const an of abiertos) {
        if (!falta) break;
        const usa = Math.min(falta, aCentavos(an.saldo));
        cruces.push({ ...an, usa });
        falta -= usa;
      }
      if (falta) throw badRequest(`El proveedor solo tiene ${deCentavos(anticipoTotal - falta)} en anticipos para cruzar.`);
    }
    const cb = pagado ? await banco(db, b.cuenta_banco_id) : null;

    const egreso = (await db.query(
      `INSERT INTO sst.egresos (tercero_id, fecha, cuenta_banco_id, valor_pagado, valor_anticipos, observaciones, creado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [terceroId, f, cb?.id ?? null, deCentavos(pagado), deCentavos(anticipoTotal), String(b.observaciones ?? '').trim().slice(0, 1000) || null, usuarioId],
    )).rows[0];
    // Una línea de anticipo por cada cuenta de anticipo usada (normalmente una sola).
    const porCuentaAnticipo = new Map();
    for (const c of cruces) porCuentaAnticipo.set(c.cuenta_id, (porCuentaAnticipo.get(c.cuenta_id) ?? 0) + c.usa);
    const lineas = [
      ...lineasCxp,
      ...(pagado ? [{ cuenta_id: cb.id, tercero_id: terceroId, credito: deCentavos(pagado), descripcion: 'Pago' }] : []),
      ...lineasRet,
      ...[...porCuentaAnticipo].map(([cuentaId, v]) => ({ cuenta_id: cuentaId, tercero_id: terceroId, credito: deCentavos(v), descripcion: 'Cruce de anticipo' })),
    ];
    const comp = await crearComprobante({
      tipo: 'CE', fecha: f, descripcion: `Egreso · ${nombre}`, lineas, origen_tipo: 'EGRESO', origen_id: egreso.id, contabilizar: true,
    }, usuarioId, { client: db });
    await db.query(`UPDATE sst.egresos SET comprobante_id = $2 WHERE id = $1`, [egreso.id, comp.id]);

    for (const c of cruces) {
      await db.query(`INSERT INTO sst.egreso_anticipos (egreso_id, anticipo_id, valor) VALUES ($1, $2, $3)`, [egreso.id, c.id, deCentavos(c.usa)]);
      await db.query(`UPDATE sst.anticipos_proveedor SET saldo = saldo - $2 WHERE id = $1`, [c.id, deCentavos(c.usa)]);
    }
    for (const a of aplicar) {
      const ap = (await db.query(
        `INSERT INTO sst.cartera_aplicaciones (cartera_documento_id, origen_tipo, origen_id, fecha, valor_pagado, valor_retenciones, valor_anticipo)
         VALUES ($1, 'EGRESO', $2, $3, $4, $5, $6) RETURNING id`,
        [a.doc.id, egreso.id, f, deCentavos(a.p), deCentavos(a.retenido), deCentavos(a.ant)],
      )).rows[0];
      for (const r of a.rets) {
        await db.query(
          `INSERT INTO sst.cartera_aplicacion_retenciones (aplicacion_id, retencion_id, cuenta_id, base, valor) VALUES ($1, $2, $3, $4, $5)`,
          [ap.id, r.id, r.cuenta_id, r.base != null ? deCentavos(r.base) : null, deCentavos(r.valor)],
        );
      }
      await db.query(`UPDATE sst.cartera_documentos SET saldo = saldo - $2 WHERE id = $1`, [a.doc.id, deCentavos(a.p + a.ant + a.retenido)]);
    }
    return obtenerEgreso(egreso.id, db);
  });
}

export async function obtenerEgreso(id, db = pool) {
  const e = (await db.query(
    `SELECT e.id, e.tercero_id, ${NOMBRE} AS tercero_nombre, to_char(e.fecha, 'YYYY-MM-DD') AS fecha, e.valor_pagado, e.valor_anticipos,
            e.observaciones, e.estado, e.motivo_anulacion, e.comprobante_id, 'CE-' || cp.numero AS numero,
            cb.codigo AS cuenta_banco_codigo, cb.nombre AS cuenta_banco_nombre
       FROM sst.egresos e JOIN sst.terceros t ON t.id = e.tercero_id
       LEFT JOIN sst.comprobantes cp ON cp.id = e.comprobante_id
       LEFT JOIN sst.cuentas_contables cb ON cb.id = e.cuenta_banco_id
      WHERE e.id = $1`,
    [id],
  )).rows[0];
  if (!e) throw notFound('Ese egreso no existe.');
  const aplicaciones = (await db.query(
    `SELECT a.id, c.numero, a.valor_pagado, a.valor_retenciones, a.valor_anticipo, a.anulada
       FROM sst.cartera_aplicaciones a JOIN sst.cartera_documentos c ON c.id = a.cartera_documento_id
      WHERE a.origen_tipo = 'EGRESO' AND a.origen_id = $1 ORDER BY c.numero`,
    [id],
  )).rows;
  return { ...e, aplicaciones };
}

export async function listarEgresos({ terceroId = null } = {}) {
  return (await pool.query(
    `SELECT e.id, ${NOMBRE} AS tercero_nombre, to_char(e.fecha, 'YYYY-MM-DD') AS fecha, e.valor_pagado, e.valor_anticipos, e.estado,
            'CE-' || cp.numero AS numero,
            (SELECT COALESCE(sum(a.valor_retenciones), 0) FROM sst.cartera_aplicaciones a WHERE a.origen_tipo = 'EGRESO' AND a.origen_id = e.id) AS retenido,
            (SELECT string_agg(c.numero, ', ' ORDER BY c.numero) FROM sst.cartera_aplicaciones a JOIN sst.cartera_documentos c ON c.id = a.cartera_documento_id
              WHERE a.origen_tipo = 'EGRESO' AND a.origen_id = e.id) AS obligaciones
       FROM sst.egresos e JOIN sst.terceros t ON t.id = e.tercero_id
       LEFT JOIN sst.comprobantes cp ON cp.id = e.comprobante_id
      WHERE ($1::uuid IS NULL OR e.tercero_id = $1)
      ORDER BY e.fecha DESC, e.creado_en DESC LIMIT 500`,
    [terceroId],
  )).rows;
}

/** Anula el egreso: su CE, sus aplicaciones (vuelven los saldos) y los cruces de anticipo. */
export async function anularEgreso(id, motivo, usuarioId = null, { client = null } = {}) {
  const texto = String(motivo ?? '').trim();
  if (texto.length < 5) throw badRequest('Escriba el motivo de la anulación.');
  return conTransaccion(client, async (db) => {
    const e = (await db.query(`SELECT id, estado, comprobante_id FROM sst.egresos WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!e) throw notFound('Ese egreso no existe.');
    if (e.estado !== 'CONTABILIZADO') throw conflict('El egreso ya está anulado.');
    await anularComprobante(e.comprobante_id, texto, usuarioId, { client: db, permitirOrigen: true });
    const aps = (await db.query(
      `UPDATE sst.cartera_aplicaciones SET anulada = true WHERE origen_tipo = 'EGRESO' AND origen_id = $1 AND NOT anulada
        RETURNING cartera_documento_id, valor_pagado + valor_retenciones + valor_anticipo AS total`,
      [id],
    )).rows;
    for (const a of aps) await db.query(`UPDATE sst.cartera_documentos SET saldo = saldo + $2 WHERE id = $1`, [a.cartera_documento_id, a.total]);
    const cruces = (await db.query(`SELECT anticipo_id, valor FROM sst.egreso_anticipos WHERE egreso_id = $1`, [id])).rows;
    for (const c of cruces) await db.query(`UPDATE sst.anticipos_proveedor SET saldo = saldo + $2 WHERE id = $1`, [c.anticipo_id, c.valor]);
    await db.query(`DELETE FROM sst.egreso_anticipos WHERE egreso_id = $1`, [id]);
    await db.query(
      `UPDATE sst.egresos SET estado = 'ANULADO', motivo_anulacion = $2, anulado_por = $3, anulado_en = now() WHERE id = $1`,
      [id, texto, usuarioId],
    );
    return obtenerEgreso(id, db);
  });
}
