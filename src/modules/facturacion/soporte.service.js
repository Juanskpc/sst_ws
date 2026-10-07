import crypto from 'node:crypto';
import { pool, withTransaction } from '../../config/db.js';
import { badRequest, conflict, notFound } from '../../utils/httpError.js';
import { aCentavos, deCentavos } from '../../utils/dinero.js';
import { calcularDv } from '../../utils/nit.js';
import { hoyCO } from '../../utils/formato.js';
import { storage } from '../../services/storage.service.js';
import { proveedorFE } from './index.js';
import { obtenerBorrador } from './borrador.service.js';
import {
  cargarDocumentoParaEmitir, contabilizarTrasValidar, finalizarRechazado, numeroCompleto, registrarFallaDeEnvio,
  registrarSinDecision,
} from './emision.service.js';
import { periodoLargo } from '../billing/billing.service.js';

/**
 * A4-01 (DSP-01, CXP-05) · Documento soporte desde la cuenta de cobro.
 *
 * Los asesores no facturan: le cobran a JD&D con la cuenta de cobro de Orbita
 * (M9) y JD&D respalda ese costo ante la DIAN con un documento soporte. Así lo
 * hace hoy en Siigo (DS-1-1316..1327, §3.5 del plan): uno por profesional, una
 * línea por actividad, cada una con la ARL de su orden (de ahí sale la cuenta de
 * costo cuando llegue la contabilización).
 *
 * Mismo circuito de dos fases que la factura: BORRADOR → ENVIANDO (confirmado en
 * la base ANTES de llamar al proveedor) → VALIDADO / RECHAZADO, con
 * «Consultar estado» para lo que quede a medias y el mismo reference_code como
 * clave de idempotencia.
 *
 * Supuestos a confirmar con la contadora: pago a crédito a 30 días (es una
 * cuenta por pagar) y sin retención en la fuente (en los DS de ejemplo no se
 * practicó; la base mínima de honorarios rara vez se supera).
 */

const PLAZO_DIAS = 30;
const generarReferenceCodeSoporte = () => `ORB-DS-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

const sumarDias = (iso, dias) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
};

const horasTexto = (h) => {
  const n = Number(h);
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, '').replace('.', ',');
};
const pesos = (v) => Math.round(Number(v)).toLocaleString('es-CO');

/**
 * Las líneas del DS a partir de los ítems congelados de la cuenta de cobro.
 * Honorarios en horas × valor hora; si esa multiplicación no da el monto que el
 * asesor aceptó (redondeos de horas fraccionadas), la línea va como 1 × monto:
 * manda lo aceptado, no lo recalculado. Los viáticos de la orden, en su propia
 * línea (son reembolso, no honorarios, y la contadora los separa).
 */
function lineasDesdePrecuenta(items) {
  const lineas = [];
  for (const it of items) {
    const horas = Number(it.horas);
    const valorHora = Number(it.valor_hora_snapshot);
    const monto = aCentavos(it.monto);
    const exacto = aCentavos(Math.round(horas * valorHora * 100) / 100) === monto;
    const quien = [it.orden_codigo, it.empresa_nombre, it.arl_nombre].filter(Boolean).join(' · ');
    if (monto > 0) {
      lineas.push({
        orden_id: it.orden_id,
        codigo: 'HON',
        descripcion: `Honorarios ${quien}${it.actividad ? ` · ${it.actividad}` : ''} · ${horasTexto(horas)} h a $${pesos(valorHora)}`.slice(0, 500),
        cantidad: exacto ? horas : 1,
        valor_unitario: exacto ? valorHora : deCentavos(monto),
        total: monto,
      });
    }
    const viaticos = aCentavos(it.viaticos ?? 0);
    if (viaticos > 0) {
      lineas.push({
        orden_id: it.orden_id,
        codigo: 'VIA',
        descripcion: `Viáticos ${quien}`.slice(0, 500),
        cantidad: 1,
        valor_unitario: deCentavos(viaticos),
        total: viaticos,
      });
    }
  }
  return lineas;
}

/** Crea el documento soporte en BORRADOR desde una cuenta de cobro ACEPTADA. */
export async function crearDesdePrecuenta(precuentaId, usuarioId) {
  const id = await withTransaction(async (client) => {
    const pc = (await client.query(
      `SELECT pc.id, pc.estado, pc.periodo, pc.total_monto, p.nombre AS profesional_nombre, p.tercero_id
         FROM sst.precuentas pc JOIN sst.profesionales p ON p.id = pc.profesional_id
        WHERE pc.id = $1 FOR UPDATE OF pc`,
      [precuentaId],
    )).rows[0];
    if (!pc) throw notFound('Esa cuenta de cobro no existe.');
    if (pc.estado !== 'aceptada') {
      throw conflict(`Solo se hace documento soporte de una cuenta de cobro aceptada (esta está ${pc.estado}).`);
    }
    if (!pc.tercero_id) {
      throw badRequest(`${pc.profesional_nombre} todavía no es tercero: créelo en Terceros → «Crear desde profesional» (la DIAN pide su documento, dirección y municipio).`);
    }

    const existente = (await client.query(
      `SELECT id, estado, reference_code, prefijo, numero FROM sst.documentos_electronicos
        WHERE precuenta_id = $1 AND tipo = 'DOC_SOPORTE' AND estado <> 'ANULADO' LIMIT 1`,
      [precuentaId],
    )).rows[0];
    if (existente) {
      throw conflict(`Esta cuenta de cobro ya tiene documento soporte (${numeroCompleto(existente.prefijo, existente.numero) ?? existente.reference_code}, ${existente.estado.toLowerCase()}).`);
    }

    const items = (await client.query(
      `SELECT * FROM sst.precuenta_items WHERE precuenta_id = $1 ORDER BY fecha_ejecucion, orden_codigo`, [precuentaId],
    )).rows;
    const lineas = lineasDesdePrecuenta(items);
    if (!lineas.length) throw badRequest('La cuenta de cobro no tiene valores que respaldar.');
    const total = lineas.reduce((s, l) => s + l.total, 0);

    const [forma, medio] = await Promise.all([
      client.query(`SELECT id FROM sst.formas_pago WHERE codigo_dian = '2'`),
      client.query(`SELECT id FROM sst.medios_pago WHERE codigo_dian = 'ZZZ'`),
    ]);
    const hoy = hoyCO();
    const doc = (await client.query(
      `INSERT INTO sst.documentos_electronicos
         (tipo, reference_code, estado, tercero_id, precuenta_id, fecha_emision, fecha_vencimiento,
          forma_pago_id, medio_pago_id, observaciones,
          total_bruto, total_descuento, subtotal, total_iva, total_retenciones, total_a_pagar,
          creado_por, actualizado_por)
       VALUES ('DOC_SOPORTE', $1, 'BORRADOR', $2, $3, $4, $5, $6, $7, $8, $9, 0, $9, 0, 0, $9, $10, $10)
       RETURNING id`,
      [
        generarReferenceCodeSoporte(), pc.tercero_id, precuentaId, hoy, sumarDias(hoy, PLAZO_DIAS),
        forma.rows[0]?.id ?? null, medio.rows[0]?.id ?? null,
        `Cuenta de cobro de ${periodoLargo(pc.periodo)}.`, deCentavos(total), usuarioId,
      ],
    )).rows[0];

    for (const [i, l] of lineas.entries()) {
      await client.query(
        `INSERT INTO sst.documento_items
           (documento_id, orden_id, codigo, descripcion, cantidad, valor_unitario, descuento, base, total_linea, orden)
         VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $7, $8)`,
        [doc.id, l.orden_id, l.codigo, l.descripcion, l.cantidad, l.valor_unitario, deCentavos(l.total), i],
      );
    }
    await client.query(
      `INSERT INTO sst.documento_eventos (documento_id, codigo, descripcion, usuario_id) VALUES ($1, 'CREADO', $2, $3)`,
      [doc.id, `Documento soporte creado desde la cuenta de cobro de ${pc.profesional_nombre} (${periodoLargo(pc.periodo)}).`, usuarioId],
    );
    return doc.id;
  });
  return obtenerSoporte(id);
}

/**
 * Cuentas de cobro ACEPTADAS que todavía no tienen documento soporte vivo: lo que
 * la contadora tiene por respaldar. Dice si al asesor le falta el tercero o algún
 * dato que la DIAN exige, para avisarlo antes de intentarlo.
 */
export async function listarPorGenerar() {
  const r = await pool.query(
    `SELECT pc.id AS precuenta_id, pc.periodo, pc.total_horas, pc.total_monto, pc.total_viaticos, pc.respondido_en,
            p.id AS profesional_id, p.nombre AS profesional_nombre, p.tercero_id,
            t.numero_documento AS tercero_documento,
            (SELECT count(*)::int FROM sst.precuenta_items i WHERE i.precuenta_id = pc.id) AS total_ordenes,
            array_remove(ARRAY[
              CASE WHEN p.tercero_id IS NULL THEN 'tercero' END,
              CASE WHEN p.tercero_id IS NOT NULL AND t.direccion IS NULL THEN 'dirección' END,
              CASE WHEN p.tercero_id IS NOT NULL AND t.municipio_id IS NULL THEN 'municipio' END
            ], NULL) AS faltantes
       FROM sst.precuentas pc
       JOIN sst.profesionales p ON p.id = pc.profesional_id
       LEFT JOIN sst.terceros t ON t.id = p.tercero_id
      WHERE pc.estado = 'aceptada'
        AND NOT EXISTS (SELECT 1 FROM sst.documentos_electronicos d
                         WHERE d.precuenta_id = pc.id AND d.tipo = 'DOC_SOPORTE' AND d.estado <> 'ANULADO')
      ORDER BY pc.periodo DESC, p.nombre`,
  );
  return r.rows.map((f) => ({ ...f, periodo_largo: periodoLargo(f.periodo) }));
}

// ─── Tipos que maneja este módulo ────────────────────────────────────────────
// El documento soporte y su nota de ajuste (A4-03) recorren el mismo circuito:
// BORRADOR → ENVIANDO → VALIDADO / RECHAZADO. Lo que cambia es el endpoint del
// proveedor, la numeración y lo que pasa al validarse.
const TIPOS = ['DOC_SOPORTE', 'NOTA_AJUSTE_DS'];
const nombreDe = (tipo) => (tipo === 'NOTA_AJUSTE_DS' ? 'La nota de ajuste' : 'El documento soporte');

/** Tabla de la DIAN para la nota de ajuste al documento soporte (tablas de referencia del proveedor, 7-oct-2026). */
export const CAUSALES_NOTA_AJUSTE = {
  1: 'Devolución parcial de los bienes y/o no aceptación parcial del servicio',
  2: 'Anulación del documento soporte',
  3: 'Rebaja o descuento parcial o total',
  4: 'Ajuste de precio',
  5: 'Otros',
};
const ANULACION = '2';

async function tipoDe(id, client = pool) {
  const r = (await client.query(`SELECT tipo FROM sst.documentos_electronicos WHERE id = $1`, [id])).rows[0];
  if (!r || !TIPOS.includes(r.tipo)) throw notFound('Ese documento soporte no existe.');
  return r.tipo;
}

const LISTA_SELECT = `
  SELECT d.id, d.tipo, d.estado, d.reference_code, d.prefijo, d.numero, d.cufe, d.causal,
         to_char(d.fecha_emision, 'YYYY-MM-DD') AS fecha_emision,
         d.total_a_pagar, d.pdf_path IS NOT NULL AS tiene_pdf, d.xml_path IS NOT NULL AS tiene_xml,
         d.tercero_id, COALESCE(t.razon_social, btrim(concat_ws(' ', t.nombres, t.apellidos))) AS tercero_nombre,
         t.numero_documento AS tercero_documento,
         COALESCE(d.precuenta_id, ref.precuenta_id) AS precuenta_id, pc.periodo, p.nombre AS profesional_nombre,
         (SELECT count(*)::int FROM sst.documento_items i WHERE i.documento_id = d.id) AS total_lineas,
         d.comprobante_id IS NOT NULL AS contabilizado, cxp.saldo AS saldo_por_pagar,
         d.documento_referencia_id, ref.prefijo AS referencia_prefijo, ref.numero AS referencia_numero,
         d.creado_en
    FROM sst.documentos_electronicos d
    JOIN sst.terceros t ON t.id = d.tercero_id
    LEFT JOIN sst.documentos_electronicos ref ON ref.id = d.documento_referencia_id
    LEFT JOIN sst.precuentas pc ON pc.id = COALESCE(d.precuenta_id, ref.precuenta_id)
    LEFT JOIN sst.profesionales p ON p.id = pc.profesional_id
    LEFT JOIN sst.cartera_documentos cxp ON cxp.documento_id = d.id`;

/**
 * Lista por estado (varios separados por coma). `periodo` (AAAA-MM) la acota al
 * mes de la cuenta de cobro; `tipo` es DOC_SOPORTE (por defecto) o NOTA_AJUSTE_DS.
 */
export async function listarSoportes({ estado, periodo, tipo = 'DOC_SOPORTE' } = {}) {
  if (!TIPOS.includes(tipo)) throw badRequest('Tipo de documento no válido.');
  const estados = String(estado || 'BORRADOR,ENVIANDO,VALIDADO,RECHAZADO,ANULADO')
    .split(',').map((e) => e.trim().toUpperCase()).filter(Boolean);
  const params = [estados, tipo];
  let filtro = '';
  if (periodo) {
    if (!/^\d{4}-\d{2}$/.test(String(periodo))) throw badRequest('El periodo va como AAAA-MM.');
    params.push(String(periodo));
    filtro = ` AND pc.periodo = $3`;
  }
  return (await pool.query(
    `${LISTA_SELECT} WHERE d.tipo = $2 AND d.estado = ANY($1)${filtro} ORDER BY d.creado_en DESC LIMIT 500`,
    params,
  )).rows;
}

/** Detalle: el de la factura (ítems, totales, línea de tiempo) más la cuenta de cobro de origen y el pago. */
export async function obtenerSoporte(id, client = pool) {
  const doc = await obtenerBorrador(id, client);
  if (!TIPOS.includes(doc.tipo)) throw notFound('Ese documento soporte no existe.');
  const precuentaId = doc.precuenta_id ?? (doc.documento_referencia_id ? (await client.query(
    `SELECT precuenta_id FROM sst.documentos_electronicos WHERE id = $1`, [doc.documento_referencia_id],
  )).rows[0]?.precuenta_id : null);
  const origen = precuentaId ? (await client.query(
    `SELECT pc.id, pc.periodo, pc.estado, p.nombre AS profesional_nombre
       FROM sst.precuentas pc JOIN sst.profesionales p ON p.id = pc.profesional_id WHERE pc.id = $1`,
    [precuentaId],
  )).rows[0] : null;
  const arls = (await client.query(
    `SELECT i.id AS item_id, a.nombre AS arl_nombre, o.codigo AS orden_codigo
       FROM sst.documento_items i
       LEFT JOIN sst.ordenes_servicio o ON o.id = i.orden_id
       LEFT JOIN sst.arls a ON a.id = o.arl_id
      WHERE i.documento_id = $1`,
    [id],
  )).rows;
  const porItem = new Map(arls.map((a) => [a.item_id, a]));
  // Contabilización y pago: el asiento y lo que falta pagarle al asesor.
  const contable = (await client.query(
    `SELECT d.comprobante_id, d.contabilizacion_error, cxp.valor AS cxp_valor, cxp.saldo AS cxp_saldo
       FROM sst.documentos_electronicos d LEFT JOIN sst.cartera_documentos cxp ON cxp.documento_id = d.id
      WHERE d.id = $1`,
    [id],
  )).rows[0];
  // Las notas de ajuste ya hechas sobre este DS (para mostrarlas y saber si hay una en curso).
  const notas = doc.tipo === 'DOC_SOPORTE' ? (await client.query(
    `SELECT id, estado, prefijo, numero, reference_code, causal, total_a_pagar
       FROM sst.documentos_electronicos WHERE documento_referencia_id = $1 AND tipo = 'NOTA_AJUSTE_DS' ORDER BY creado_en`,
    [id],
  )).rows : [];
  return {
    ...doc,
    comprobante_id: contable?.comprobante_id ?? null,
    contabilizacion_error: contable?.contabilizacion_error ?? null,
    cxp: contable?.cxp_valor != null ? { valor: contable.cxp_valor, saldo: contable.cxp_saldo } : null,
    precuenta: origen ? { ...origen, periodo_largo: periodoLargo(origen.periodo) } : null,
    notas_ajuste: notas,
    causal_nombre: doc.causal ? CAUSALES_NOTA_AJUSTE[doc.causal] ?? null : null,
    items: doc.items.map((it) => ({
      ...it,
      arl_nombre: porItem.get(it.id)?.arl_nombre ?? null,
      orden_codigo: porItem.get(it.id)?.orden_codigo ?? null,
    })),
  };
}

// ─── A4-02 · Documento soporte manual ────────────────────────────────────────

/**
 * Documento soporte que NO sale de una cuenta de cobro: la contadora (§3.5: su DS
 * va a 51101001 Honorarios - Contabilidad) o cualquier compra a quien no está
 * obligado a facturar. Cada línea lleva su cuenta de costo o gasto, porque no hay
 * orden de la que deducir el pagador. Nace en BORRADOR, como el de la cuenta de cobro.
 *
 * @param {{ tercero_id: string, observaciones?: string, lineas: { descripcion: string, cantidad: number|string,
 *   valor_unitario: number|string, cuenta_id: string }[] }} b
 * @param {{ client?: import('pg').PoolClient }} [opciones] para la carga masiva (todo o nada).
 */
export async function crearSoporteManual(b = {}, usuarioId = null, { client = null } = {}) {
  const trabajo = async (db) => {
    const tercero = (await db.query(
      `SELECT id, activo, COALESCE(razon_social, btrim(concat_ws(' ', nombres, apellidos))) AS nombre FROM sst.terceros WHERE id = $1`,
      [b.tercero_id],
    )).rows[0];
    if (!tercero) throw badRequest('Elija a quién se le compra (el proveedor debe existir en Terceros).');
    if (!tercero.activo) throw badRequest(`${tercero.nombre} está inactivo en Terceros.`);
    const lineas = Array.isArray(b.lineas) ? b.lineas : [];
    if (!lineas.length) throw badRequest('Agregue al menos una línea.');
    const items = [];
    for (const [i, l] of lineas.entries()) {
      const descripcion = String(l.descripcion ?? '').trim();
      const cantidad = Number(String(l.cantidad ?? '1').replace(',', '.'));
      const valor = Number(String(l.valor_unitario ?? '').replace(',', '.'));
      if (!descripcion) throw badRequest(`Línea ${i + 1}: escriba el detalle.`);
      if (!(cantidad > 0)) throw badRequest(`Línea ${i + 1}: la cantidad debe ser mayor que cero.`);
      if (!(valor > 0)) throw badRequest(`Línea ${i + 1}: el valor debe ser mayor que cero.`);
      const cuenta = l.cuenta_id ? (await db.query(
        `SELECT id, codigo, acepta_movimiento, activa FROM sst.cuentas_contables WHERE id = $1`, [l.cuenta_id],
      )).rows[0] : null;
      if (!cuenta) throw badRequest(`Línea ${i + 1}: elija la cuenta de costo o gasto.`);
      if (!cuenta.acepta_movimiento || !cuenta.activa) throw badRequest(`Línea ${i + 1}: la cuenta ${cuenta.codigo} no recibe movimiento.`);
      const total = Math.round(cantidad * valor * 100);
      items.push({ descripcion: descripcion.slice(0, 500), cantidad, valor, cuenta_id: cuenta.id, total });
    }
    const total = items.reduce((s, it) => s + it.total, 0);
    const [forma, medio] = await Promise.all([
      db.query(`SELECT id FROM sst.formas_pago WHERE codigo_dian = '2'`),
      db.query(`SELECT id FROM sst.medios_pago WHERE codigo_dian = 'ZZZ'`),
    ]);
    const hoy = hoyCO();
    const doc = (await db.query(
      `INSERT INTO sst.documentos_electronicos
         (tipo, reference_code, estado, tercero_id, fecha_emision, fecha_vencimiento, forma_pago_id, medio_pago_id, observaciones,
          total_bruto, total_descuento, subtotal, total_iva, total_retenciones, total_a_pagar, creado_por, actualizado_por)
       VALUES ('DOC_SOPORTE', $1, 'BORRADOR', $2, $3, $4, $5, $6, $7, $8, 0, $8, 0, 0, $8, $9, $9)
       RETURNING id`,
      [generarReferenceCodeSoporte(), tercero.id, hoy, sumarDias(hoy, PLAZO_DIAS), forma.rows[0]?.id ?? null, medio.rows[0]?.id ?? null,
        String(b.observaciones ?? '').trim().slice(0, 500) || null, deCentavos(total), usuarioId],
    )).rows[0];
    for (const [i, it] of items.entries()) {
      await db.query(
        `INSERT INTO sst.documento_items
           (documento_id, codigo, descripcion, cantidad, valor_unitario, descuento, base, total_linea, cuenta_costo_id, orden)
         VALUES ($1, 'DS', $2, $3, $4, 0, $5, $5, $6, $7)`,
        [doc.id, it.descripcion, it.cantidad, it.valor, deCentavos(it.total), it.cuenta_id, i],
      );
    }
    await db.query(
      `INSERT INTO sst.documento_eventos (documento_id, codigo, descripcion, usuario_id) VALUES ($1, 'CREADO', $2, $3)`,
      [doc.id, `Documento soporte manual para ${tercero.nombre}.`, usuarioId],
    );
    return doc.id;
  };
  const id = client ? await trabajo(client) : await withTransaction(trabajo);
  return obtenerSoporte(id, client ?? pool);
}

// ─── A4-03 · Nota de ajuste ────────────────────────────────────────────────

/**
 * Crea la nota de ajuste en BORRADOR sobre un documento soporte VALIDADO. Sin
 * `lineas` (o con la causal 2, anulación) ajusta el DS completo; con `lineas`
 * ({ item_id, cantidad }) solo lo indicado. La nota baja lo que se le debe al
 * asesor: si ya se le pagó, primero hay que anular el egreso.
 */
export async function crearNotaAjuste(soporteId, { causal, lineas, observaciones } = {}, usuarioId) {
  const codigo = String(causal ?? '').trim();
  if (!CAUSALES_NOTA_AJUSTE[codigo]) throw badRequest('Elija el motivo de la nota de ajuste (códigos 1 a 5 de la DIAN).');
  const id = await withTransaction(async (client) => {
    const ds = (await client.query(
      `SELECT * FROM sst.documentos_electronicos WHERE id = $1 AND tipo = 'DOC_SOPORTE' FOR UPDATE`, [soporteId],
    )).rows[0];
    if (!ds) throw notFound('Ese documento soporte no existe.');
    if (ds.estado !== 'VALIDADO') throw conflict(`Solo se ajusta un documento soporte validado (este está ${ds.estado.toLowerCase()}).`);
    const abierta = (await client.query(
      `SELECT reference_code FROM sst.documentos_electronicos
        WHERE documento_referencia_id = $1 AND tipo = 'NOTA_AJUSTE_DS' AND estado IN ('BORRADOR', 'ENVIANDO', 'RECHAZADO')`,
      [soporteId],
    )).rows[0];
    if (abierta) throw conflict(`Este documento soporte ya tiene una nota de ajuste en curso (${abierta.reference_code}): emítala o elimínela primero.`);

    const itemsDs = (await client.query(
      `SELECT id, orden_id, codigo, descripcion, cantidad, valor_unitario, cuenta_costo_id
         FROM sst.documento_items WHERE documento_id = $1 ORDER BY orden`, [soporteId],
    )).rows;
    const ajustado = (await client.query(
      `SELECT it.orden_id, it.descripcion, SUM(it.cantidad) AS cantidad
         FROM sst.documento_items it JOIN sst.documentos_electronicos d ON d.id = it.documento_id
        WHERE d.documento_referencia_id = $1 AND d.tipo = 'NOTA_AJUSTE_DS' AND d.estado = 'VALIDADO'
        GROUP BY 1, 2`, [soporteId],
    )).rows;
    const yaAjustado = (it) => Number(ajustado.find((a) => a.orden_id === it.orden_id && a.descripcion === it.descripcion)?.cantidad ?? 0);

    let items;
    if (codigo === ANULACION || !lineas?.length) {
      if (ajustado.length) throw conflict('El documento soporte ya tiene notas de ajuste parciales: una anulación total ya no cuadra. Ajuste el saldo con otra nota parcial.');
      items = itemsDs.map((it) => ({ ...it, cantidad: Number(it.cantidad) }));
    } else {
      items = lineas.map((l) => {
        const it = itemsDs.find((x) => x.id === l.item_id);
        if (!it) throw badRequest('Alguna línea elegida no pertenece a este documento soporte.');
        const cantidad = Number(l.cantidad);
        const disponible = Number(it.cantidad) - yaAjustado(it);
        if (!(cantidad > 0)) throw badRequest(`La cantidad de «${it.descripcion}» debe ser mayor que cero.`);
        if (cantidad > disponible + 1e-9) throw badRequest(`De «${it.descripcion}» solo quedan ${disponible} por ajustar.`);
        return { ...it, cantidad };
      });
    }
    const totalDe = (it) => Math.round(Number(it.cantidad) * Number(it.valor_unitario) * 100);
    const total = items.reduce((s, it) => s + totalDe(it), 0);
    if (!(total > 0)) throw badRequest('La nota de ajuste no tiene valor.');

    const cxp = (await client.query(`SELECT saldo FROM sst.cartera_documentos WHERE documento_id = $1`, [soporteId])).rows[0];
    if (cxp && total > aCentavos(cxp.saldo)) {
      throw conflict(`Al asesor ya se le pagó parte de este documento soporte (quedan ${cxp.saldo} por pagar): la nota de ${deCentavos(total)} no cabe. Anule primero el egreso.`);
    }

    const nota = (await client.query(
      `INSERT INTO sst.documentos_electronicos
         (tipo, reference_code, estado, tercero_id, documento_referencia_id, causal, fecha_emision, fecha_vencimiento,
          forma_pago_id, medio_pago_id, observaciones,
          total_bruto, total_descuento, subtotal, total_iva, total_retenciones, total_a_pagar, creado_por, actualizado_por)
       VALUES ('NOTA_AJUSTE_DS', $1, 'BORRADOR', $2, $3, $4, $5, $11, $6, $7, $8, $9, 0, $9, 0, 0, $9, $10, $10)
       RETURNING id`,
      // Mismo plazo que el DS: a crédito, el proveedor exige un vencimiento posterior a hoy.
      [`ORB-NA-${crypto.randomUUID().slice(0, 8).toUpperCase()}`, ds.tercero_id, soporteId, codigo, hoyCO(),
        ds.forma_pago_id, ds.medio_pago_id, observaciones?.trim() || CAUSALES_NOTA_AJUSTE[codigo], deCentavos(total), usuarioId,
        sumarDias(hoyCO(), PLAZO_DIAS)],
    )).rows[0];
    for (const [i, it] of items.entries()) {
      await client.query(
        `INSERT INTO sst.documento_items
           (documento_id, orden_id, codigo, descripcion, cantidad, valor_unitario, descuento, base, total_linea, cuenta_costo_id, orden)
         VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $7, $8, $9)`,
        [nota.id, it.orden_id, it.codigo, it.descripcion, it.cantidad, it.valor_unitario, deCentavos(totalDe(it)), it.cuenta_costo_id, i],
      );
    }
    const numeroDs = numeroCompleto(ds.prefijo, ds.numero);
    await client.query(
      `INSERT INTO sst.documento_eventos (documento_id, codigo, descripcion, usuario_id) VALUES ($1, 'CREADO', $2, $3)`,
      [nota.id, `Nota de ajuste sobre el documento soporte ${numeroDs} · motivo ${codigo}: ${CAUSALES_NOTA_AJUSTE[codigo]}.`, usuarioId],
    );
    await client.query(
      `INSERT INTO sst.documento_eventos (documento_id, codigo, descripcion, usuario_id) VALUES ($1, 'NOTA_AJUSTE_CREADA', $2, $3)`,
      [soporteId, `Se creó una nota de ajuste en borrador (motivo ${codigo}: ${CAUSALES_NOTA_AJUSTE[codigo]}).`, usuarioId],
    );
    return nota.id;
  });
  return obtenerSoporte(id);
}

// ─── Emisión (DS y nota) ─────────────────────────────────────────────────────

function validarSoporte({ doc, items, resolucion }) {
  const quien = nombreDe(doc.tipo);
  if (doc.estado !== 'BORRADOR') {
    throw conflict(doc.estado === 'ENVIANDO'
      ? `${quien} ya se está enviando: use «Consultar estado», no lo emita de nuevo.`
      : `${quien} ya está ${doc.estado.toLowerCase()}; no se puede volver a emitir.`);
  }
  if (!items.length) throw badRequest(`${quien} no tiene líneas.`);
  const faltan = [];
  if (!doc.numero_documento) faltan.push('número de documento');
  if (!doc.direccion) faltan.push('dirección');
  if (!doc.municipio_id) faltan.push('municipio');
  if (faltan.length) throw badRequest(`Al tercero ${doc.nombre} le falta ${faltan.join(', ')}. Complete su ficha en Terceros.`);
  if (!resolucion) {
    throw badRequest(`No hay una numeración activa para ${doc.tipo === 'NOTA_AJUSTE_DS' ? 'notas de ajuste' : 'documento soporte'}. Sincronícela en Parametrización → Numeración.`);
  }
  const hoy = hoyCO();
  if (resolucion.fecha_hasta && resolucion.fecha_hasta < hoy) throw badRequest(`La numeración venció el ${resolucion.fecha_hasta}.`);
  if (resolucion.hasta != null && Number(resolucion.consecutivo_actual) >= Number(resolucion.hasta)) {
    throw badRequest('La numeración ya agotó su rango.');
  }
  if (!(Number(doc.total_a_pagar) > 0)) throw badRequest(`${quien} no tiene un total mayor que cero.`);
}

async function intentarEmision({ doc, items, formaPagoCodigo, medioPagoCodigo, resolucion }) {
  const datos = {
    referenceCode: doc.reference_code,
    proveedor: {
      nit: doc.numero_documento,
      // La DIAN pide el documento del proveedor como NIT: a una cédula sin DV se le calcula.
      dv: doc.dv ?? calcularDv(doc.numero_documento),
      tipoPersona: doc.tipo_persona,
      razonSocial: doc.nombre,
      direccion: doc.direccion,
      municipioDane: doc.municipio_codigo,
      email: doc.correo_facturacion,
      telefono: doc.telefono,
    },
    items: items.map((it) => ({
      codigo: it.codigo,
      descripcion: it.descripcion,
      cantidad: Number(it.cantidad),
      valorUnitario: Number(it.valor_unitario),
    })),
    numberingRangeId: resolucion.factus_rango_id ? Number(resolucion.factus_rango_id) : undefined,
    formaPagoCodigo,
    medioPagoCodigo,
    montoAPagar: deCentavos(aCentavos(doc.total_a_pagar)),
    fechaVencimiento: doc.fecha_vencimiento,
    observacion: doc.observaciones,
  };
  if (doc.tipo !== 'NOTA_AJUSTE_DS') return proveedorFE().emitirDocumentoSoporte(datos);
  const ds = (await pool.query(
    `SELECT prefijo, numero, estado FROM sst.documentos_electronicos WHERE id = $1`, [doc.documento_referencia_id],
  )).rows[0];
  if (!ds?.numero || ds.estado !== 'VALIDADO') throw conflict('El documento soporte de esta nota ya no está validado.');
  return proveedorFE().emitirNotaAjusteSoporte({
    ...datos, numeroDocumentoSoporte: numeroCompleto(ds.prefijo, ds.numero), conceptoCorreccion: doc.causal,
  });
}

/**
 * VALIDADO: número, CUDS, PDF y XML en una transacción. Una descarga fallida no
 * revierte nada. Una nota de anulación deja ANULADO su documento soporte (la
 * cuenta de cobro queda libre para otro). Después, en su propia transacción, el
 * asiento y la cuenta por pagar: si falla (falta una regla, mes cerrado) el
 * documento sigue válido ante la DIAN y queda «contabilidad pendiente».
 */
async function finalizarValidado(id, tipo, resultado, usuarioId) {
  await finalizarValidadoTx(id, tipo, resultado, usuarioId);
  await contabilizarTrasValidar(id, usuarioId);
}

async function finalizarValidadoTx(id, tipo, resultado, usuarioId) {
  const esNota = tipo === 'NOTA_AJUSTE_DS';
  return withTransaction(async (client) => {
    const avisos = [];
    const proveedor = proveedorFE();
    const [pdf, xml] = await Promise.all([
      (esNota ? proveedor.descargarPdfNotaAjusteSoporte(resultado.numeroDocumento) : proveedor.descargarPdfDocumentoSoporte(resultado.numeroDocumento))
        .catch((e) => { avisos.push(`PDF: ${e.message}`); return null; }),
      (esNota ? proveedor.descargarXmlNotaAjusteSoporte(resultado.numeroDocumento) : proveedor.descargarXmlDocumentoSoporte(resultado.numeroDocumento))
        .catch((e) => { avisos.push(`XML: ${e.message}`); return null; }),
    ]);
    const [pdfPath, xmlPath] = await Promise.all([
      pdf ? storage.put('soporte/pdf', `${resultado.numeroDocumento}.pdf`, Buffer.from(pdf.base64, 'base64')) : null,
      xml ? storage.put('soporte/xml', `${resultado.numeroDocumento}.xml`, Buffer.from(xml.base64, 'base64')) : null,
    ]);
    const resolucion = (await client.query(
      `SELECT prefijo FROM sst.resoluciones_numeracion WHERE tipo_documento = $1 AND activa
        ORDER BY sincronizada_en DESC NULLS LAST LIMIT 1`, [tipo],
    )).rows[0];
    const prefijo = resolucion?.prefijo ?? null;
    const numero = numeroCompleto(prefijo, resultado.numeroDocumento);
    await client.query(
      `UPDATE sst.documentos_electronicos
          SET estado = 'VALIDADO', numero = $2, prefijo = $3, cufe = $4, qr_url = $5,
              pdf_path = COALESCE($6, pdf_path), xml_path = COALESCE($7, xml_path),
              respuesta_proveedor = $8, errores = NULL, actualizado_por = $9
        WHERE id = $1`,
      [id, resultado.numeroDocumento, prefijo, resultado.cufe, resultado.urlPublica,
        pdfPath, xmlPath, JSON.stringify(resultado.respuestaCruda ?? {}), usuarioId],
    );
    await client.query(
      `INSERT INTO sst.documento_eventos (documento_id, codigo, descripcion, usuario_id) VALUES ($1, 'VALIDADO', $2, $3)`,
      [id, `Validado por la DIAN. Número ${numero}, CUDS ${resultado.cufe ?? '—'}.`, usuarioId],
    );
    if (avisos.length) {
      await client.query(
        `INSERT INTO sst.documento_eventos (documento_id, codigo, descripcion, usuario_id) VALUES ($1, 'DESCARGA_FALLIDA', $2, $3)`,
        [id, `No se pudo descargar: ${avisos.join('; ')}`.slice(0, 2000), usuarioId],
      );
    }
    if (esNota) {
      const nota = (await client.query(`SELECT causal, documento_referencia_id FROM sst.documentos_electronicos WHERE id = $1`, [id])).rows[0];
      await client.query(
        `INSERT INTO sst.documento_eventos (documento_id, codigo, descripcion, usuario_id) VALUES ($1, 'NOTA_AJUSTE', $2, $3)`,
        [nota.documento_referencia_id, `Nota de ajuste ${numero} validada (motivo ${nota.causal}: ${CAUSALES_NOTA_AJUSTE[nota.causal]}).`, usuarioId],
      );
      if (nota.causal === ANULACION) {
        await client.query(
          `UPDATE sst.documentos_electronicos SET estado = 'ANULADO', actualizado_por = $2 WHERE id = $1`, [nota.documento_referencia_id, usuarioId],
        );
        await client.query(
          `INSERT INTO sst.documento_eventos (documento_id, codigo, descripcion, usuario_id) VALUES ($1, 'ANULADO', $2, $3)`,
          [nota.documento_referencia_id, `Anulado con la nota de ajuste ${numero}. Su cuenta de cobro vuelve a «Por generar».`, usuarioId],
        );
      }
    }
  });
}

async function resolverResultado(id, tipo, resultado, usuarioId) {
  if (resultado.eventos?.rechazos?.length) {
    await finalizarRechazado(id, resultado.eventos.rechazos.map(([, v]) => v), resultado.respuestaCruda, usuarioId);
    return { pendiente: false };
  }
  if (resultado.validado && resultado.numeroDocumento) {
    await finalizarValidado(id, tipo, resultado, usuarioId);
    return { pendiente: false };
  }
  await registrarSinDecision(id, 'SIN_DECISION', 'Todavía no se valida ni se rechaza. Use «Consultar estado» en unos minutos.', usuarioId);
  return { pendiente: true };
}

const pendiente = (tipo) => ({
  pendiente: true,
  estado: 'ENVIANDO',
  aviso: `No hubo respuesta definitiva de la DIAN; ${nombreDe(tipo).toLowerCase()} quedó en ENVIANDO. Use «Consultar estado» en unos minutos.`,
});

/** Emite el borrador (ENVIANDO confirmado antes de llamar al proveedor). Sirve para el DS y para su nota. */
export async function emitirSoporte(id, usuarioId) {
  const tipo = await tipoDe(id);
  const datos = await withTransaction(async (client) => {
    const d = await cargarDocumentoParaEmitir(id, client, tipo);
    validarSoporte(d);
    await client.query(`UPDATE sst.documentos_electronicos SET estado = 'ENVIANDO', actualizado_por = $2 WHERE id = $1`, [id, usuarioId]);
    await client.query(
      `INSERT INTO sst.documento_eventos (documento_id, codigo, descripcion, usuario_id) VALUES ($1, 'ENVIANDO', 'Enviado a la DIAN.', $2)`,
      [id, usuarioId],
    );
    return d;
  });

  let resultado;
  try {
    resultado = await intentarEmision(datos);
  } catch (e) {
    if (await registrarFallaDeEnvio(id, e, usuarioId)) return obtenerSoporte(id);
    return pendiente(tipo);
  }
  const r = await resolverResultado(id, tipo, resultado, usuarioId);
  return r.pendiente ? pendiente(tipo) : obtenerSoporte(id);
}

/** Reconcilia lo que quedó ENVIANDO: con número consulta; sin número reintenta con el MISMO reference_code. */
export async function reconciliarSoporte(id, usuarioId) {
  const tipo = await tipoDe(id);
  const datos = await withTransaction((client) => cargarDocumentoParaEmitir(id, client, tipo));
  if (datos.doc.estado !== 'ENVIANDO') throw conflict(`Este documento está ${datos.doc.estado.toLowerCase()}; no hay nada que reconciliar.`);
  if (!datos.doc.numero) {
    let resultado;
    try {
      resultado = await intentarEmision(datos);
    } catch (e) {
      if (await registrarFallaDeEnvio(id, e, usuarioId)) return obtenerSoporte(id);
      return pendiente(tipo);
    }
    const r = await resolverResultado(id, tipo, resultado, usuarioId);
    return r.pendiente ? pendiente(tipo) : obtenerSoporte(id);
  }
  const estado = tipo === 'NOTA_AJUSTE_DS'
    ? await proveedorFE().consultarNotaAjusteSoporte(datos.doc.numero)
    : await proveedorFE().consultarDocumentoSoporte(datos.doc.numero);
  if (estado.estado === 'VALIDADO') {
    await finalizarValidado(id, tipo, {
      numeroDocumento: datos.doc.numero, cufe: estado.cufe, urlPublica: estado.urlPublica, respuestaCruda: estado.respuestaCruda,
    }, usuarioId);
    return obtenerSoporte(id);
  }
  if (estado.estado === 'RECHAZADO') {
    await finalizarRechazado(id, [estado.detalle || 'Rechazado por la DIAN.'], estado.respuestaCruda, usuarioId);
    return obtenerSoporte(id);
  }
  await registrarSinDecision(id, 'CONSULTA_ESTADO', 'Sigue en proceso ante la DIAN.', usuarioId);
  return pendiente(tipo);
}

/** RECHAZADO → BORRADOR con un reference_code nuevo (el intento rechazado queda en la línea de tiempo). */
export async function corregirSoporte(id, usuarioId) {
  const tipo = await tipoDe(id);
  await withTransaction(async (client) => {
    const doc = (await client.query(
      `SELECT estado, reference_code FROM sst.documentos_electronicos WHERE id = $1 FOR UPDATE`, [id],
    )).rows[0];
    if (doc.estado !== 'RECHAZADO') throw conflict(`Solo se corrige un documento RECHAZADO (este está ${doc.estado.toLowerCase()}).`);
    const referencia = tipo === 'NOTA_AJUSTE_DS'
      ? `ORB-NA-${crypto.randomUUID().slice(0, 8).toUpperCase()}`
      : generarReferenceCodeSoporte();
    await client.query(
      `UPDATE sst.documentos_electronicos SET estado = 'BORRADOR', reference_code = $2, errores = NULL, actualizado_por = $3 WHERE id = $1`,
      [id, referencia, usuarioId],
    );
    await client.query(
      `INSERT INTO sst.documento_eventos (documento_id, codigo, descripcion, usuario_id) VALUES ($1, 'CORREGIDO', $2, $3)`,
      [id, `Vuelve a BORRADOR. El intento rechazado (${doc.reference_code}) queda en el historial; se emitirá con una referencia nueva.`, usuarioId],
    );
  });
  return obtenerSoporte(id);
}

/** Borra un BORRADOR (la cuenta de cobro, o el DS de la nota, queda libre). */
export async function eliminarSoporte(id) {
  const r = await pool.query(
    `DELETE FROM sst.documentos_electronicos WHERE id = $1 AND tipo = ANY($2) AND estado = 'BORRADOR' RETURNING id`, [id, TIPOS],
  );
  if (!r.rows[0]) throw conflict('Solo se puede eliminar un documento en BORRADOR (o ya no existe).');
  return { id };
}
