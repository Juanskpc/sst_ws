import { pool, withTransaction } from '../../config/db.js';
import { badRequest, conflict, notFound } from '../../utils/httpError.js';
import { aCentavos, deCentavos } from '../../utils/dinero.js';
import { anularComprobante, crearComprobante } from '../contabilidad/comprobantes.service.js';
import { resolvedorDeCuentas } from '../contabilidad/reglas.service.js';

/**
 * B5-01 (CYG-01..03) · Compras, servicios y gastos internos.
 *
 * Registrar una compra es contabilizarla en el acto — como hace Siigo con FC-1-10
 * (gasto 51953501 D / cuenta por pagar 23359501 C) — y, si es a crédito, abrir su
 * cuenta por pagar (B4-01), que luego salda el egreso:
 *
 *   D  gasto o costo de cada ítem (la cuenta se elige al registrar)
 *   D  IVA descontable (si el proveedor lo cobró)
 *   C  retención que JD&D le practica (retefuente, ReteIVA… a la cuenta de la retención)
 *   C  cuenta por pagar (a crédito) · o banco/caja (de contado)
 *
 * El gasto interno (combustible, compras menores sin factura electrónica) no va a
 * la DIAN y se registra como CG en vez de FC.
 */

const TIPOS = ['COMPRA', 'SERVICIO', 'SERVICIO_PROFESIONAL', 'GASTO_INTERNO'];
const NOMBRE = `COALESCE(t.razon_social, NULLIF(btrim(concat_ws(' ', t.nombres, t.apellidos)), ''))`;
const conTransaccion = (client, fn) => (client ? fn(client) : withTransaction(fn));

const fecha = (v, campo) => {
  const f = String(v ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) throw badRequest(`La ${campo} no es válida (AAAA-MM-DD).`);
  return f;
};
const importe = (v, texto) => {
  const c = v == null || v === '' ? 0 : aCentavos(v);
  if (!Number.isFinite(c) || c < 0) throw badRequest(`${texto}: el valor no es válido.`);
  return c;
};

async function cuentaDeMovimiento(db, id, texto) {
  const c = (await db.query(`SELECT id, codigo, acepta_movimiento, activa, es_banco FROM sst.cuentas_contables WHERE id = $1`, [id])).rows[0];
  if (!c) throw badRequest(`${texto}: elija una cuenta del plan de cuentas.`);
  if (!c.acepta_movimiento || !c.activa) throw badRequest(`${texto}: la cuenta ${c.codigo} no recibe movimiento (o está inactiva).`);
  return c;
}

/**
 * Registra y contabiliza una compra.
 * Cuerpo: { tipo, tercero_id, numero_proveedor?, cufe?, fecha, forma_pago: CREDITO|CONTADO,
 *           vencimiento? (crédito), cuenta_pago_id? (contado), descripcion?,
 *           items: [{ cuenta_id, descripcion, valor, iva_pct? }],
 *           retenciones: [{ retencion_id, base?, valor? }] }
 * La retención sin `valor` se calcula: tarifa sobre la base (por defecto, el subtotal), al peso.
 */
export async function crearCompra(b = {}, usuarioId = null, { client = null } = {}) {
  return conTransaccion(client, async (db) => {
    const tipo = String(b.tipo ?? '').toUpperCase();
    if (!TIPOS.includes(tipo)) throw badRequest('Elija el tipo: compra, servicio, servicio profesional o gasto interno.');
    const tercero = (await db.query(`SELECT id, ${NOMBRE} AS nombre, activo FROM sst.terceros t WHERE id = $1`, [b.tercero_id])).rows[0];
    if (!tercero) throw badRequest('Elija el proveedor.');
    if (!tercero.activo) throw badRequest(`${tercero.nombre} está inactivo en Terceros.`);
    const numeroProveedor = String(b.numero_proveedor ?? '').trim().toUpperCase() || null;
    if (tipo !== 'GASTO_INTERNO' && !numeroProveedor) throw badRequest('Escriba el número de la factura del proveedor.');
    const f = fecha(b.fecha, 'fecha de la compra');
    const forma = String(b.forma_pago ?? 'CREDITO').toUpperCase();
    if (!['CREDITO', 'CONTADO'].includes(forma)) throw badRequest('La forma de pago es a crédito o de contado.');
    let vencimiento = null;
    let cuentaPago = null;
    if (forma === 'CREDITO') {
      vencimiento = fecha(b.vencimiento || f, 'fecha de vencimiento');
      if (vencimiento < f) throw badRequest('El vencimiento no puede ser anterior a la fecha de la compra.');
    } else {
      cuentaPago = await cuentaDeMovimiento(db, b.cuenta_pago_id, 'De contado');
    }
    if (numeroProveedor) {
      const dup = await db.query(
        `SELECT 1 FROM sst.compras WHERE tercero_id = $1 AND upper(numero_proveedor) = $2 AND estado <> 'ANULADO'`, [tercero.id, numeroProveedor],
      );
      if (dup.rows[0]) throw conflict(`La factura ${numeroProveedor} de ${tercero.nombre} ya está registrada.`);
    }

    const items = Array.isArray(b.items) ? b.items.filter((i) => i && (i.cuenta_id || i.valor)) : [];
    if (!items.length) throw badRequest('La compra necesita al menos un ítem.');
    const itemsOk = [];
    for (const [n, it] of items.entries()) {
      const cuenta = await cuentaDeMovimiento(db, it.cuenta_id, `Ítem ${n + 1}`);
      const valor = importe(it.valor, `Ítem ${n + 1}`);
      if (!valor) throw badRequest(`Ítem ${n + 1}: escriba el valor.`);
      const ivaPct = it.iva_pct == null || it.iva_pct === '' ? 0 : Number(it.iva_pct);
      if (!Number.isFinite(ivaPct) || ivaPct < 0 || ivaPct > 100) throw badRequest(`Ítem ${n + 1}: el IVA no es válido.`);
      const descripcion = String(it.descripcion ?? '').trim() || `Ítem ${n + 1}`;
      itemsOk.push({ cuenta_id: cuenta.id, descripcion: descripcion.slice(0, 500), valor, iva_pct: ivaPct, iva: Math.round((valor * ivaPct) / 100) });
    }
    const subtotal = itemsOk.reduce((s, i) => s + i.valor, 0);
    const iva = itemsOk.reduce((s, i) => s + i.iva, 0);

    const retOk = [];
    for (const r of Array.isArray(b.retenciones) ? b.retenciones.filter((x) => x?.retencion_id) : []) {
      const def = (await db.query(
        `SELECT r.id, r.codigo, r.nombre, r.tipo, r.tarifa, r.aplica_a, r.activa, r.cuenta_id, c.codigo AS cuenta_codigo
           FROM sst.retenciones r LEFT JOIN sst.cuentas_contables c ON c.id = r.cuenta_id AND c.acepta_movimiento AND c.activa
          WHERE r.id = $1`,
        [r.retencion_id],
      )).rows[0];
      if (!def || !def.activa) throw badRequest('Esa retención no existe o está inactiva.');
      if (def.aplica_a !== 'COMPRA') throw badRequest(`${def.codigo} es una retención de venta; en una compra van las que JD&D practica.`);
      if (!def.cuenta_codigo) throw badRequest(`La retención ${def.codigo} no tiene cuenta contable (Parametrización → Retenciones).`);
      // La ReteIVA se calcula sobre el IVA; las demás, sobre el subtotal.
      const base = r.base != null && r.base !== '' ? importe(r.base, def.codigo) : (def.tipo === 'RETEIVA' ? iva : subtotal);
      const valor = r.valor != null && r.valor !== '' ? importe(r.valor, def.codigo) : Math.round((base * Number(def.tarifa)) / 100 / 100) * 100;
      if (!valor) continue;
      retOk.push({ ...def, base, valor });
    }
    const retenciones = retOk.reduce((s, r) => s + r.valor, 0);
    const total = subtotal + iva - retenciones;
    if (total <= 0) throw badRequest('Las retenciones no pueden igualar o superar el valor de la compra.');

    const compra = (await db.query(
      `INSERT INTO sst.compras (tipo, tercero_id, numero_proveedor, cufe, fecha, forma_pago, vencimiento, cuenta_pago_id,
                                descripcion, subtotal, total_iva, total_retenciones, total_a_pagar, creado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [tipo, tercero.id, numeroProveedor, String(b.cufe ?? '').trim() || null, f, forma, vencimiento, cuentaPago?.id ?? null,
       String(b.descripcion ?? '').trim().slice(0, 1000) || null, deCentavos(subtotal), deCentavos(iva), deCentavos(retenciones), deCentavos(total), usuarioId],
    )).rows[0];
    for (const [n, it] of itemsOk.entries()) {
      await db.query(
        `INSERT INTO sst.compra_items (compra_id, orden, cuenta_id, descripcion, valor, iva_pct, iva_valor) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [compra.id, n, it.cuenta_id, it.descripcion, deCentavos(it.valor), it.iva_pct, deCentavos(it.iva)],
      );
    }
    for (const r of retOk) {
      await db.query(
        `INSERT INTO sst.compra_retenciones (compra_id, retencion_id, cuenta_id, base, tarifa, valor) VALUES ($1,$2,$3,$4,$5,$6)`,
        [compra.id, r.id, r.cuenta_id, deCentavos(r.base), r.tarifa, deCentavos(r.valor)],
      );
    }

    // ── Asiento ──
    const cuenta = await resolvedorDeCuentas(db, tercero.id);
    const cruce = numeroProveedor ?? null;
    const lineas = itemsOk.map((it) => ({ cuenta_id: it.cuenta_id, tercero_id: tercero.id, debito: deCentavos(it.valor), descripcion: it.descripcion, documento_cruce: cruce }));
    if (iva) lineas.push({ cuenta_id: cuenta('CP_IVA_DESCONTABLE'), tercero_id: tercero.id, debito: deCentavos(iva), base: deCentavos(subtotal), documento_cruce: cruce });
    for (const r of retOk) {
      lineas.push({ cuenta_id: r.cuenta_id, tercero_id: tercero.id, credito: deCentavos(r.valor), base: deCentavos(r.base), descripcion: r.nombre, documento_cruce: cruce });
    }
    const cuentaCxp = forma === 'CREDITO' ? cuenta(tipo === 'SERVICIO_PROFESIONAL' ? 'CP_CXP_HONORARIOS' : 'CP_CXP') : null;
    lineas.push({ cuenta_id: cuentaCxp ?? cuentaPago.id, tercero_id: tercero.id, credito: deCentavos(total), documento_cruce: cruce });

    const comp = await crearComprobante({
      tipo: tipo === 'GASTO_INTERNO' ? 'CG' : 'FC', fecha: f,
      descripcion: `${tipo === 'GASTO_INTERNO' ? 'Gasto' : 'Compra'} ${numeroProveedor ?? ''} · ${tercero.nombre}`.replace(/\s+/g, ' ').trim(),
      lineas, origen_tipo: 'COMPRA', origen_id: compra.id, contabilizar: true,
    }, usuarioId, { client: db });
    await db.query(`UPDATE sst.compras SET comprobante_id = $2 WHERE id = $1`, [compra.id, comp.id]);

    // B4-01 · A crédito abre la cuenta por pagar (el número es el de la factura del proveedor o el del comprobante).
    if (cuentaCxp) {
      await db.query(
        `INSERT INTO sst.cartera_documentos (tipo, tercero_id, compra_id, numero, fecha, vencimiento, valor, saldo, cuenta_id)
         VALUES ('CXP', $1, $2, $3, $4, $5, $6, $6, $7)`,
        [tercero.id, compra.id, numeroProveedor ?? comp.numero_completo, f, vencimiento, deCentavos(total), cuentaCxp],
      );
    }
    return obtenerCompra(compra.id, db);
  });
}

export async function obtenerCompra(id, db = pool) {
  const c = (await db.query(
    `SELECT cm.id, cm.tipo, cm.tercero_id, ${NOMBRE} AS tercero_nombre, cm.numero_proveedor, cm.cufe,
            to_char(cm.fecha, 'YYYY-MM-DD') AS fecha, cm.forma_pago, to_char(cm.vencimiento, 'YYYY-MM-DD') AS vencimiento,
            cm.cuenta_pago_id, cm.descripcion, cm.subtotal, cm.total_iva, cm.total_retenciones, cm.total_a_pagar,
            cm.estado, cm.motivo_anulacion, cm.comprobante_id,
            CASE WHEN cp.numero IS NULL THEN NULL ELSE tc.codigo || '-' || cp.numero END AS comprobante_numero,
            cd.id AS cxp_id, cd.saldo AS cxp_saldo
       FROM sst.compras cm
       JOIN sst.terceros t ON t.id = cm.tercero_id
       LEFT JOIN sst.comprobantes cp ON cp.id = cm.comprobante_id
       LEFT JOIN sst.tipos_comprobante tc ON tc.id = cp.tipo_id
       LEFT JOIN sst.cartera_documentos cd ON cd.compra_id = cm.id AND NOT cd.anulado
      WHERE cm.id = $1`,
    [id],
  )).rows[0];
  if (!c) throw notFound('Esa compra no existe.');
  const items = (await db.query(
    `SELECT i.id, i.cuenta_id, cc.codigo AS cuenta_codigo, cc.nombre AS cuenta_nombre, i.descripcion, i.valor, i.iva_pct, i.iva_valor
       FROM sst.compra_items i JOIN sst.cuentas_contables cc ON cc.id = i.cuenta_id WHERE i.compra_id = $1 ORDER BY i.orden`,
    [id],
  )).rows;
  const retenciones = (await db.query(
    `SELECT r.codigo, r.nombre, cr.base, cr.tarifa, cr.valor FROM sst.compra_retenciones cr JOIN sst.retenciones r ON r.id = cr.retencion_id WHERE cr.compra_id = $1`,
    [id],
  )).rows;
  return { ...c, items, retenciones };
}

export async function listarCompras({ terceroId = null, desde = null, hasta = null, tipo = null } = {}) {
  const r = await pool.query(
    `SELECT cm.id, cm.tipo, ${NOMBRE} AS tercero_nombre, cm.numero_proveedor, to_char(cm.fecha, 'YYYY-MM-DD') AS fecha,
            cm.forma_pago, to_char(cm.vencimiento, 'YYYY-MM-DD') AS vencimiento, cm.total_a_pagar, cm.estado,
            CASE WHEN cp.numero IS NULL THEN NULL ELSE tc.codigo || '-' || cp.numero END AS comprobante_numero,
            cd.saldo AS cxp_saldo
       FROM sst.compras cm
       JOIN sst.terceros t ON t.id = cm.tercero_id
       LEFT JOIN sst.comprobantes cp ON cp.id = cm.comprobante_id
       LEFT JOIN sst.tipos_comprobante tc ON tc.id = cp.tipo_id
       LEFT JOIN sst.cartera_documentos cd ON cd.compra_id = cm.id
      WHERE ($1::uuid IS NULL OR cm.tercero_id = $1) AND ($2::date IS NULL OR cm.fecha >= $2)
        AND ($3::date IS NULL OR cm.fecha <= $3) AND ($4::text IS NULL OR cm.tipo = $4)
      ORDER BY cm.fecha DESC, cm.creado_en DESC LIMIT 500`,
    [terceroId, desde || null, hasta || null, tipo || null],
  );
  return r.rows;
}

/**
 * Anula una compra mal registrada: anula su comprobante (conserva el número) y
 * cierra su cuenta por pagar. Solo si todavía no tiene pagos: con un egreso encima
 * hay que anular primero el egreso, o el pago quedaría sin su obligación.
 */
export async function anularCompra(id, motivo, usuarioId = null, { client = null } = {}) {
  const texto = String(motivo ?? '').trim();
  if (texto.length < 5) throw badRequest('Escriba el motivo de la anulación.');
  return conTransaccion(client, async (db) => {
    const c = (await db.query(`SELECT id, estado, comprobante_id FROM sst.compras WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!c) throw notFound('Esa compra no existe.');
    if (c.estado !== 'CONTABILIZADO') throw conflict('La compra ya está anulada.');
    const cxp = (await db.query(`SELECT id FROM sst.cartera_documentos WHERE compra_id = $1 FOR UPDATE`, [id])).rows[0];
    if (cxp) {
      const pagos = await db.query(`SELECT 1 FROM sst.cartera_aplicaciones WHERE cartera_documento_id = $1 AND NOT anulada`, [cxp.id]);
      if (pagos.rows[0]) throw conflict('La compra ya tiene pagos: anule primero el egreso que la paga.');
      // No se borra: pagos ya anulados pueden seguir apuntándole. Queda en cero y anulada.
      await db.query(`UPDATE sst.cartera_documentos SET saldo = 0, anulado = true WHERE id = $1`, [cxp.id]);
    }
    await anularComprobante(c.comprobante_id, texto, usuarioId, { client: db, permitirOrigen: true });
    await db.query(
      `UPDATE sst.compras SET estado = 'ANULADO', motivo_anulacion = $2, anulado_por = $3, anulado_en = now() WHERE id = $1`,
      [id, texto, usuarioId],
    );
    return obtenerCompra(id, db);
  });
}
