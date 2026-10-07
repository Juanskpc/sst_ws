import { pool, withTransaction } from '../../config/db.js';
import { badRequest, conflict, notFound } from '../../utils/httpError.js';
import { aCentavos, deCentavos } from '../../utils/dinero.js';
import { crearComprobante, obtenerComprobante } from './comprobantes.service.js';
import { resolvedorDeCuentas } from './reglas.service.js';
import { abrirCarteraDeFactura, aplicarNotaCredito, sincronizarCartera } from '../cartera/cartera.service.js';

/**
 * B2-01 (CNT-13, FEL-18) · Contabilización automática de facturas y notas crédito.
 *
 * Reproduce el asiento que hace hoy Siigo (§3.5 del plan, verificado al centavo
 * contra FV-1-809, FV-1-807 y NC-1-87 en `scripts/verificar-contabilizacion.mjs`):
 *
 *   Factura                                   Nota crédito (el espejo)
 *   D  CxC cliente ........ total a pagar     C  CxC cliente
 *   D  Retención en la fuente (la del cliente) C  Devolución de la retención
 *   D  ReteIVA (si la hay)                    C  Devolución de la ReteIVA
 *   D  Descuento comercial                    C  Reverso del descuento
 *   D  Autorretención (anticipo) 1,1 %        C  (misma cuenta)
 *   C  Autorretención por pagar 1,1 %         D  (misma cuenta)
 *   C  Ingreso, UNA LÍNEA POR ÍTEM (bruto)    D  Devolución, una línea por ítem
 *   C  IVA generado                           D  IVA de la devolución
 *
 * Todas las líneas llevan al cliente como tercero y el número del documento como
 * documento cruce, igual que en el auxiliar de Siigo.
 *
 * ⚠️ La factura ya es válida ante la DIAN cuando se contabiliza: si el asiento
 * falla (falta una regla, el mes está cerrado…) la factura NO se toca; queda
 * pendiente con su motivo y se reintenta desde Contabilidad.
 */

const PREFIJO_CONCEPTO = { FACTURA: 'FV', NOTA_CREDITO: 'NC', DOC_SOPORTE: 'DS' };

/** Número de pantalla (Factus ya trae el prefijo pegado; no se duplica). */
function numeroDocumento(d) {
  if (!d.numero) return null;
  return d.prefijo && !String(d.numero).startsWith(d.prefijo) ? `${d.prefijo}${d.numero}` : String(d.numero);
}

/** Redondeo half-up de `base × tarifa %`, en centavos (la regla que muestra Siigo). */
const porcentaje = (baseCentavos, tarifa) => Math.round((baseCentavos * Number(tarifa)) / 100);

/**
 * La autorretención del 1,1 % sobre el subtotal. Si la factura la trae calculada
 * (el pagador la tiene en sus condiciones), se usa esa; si no, se calcula con la
 * retención de tipo AUTORRETENCION activa, porque JD&D es autorretenedora en
 * TODAS sus ventas: en el auxiliar de septiembre la llevan las facturas a ARL y
 * también la de un privado con IVA (FV-1-807). Supuesto a confirmar con la
 * contadora (Q-28): si no hay ninguna activa, el asiento sale sin ella.
 */
async function autorretencion(client, guardada, subtotalCentavos) {
  if (guardada > 0) return guardada;
  const r = (await client.query(
    `SELECT tarifa FROM sst.retenciones WHERE tipo = 'AUTORRETENCION' AND aplica_a = 'VENTA' AND activa ORDER BY codigo LIMIT 1`,
  )).rows[0];
  return r ? porcentaje(subtotalCentavos, r.tarifa) : 0;
}

/**
 * Arma el asiento del documento SIN guardarlo (también sirve de vista previa de
 * un borrador). Devuelve el tipo de comprobante, la fecha y las líneas.
 */
export async function construirAsiento(documentoId, db = pool) {
  const d = (await db.query(
    `SELECT d.id, d.tipo, d.estado, d.tercero_id, d.prefijo, d.numero, d.reference_code,
            to_char(COALESCE(d.fecha_emision, d.creado_en::date), 'YYYY-MM-DD') AS fecha,
            d.total_descuento, d.subtotal, d.total_iva, d.total_a_pagar,
            COALESCE(t.razon_social, NULLIF(btrim(concat_ws(' ', t.nombres, t.apellidos)), '')) AS tercero_nombre
       FROM sst.documentos_electronicos d JOIN sst.terceros t ON t.id = d.tercero_id
      WHERE d.id = $1`,
    [documentoId],
  )).rows[0];
  if (!d) throw notFound('Ese documento no existe.');
  const pre = PREFIJO_CONCEPTO[d.tipo];
  if (!pre) throw badRequest('Ese tipo de documento no se contabiliza todavía.');
  if (d.tipo === 'DOC_SOPORTE') return asientoSoporte(d, db);
  const esNota = d.tipo === 'NOTA_CREDITO';

  const items = (await db.query(
    `SELECT id, producto_id, descripcion, base, descuento FROM sst.documento_items WHERE documento_id = $1 ORDER BY orden`,
    [documentoId],
  )).rows;
  if (!items.length) throw badRequest('El documento no tiene ítems.');
  const tributos = (await db.query(
    `SELECT t.valor, t.base, r.tipo AS retencion_tipo
       FROM sst.documento_item_tributos t
       JOIN sst.documento_items i ON i.id = t.item_id
       LEFT JOIN sst.retenciones r ON r.id = t.retencion_id
      WHERE i.documento_id = $1`,
    [documentoId],
  )).rows;
  const suma = (filtro) => tributos.filter(filtro).reduce((s, t) => s + aCentavos(t.valor), 0);
  const iva = suma((t) => !t.retencion_tipo);
  // Base gravada (solo los ítems con IVA): con ítems mixtos no es el subtotal.
  const baseIva = tributos.filter((t) => !t.retencion_tipo).reduce((s, t) => s + aCentavos(t.base), 0);
  const retefuente = suma((t) => t.retencion_tipo === 'RETEFUENTE');
  const reteiva = suma((t) => t.retencion_tipo === 'RETEIVA');
  const subtotal = aCentavos(d.subtotal);
  const auto = await autorretencion(db, suma((t) => t.retencion_tipo === 'AUTORRETENCION'), subtotal);

  const cuenta = await resolvedorDeCuentas(db, d.tercero_id);
  const numero = numeroDocumento(d) ?? d.reference_code;
  const lineas = [];
  // D/C según el documento: la nota crédito es el espejo de la factura.
  const linea = (concepto, lado, centavos, extra = {}) => {
    if (!centavos) return;
    const debe = esNota ? lado === 'C' : lado === 'D';
    lineas.push({
      cuenta_id: cuenta(concepto, extra.productoId ?? null),
      tercero_id: d.tercero_id,
      debito: debe ? deCentavos(centavos) : null,
      credito: debe ? null : deCentavos(centavos),
      base: extra.base != null ? deCentavos(extra.base) : null,
      descripcion: extra.descripcion ?? null,
      documento_cruce: numero,
      documento_cruce_id: d.id,
    });
  };

  linea(`${pre}_CXC`, 'D', aCentavos(d.total_a_pagar));
  linea(`${pre}_RETEFUENTE`, 'D', retefuente, { base: subtotal });
  linea(`${pre}_RETEIVA`, 'D', reteiva, { base: iva });
  linea(`${pre}_DESCUENTO`, 'D', aCentavos(d.total_descuento));
  // La autorretención usa las mismas dos cuentas en la factura y en su reverso.
  linea('FV_AUTORRET_DB', 'D', auto, { base: subtotal });
  linea('FV_AUTORRET_CR', 'C', auto, { base: subtotal });
  for (const it of items) {
    linea(esNota ? 'NC_DEVOLUCION' : 'FV_INGRESO', 'C', aCentavos(it.base) + aCentavos(it.descuento), {
      productoId: it.producto_id, descripcion: String(it.descripcion).slice(0, 500),
    });
  }
  linea(`${pre}_IVA`, 'C', iva, { base: baseIva });

  const debitos = lineas.reduce((s, l) => s + (l.debito ? aCentavos(l.debito) : 0), 0);
  const creditos = lineas.reduce((s, l) => s + (l.credito ? aCentavos(l.credito) : 0), 0);
  if (debitos !== creditos) {
    // No se "cuadra" a la fuerza: si los totales del documento no casan con sus
    // ítems, el error está en el documento y hay que verlo.
    throw badRequest(`El asiento de ${numero} no cuadra (débitos ${deCentavos(debitos)}, créditos ${deCentavos(creditos)}): revise los totales del documento.`);
  }

  return {
    documento: { id: d.id, tipo: d.tipo, estado: d.estado, numero, tercero_nombre: d.tercero_nombre },
    tipo_comprobante: pre,
    fecha: d.fecha,
    descripcion: `${esNota ? 'Nota crédito' : 'Factura de venta'} ${numero} · ${d.tercero_nombre}`,
    lineas,
    totales: { debito: deCentavos(debitos), credito: deCentavos(creditos) },
  };
}

/**
 * A4-01 · Asiento del documento soporte, como DS-1-1316 de Siigo:
 *
 *   D  Costo de honorarios, UNA LÍNEA POR ÍTEM, a la cuenta del PAGADOR de su orden
 *      (la ARL o el cliente particular: regla DS_COSTO de ese tercero; la general
 *      como respaldo). Un ítem con cuenta propia (DS manual, A4-02) usa esa.
 *   C  Honorarios por pagar al asesor (DS_CXP), por el total.
 *
 * Sin retención: el DS de la cuenta de cobro no la lleva (supuesto a confirmar).
 */
async function asientoSoporte(d, db) {
  const items = (await db.query(
    `SELECT i.id, i.descripcion, i.total_linea, i.cuenta_costo_id,
            COALESCE(a.tercero_id, o.pagador_tercero_id) AS pagador_tercero_id,
            COALESCE(a.nombre, NULLIF(btrim(COALESCE(tp.razon_social, concat_ws(' ', tp.nombres, tp.apellidos))), '')) AS pagador_nombre
       FROM sst.documento_items i
       LEFT JOIN sst.ordenes_servicio o ON o.id = i.orden_id
       LEFT JOIN sst.arls a ON a.id = o.arl_id
       LEFT JOIN sst.terceros tp ON tp.id = o.pagador_tercero_id
      WHERE i.documento_id = $1 ORDER BY i.orden`,
    [d.id],
  )).rows;
  if (!items.length) throw badRequest('El documento no tiene ítems.');

  const reglasCosto = (await db.query(
    `SELECT cuenta_id, tercero_id FROM sst.reglas_contables WHERE concepto = 'DS_COSTO' AND activa AND producto_id IS NULL`,
  )).rows;
  const costoDe = (it) => {
    if (it.cuenta_costo_id) return it.cuenta_costo_id;
    const regla = reglasCosto.find((r) => r.tercero_id && r.tercero_id === it.pagador_tercero_id)
      ?? reglasCosto.find((r) => !r.tercero_id);
    if (!regla) {
      throw badRequest(`Falta la regla contable «Costo de honorarios» para ${it.pagador_nombre ?? 'el pagador de la orden'} (Contabilidad → Reglas).`);
    }
    return regla.cuenta_id;
  };
  const cuenta = await resolvedorDeCuentas(db, d.tercero_id);
  const numero = numeroDocumento(d) ?? d.reference_code;
  const lineas = items.map((it) => ({
    cuenta_id: costoDe(it),
    tercero_id: d.tercero_id,
    debito: deCentavos(aCentavos(it.total_linea)),
    credito: null,
    base: null,
    descripcion: String(it.descripcion).slice(0, 500),
    documento_cruce: numero,
    documento_cruce_id: d.id,
  }));
  lineas.push({
    cuenta_id: cuenta('DS_CXP'),
    tercero_id: d.tercero_id,
    debito: null,
    credito: deCentavos(aCentavos(d.total_a_pagar)),
    base: null,
    descripcion: null,
    documento_cruce: numero,
    documento_cruce_id: d.id,
  });
  const debitos = lineas.reduce((s, l) => s + (l.debito ? aCentavos(l.debito) : 0), 0);
  const creditos = aCentavos(d.total_a_pagar);
  if (debitos !== creditos) {
    throw badRequest(`El asiento de ${numero} no cuadra (débitos ${deCentavos(debitos)}, créditos ${deCentavos(creditos)}): revise los totales del documento.`);
  }
  return {
    documento: { id: d.id, tipo: d.tipo, estado: d.estado, numero, tercero_nombre: d.tercero_nombre },
    tipo_comprobante: 'DS',
    fecha: d.fecha,
    descripcion: `Documento soporte ${numero} · ${d.tercero_nombre}`,
    lineas,
    totales: { debito: deCentavos(debitos), credito: deCentavos(creditos) },
  };
}

/** Vista previa con los nombres de cuenta (para la pantalla). */
export async function vistaPreviaAsiento(documentoId) {
  const a = await construirAsiento(documentoId);
  const cuentas = new Map((await pool.query(
    `SELECT id, codigo, nombre FROM sst.cuentas_contables WHERE id = ANY($1::uuid[])`,
    [a.lineas.map((l) => l.cuenta_id)],
  )).rows.map((c) => [c.id, c]));
  return {
    ...a,
    lineas: a.lineas.map((l, i) => ({
      ...l, linea: i + 1, cuenta_codigo: cuentas.get(l.cuenta_id)?.codigo, cuenta_nombre: cuentas.get(l.cuenta_id)?.nombre,
    })),
  };
}

/**
 * Contabiliza un documento VALIDADO (o ya ANULADO por una nota crédito: la
 * factura existió y su asiento también). Idempotente: si ya tiene comprobante, lo
 * devuelve.
 */
/** El trabajo de contabilizar, dentro de una transacción ya abierta (la usan la API y los scripts). */
export async function contabilizarEn(client, documentoId, usuarioId = null) {
  const d = (await client.query(
    `SELECT id, tipo, estado, comprobante_id FROM sst.documentos_electronicos WHERE id = $1 FOR UPDATE`, [documentoId],
  )).rows[0];
  if (!d) throw notFound('Ese documento no existe.');
  if (d.comprobante_id) return obtenerComprobante(d.comprobante_id, client);
  if (!['VALIDADO', 'ANULADO'].includes(d.estado)) {
    throw conflict('Solo se contabiliza un documento validado ante la DIAN.');
  }
  const a = await construirAsiento(documentoId, client);
  const comp = await crearComprobante({
    tipo: a.tipo_comprobante, fecha: a.fecha, descripcion: a.descripcion, lineas: a.lineas,
    origen_tipo: 'DOCUMENTO_ELECTRONICO', origen_id: documentoId, contabilizar: true,
  }, usuarioId, { client });
  await client.query(
    `UPDATE sst.documentos_electronicos SET comprobante_id = $2, contabilizacion_error = NULL WHERE id = $1`,
    [documentoId, comp.id],
  );
  // B3-01 · En la misma transacción que el asiento: la factura abre su cuenta por
  // cobrar (por lo que cargó a clientes) y la nota crédito baja la de su factura.
  // Así la cartera y el libro nunca quedan desfasados.
  if (d.tipo === 'FACTURA') {
    const cxc = a.lineas[0]?.debito ? a.lineas[0].cuenta_id : null; // FV_CXC es siempre la primera línea
    if (cxc) await abrirCarteraDeFactura(client, documentoId, cxc);
  } else if (d.tipo === 'NOTA_CREDITO') {
    await aplicarNotaCredito(client, documentoId);
  } else if (d.tipo === 'DOC_SOPORTE') {
    // A4-01 · El DS abre la cuenta por pagar al asesor (DS_CXP es la última línea);
    // se paga con un comprobante de egreso, como cualquier compra a crédito.
    const cxp = a.lineas[a.lineas.length - 1]?.credito ? a.lineas[a.lineas.length - 1].cuenta_id : null;
    if (cxp) await abrirCarteraDeFactura(client, documentoId, cxp, 'CXP');
  }
  return comp;
}

/**
 * Contabiliza un documento VALIDADO (o ya ANULADO por una nota crédito: la
 * factura existió y su asiento también). Idempotente: si ya tiene comprobante, lo
 * devuelve.
 */
export async function contabilizarDocumento(documentoId, usuarioId = null) {
  try {
    return await withTransaction((client) => contabilizarEn(client, documentoId, usuarioId));
  } catch (e) {
    // Se deja el motivo en el documento (fuera de la transacción que falló).
    await pool.query(`UPDATE sst.documentos_electronicos SET contabilizacion_error = $2 WHERE id = $1 AND comprobante_id IS NULL`,
      [documentoId, String(e.message).slice(0, 1000)]).catch(() => {});
    throw e;
  }
}

/** Para llamar justo después de validar ante la DIAN: nunca lanza (la factura ya es válida). */
export async function intentarContabilizar(documentoId, usuarioId = null) {
  try {
    const comp = await contabilizarDocumento(documentoId, usuarioId);
    return { ok: true, comprobante_id: comp.id, numero: comp.numero_completo };
  } catch (e) {
    console.warn(`[contabilidad] ${documentoId} quedó pendiente de contabilizar: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/** Documentos validados sin asiento, con el motivo si ya se intentó. */
export async function listarPendientes(db = pool) {
  const r = await db.query(
    `SELECT d.id, d.tipo, d.estado, d.prefijo, d.numero, to_char(d.fecha_emision, 'YYYY-MM-DD') AS fecha_emision,
            d.total_a_pagar, d.contabilizacion_error,
            COALESCE(t.razon_social, NULLIF(btrim(concat_ws(' ', t.nombres, t.apellidos)), '')) AS tercero_nombre
       FROM sst.documentos_electronicos d JOIN sst.terceros t ON t.id = d.tercero_id
      WHERE d.tipo IN ('FACTURA', 'NOTA_CREDITO', 'DOC_SOPORTE') AND d.estado IN ('VALIDADO', 'ANULADO') AND d.comprobante_id IS NULL
      ORDER BY d.fecha_emision NULLS LAST, d.creado_en`,
  );
  return r.rows.map((x) => ({ ...x, numero_completo: numeroDocumento(x) }));
}

/**
 * Backfill (lo emitido en la Fase A, antes de que existiera la contabilidad) y
 * reintento de los pendientes. En orden de emisión: la factura antes que su nota.
 */
export async function contabilizarPendientes(usuarioId = null) {
  const pendientes = await listarPendientes();
  const resultados = [];
  // Lo contabilizado antes de que existiera la cartera (B3-01) también la abre.
  const cartera = await sincronizarCartera().catch((e) => ({ error: e.message }));
  for (const p of pendientes) {
    const r = await intentarContabilizar(p.id, usuarioId);
    resultados.push({ documento: p.numero_completo, ...r });
  }
  return { procesados: resultados.length, contabilizados: resultados.filter((r) => r.ok).length, resultados, cartera };
}
