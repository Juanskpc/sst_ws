import crypto from 'node:crypto';
import { pool, withTransaction } from '../../config/db.js';
import { badRequest, conflict, notFound } from '../../utils/httpError.js';
import { aCentavos, deCentavos, sumar } from '../../utils/dinero.js';
import { calcularDocumento } from './calculo.js';
import { resolverSeleccion } from './relacion.service.js';
import { hoyCO } from '../../utils/formato.js';

/**
 * `reference_code`: la clave de idempotencia frente a Factus (§5.1.5 del plan).
 * Exportada porque A1-07 (`emision.service.js`, `corregirDocumento`) genera una
 * NUEVA al reintentar un documento RECHAZADO — nunca reutiliza la vieja.
 */
export const generarReferenceCode = () => `ORB-FACTURA-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

/**
 * A1-04 (FEL-04..07, 17) · Borrador de factura con cálculo de impuestos.
 *
 * Construye el documento en BORRADOR a partir de la selección que valida A1-03
 * (`resolverSeleccion`): una línea por orden (Bolívar, por fila de prefactura),
 * con su descripción interpolada, y el cálculo de `calculo.js` (bruto →
 * descuento comercial → IVA → retenciones → total). Siempre editable a mano
 * (`actualizarBorrador`) antes de emitir (A1-05, que no vive aquí).
 *
 * ⚠️ El código DIAN de unidad de medida es SIEMPRE '94' (unidad), incluso para
 * líneas por hora: el sandbox de Factus rechaza 'HUR' (hallazgo del 27-sep-2026,
 * §10.3 del plan — "cosmético: hoy va 94"). No confundir con
 * `productos.unidad_medida_id`, que es solo descriptivo.
 */

// ─── Plantilla de descripción (FEL-04 punto 2) ─────────────────────────────

/**
 * Abreviatura del tipo de actividad para la plantilla `{tipo_abreviado}`. No
 * hay un catálogo de abreviaturas confirmado por el cliente (semilla propuesta
 * en §3.4 del plan, sin verificar), así que es una heurística por palabra clave;
 * la descripción siempre se puede corregir a mano en el borrador.
 */
export function tipoAbreviado(texto) {
  const t = String(texto ?? '').toLowerCase();
  if (t.includes('capacit')) return 'CAP';
  if (t.includes('asesor')) return 'ASE';
  if (t.includes('inspec')) return 'INSP';
  if (t.includes('auditor')) return 'AUD';
  if (t.includes('investig')) return 'INV';
  const primera = String(texto ?? '').trim();
  return primera ? primera.slice(0, 4).toUpperCase() : 'SST';
}

/**
 * Interpola `{clave}` en la plantilla del pagador. Una variable sin dato
 * disponible se sustituye por vacío (nunca revienta el borrador): quien
 * factura corrige el texto a mano si hace falta.
 */
export function interpolarDescripcion(formato, vars) {
  return String(formato).replace(/\{(\w+)\}/g, (_, clave) => (vars[clave] ?? '').toString());
}

function variablesDeLinea(l) {
  return {
    numero_orden: l.numero_orden || l.codigo || '',
    tipo_abreviado: tipoAbreviado(l.tipo_actividad),
    tema: l.tema_actividad || l.tipo_actividad || '',
    // Q-25 (nueva, sin campo confirmado en `ordenes_servicio`): ningún dato
    // extraído hoy se llama "número de autorización" (ver §10 del plan al
    // cerrar esta ficha). Queda vacío a propósito: inventar un campo sería
    // peor que dejarlo en blanco para que se escriba a mano.
    numero_autorizacion: '',
    cronograma: l.codigo_cronograma || '',
    secuencia: l.secuencia || '',
    empresa: l.empresa_nombre || '',
  };
}

function descripcionPorDefecto(l, vars) {
  if (l.origen_valor === 'PREFACTURA') {
    return [vars.empresa, l.tipo_actividad].filter(Boolean).join(' — ') || 'Servicio SST';
  }
  const tema = vars.tema && vars.tema !== l.tipo_actividad ? ` — ${vars.tema}` : '';
  return `${l.tipo_actividad || 'Servicio SST'}${tema} (OS ${vars.numero_orden || '—'})`;
}

// ─── Ítem a partir de una línea de la relación (A1-03) ─────────────────────

/**
 * Cantidad y valor unitario de la línea. Las de prefactura (Bolívar) llegan
 * como un único paquete —`valor_a_facturar` ya incluye viáticos— así que se
 * facturan como 1 unidad por ese valor, no como horas: prorratear un paquete a
 * "horas" inventaría un valor-hora que la prefactura no dice.
 */
function cantidadYValorUnitario(l) {
  if (l.origen_valor === 'PREFACTURA') return { cantidad: 1, valorUnitario: Number(l.valor_referencia) };
  const cantidad = l.horas && Number(l.horas) > 0 ? Number(l.horas) : 1;
  if (l.valor_unitario != null) return { cantidad, valorUnitario: Number(l.valor_unitario) };
  // Un total fijo (el valor escrito en la orden) repartido en horas solo se
  // factura por horas si el valor hora sale exacto al centavo: $350.000 en 3 h
  // daría 3 × 116.666,67 = 350.000,01, y el proveedor rechaza la factura porque
  // la suma de líneas ya no cuadra con el pago. En ese caso va como 1 unidad por
  // el total, igual que un paquete de prefactura.
  const total = aCentavos(l.valor_referencia);
  const unitario = Math.round(total / cantidad);
  if (Math.round(unitario * cantidad) !== total) return { cantidad: 1, valorUnitario: Number(l.valor_referencia) };
  return { cantidad, valorUnitario: Number(deCentavos(unitario)) };
}

function construirItemDesdeLinea(l, { productoArl, productoPrivado, formatoDescripcion }) {
  // A0-06/Q-14: a la ARL se le factura EXENTO; a un pagador que no es ARL, el
  // producto GRAVADO (19 %). Con solo dos productos sembrados hoy, es la única
  // regla que tiene sentido de negocio; el borrador deja cambiar el producto.
  const producto = l.es_arl ? productoArl : productoPrivado;
  if (!producto) {
    throw badRequest('No hay un producto configurado para ese tipo de pagador (Parametrización → Productos).');
  }
  const { cantidad, valorUnitario } = cantidadYValorUnitario(l);
  const vars = variablesDeLinea(l);
  const descripcion = formatoDescripcion ? interpolarDescripcion(formatoDescripcion, vars) : descripcionPorDefecto(l, vars);
  return {
    orden_id: l.orden_id,
    producto_id: producto.id,
    codigo: producto.codigo,
    descripcion,
    cantidad,
    valor_unitario: valorUnitario,
    iva_pct: producto.tratamiento_iva === 'GRAVADO' ? Number(producto.tarifa_iva) : 0,
  };
}

// ─── Datos de referencia (productos, retenciones, condición, catálogos) ────

async function productosPorDefecto(client) {
  const r = await client.query(`SELECT id, codigo, tratamiento_iva, tarifa_iva FROM sst.productos WHERE activo ORDER BY codigo`);
  return {
    productoArl: r.rows.find((p) => p.tratamiento_iva === 'EXENTO') ?? null,
    productoPrivado: r.rows.find((p) => p.tratamiento_iva === 'GRAVADO') ?? null,
  };
}

async function condicionDelPagador(terceroId, client) {
  const r = await client.query(
    `SELECT retenciones_ids, descuento_comercial_pct, plazo_dias, formato_descripcion
       FROM sst.condiciones_pagador WHERE tercero_id = $1`,
    [terceroId],
  );
  // Sin fila = ninguna condición particular: sin descuento, contado, sin retención.
  return r.rows[0] ?? { retenciones_ids: [], descuento_comercial_pct: 0, plazo_dias: 0, formato_descripcion: null };
}

async function retencionesDeVenta(ids, client) {
  if (!ids?.length) return [];
  const r = await client.query(
    `SELECT id, codigo, tipo, tarifa FROM sst.retenciones WHERE id = ANY($1) AND activa`,
    [ids],
  );
  return r.rows;
}

async function formaYMedioPago(plazoDias, client) {
  const codigoForma = plazoDias > 0 ? '2' : '1'; // crédito si hay plazo, si no, contado
  const [forma, medio] = await Promise.all([
    client.query(`SELECT id FROM sst.formas_pago WHERE codigo_dian = $1`, [codigoForma]),
    client.query(`SELECT id FROM sst.medios_pago WHERE codigo_dian = 'ZZZ'`), // "Otro", como en las facturas reales (A1-02)
  ]);
  return { formaPagoId: forma.rows[0]?.id ?? null, medioPagoId: medio.rows[0]?.id ?? null };
}

// ─── Cálculo común (creación y edición) ─────────────────────────────────────

/** Corre `calculo.js` sobre los ítems ya resueltos (con `iva_pct`) y las retenciones de venta. */
function calcular(items, descuentoComercialPct, retenciones) {
  if (!items.length) throw badRequest('El borrador no tiene ítems.');
  return calcularDocumento({
    items: items.map((it) => ({ cantidad: it.cantidad, valorUnitario: it.valor_unitario, ivaPct: it.iva_pct })),
    descuentoComercialPct,
    retenciones: retenciones.map((r) => ({ codigo: r.codigo, tipo: r.tipo, tarifa: Number(r.tarifa) })),
  });
}

/**
 * Guarda (INSERT si `documentoId` es null, UPDATE si no) el documento + sus
 * ítems + los tributos de cada ítem, dentro de la transacción `client`.
 *
 * `respuesta_proveedor` se usa como bodega temporal del `descuento_comercial_pct`
 * usado (§ nota más abajo, `obtenerBorrador`) MIENTRAS el documento sigue en
 * BORRADOR: A1-05 la sobreescribe con la respuesta real de Factus al emitir, y
 * a partir de ahí ya no hace falta recalcular (el documento queda fijo).
 */
async function guardarDocumento(client, { documentoId, pagador, prefactura, items, calculo, descuentoComercialPct, retenciones, observaciones, fechaEmision, formaPagoId, medioPagoId, plazoDias, usuarioId }) {
  const fechaVencimiento = plazoDias > 0
    ? new Date(new Date(`${fechaEmision}T00:00:00Z`).getTime() + plazoDias * 86400000).toISOString().slice(0, 10)
    : fechaEmision;

  let docId = documentoId;
  if (!docId) {
    const referenceCode = generarReferenceCode();
    const ins = await client.query(
      `INSERT INTO sst.documentos_electronicos
         (tipo, reference_code, estado, tercero_id, prefactura_id, fecha_emision, fecha_vencimiento,
          forma_pago_id, medio_pago_id, observaciones,
          total_bruto, total_descuento, subtotal, total_iva, total_retenciones, total_a_pagar,
          respuesta_proveedor, creado_por, actualizado_por)
       VALUES ('FACTURA', $1, 'BORRADOR', $2, $3, $4, $5, $6, $7, $8, $9,$10,$11,$12,$13,$14, $15, $16, $16)
       RETURNING id`,
      [
        referenceCode, pagador.tercero_id, prefactura?.id ?? null, fechaEmision, fechaVencimiento,
        formaPagoId, medioPagoId, observaciones ?? null,
        deCentavos(calculo.totalBruto), deCentavos(calculo.totalDescuento), deCentavos(calculo.subtotal),
        deCentavos(calculo.totalIva), deCentavos(calculo.totalRetenciones), deCentavos(calculo.totalAPagar),
        JSON.stringify({ calculo_meta: { descuento_comercial_pct: descuentoComercialPct } }),
        usuarioId,
      ],
    );
    docId = ins.rows[0].id;
    await client.query(
      `INSERT INTO sst.documento_eventos (documento_id, codigo, descripcion, usuario_id)
       VALUES ($1, 'CREADO', 'Borrador creado desde la relación a facturar.', $2)`,
      [docId, usuarioId],
    );
  } else {
    const doc = (await client.query(`SELECT estado, tercero_id FROM sst.documentos_electronicos WHERE id = $1`, [docId])).rows[0];
    if (!doc) throw notFound('El borrador ya no existe.');
    if (doc.estado !== 'BORRADOR') throw conflict('Solo se puede editar un documento en BORRADOR.');
    if (doc.tercero_id !== pagador.tercero_id) throw badRequest('No se puede cambiar el pagador de un borrador ya creado.');
    await client.query(
      `UPDATE sst.documentos_electronicos
          SET fecha_emision=$2, fecha_vencimiento=$3, forma_pago_id=$4, medio_pago_id=$5, observaciones=$6,
              total_bruto=$7, total_descuento=$8, subtotal=$9, total_iva=$10, total_retenciones=$11, total_a_pagar=$12,
              respuesta_proveedor=$13, actualizado_por=$14
        WHERE id = $1`,
      [
        docId, fechaEmision, fechaVencimiento, formaPagoId, medioPagoId, observaciones ?? null,
        deCentavos(calculo.totalBruto), deCentavos(calculo.totalDescuento), deCentavos(calculo.subtotal),
        deCentavos(calculo.totalIva), deCentavos(calculo.totalRetenciones), deCentavos(calculo.totalAPagar),
        JSON.stringify({ calculo_meta: { descuento_comercial_pct: descuentoComercialPct } }),
        usuarioId,
      ],
    );
    await client.query(`DELETE FROM sst.documento_items WHERE documento_id = $1`, [docId]); // CASCADE se lleva sus tributos
    await client.query(`DELETE FROM sst.documento_ordenes WHERE documento_id = $1`, [docId]);
    await client.query(
      `INSERT INTO sst.documento_eventos (documento_id, codigo, descripcion, usuario_id)
       VALUES ($1, 'EDITADO', 'Borrador editado.', $2)`,
      [docId, usuarioId],
    );
  }

  for (const [i, it] of items.entries()) {
    const c = calculo.items[i];
    const item = await client.query(
      `INSERT INTO sst.documento_items
         (documento_id, orden_id, producto_id, codigo, descripcion, cantidad, valor_unitario, descuento, base, total_linea, orden)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [docId, it.orden_id, it.producto_id, it.codigo, it.descripcion, it.cantidad, deCentavos(aCentavos(it.valor_unitario)),
        deCentavos(c.descuento), deCentavos(c.base), deCentavos(c.totalLinea), i],
    );
    const itemId = item.rows[0].id;
    if (it.iva_pct > 0) {
      await client.query(
        `INSERT INTO sst.documento_item_tributos (item_id, tributo_codigo, base, tarifa, valor)
         VALUES ($1, '01', $2, $3, $4)`,
        [itemId, deCentavos(c.base), it.iva_pct, deCentavos(c.iva)],
      );
    }
    if (it.orden_id) {
      await client.query(
        `INSERT INTO sst.documento_ordenes (documento_id, orden_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [docId, it.orden_id],
      );
    }
  }

  // Las retenciones son del DOCUMENTO (base = subtotal), no de una línea: en
  // las facturas reales aparecen una sola vez, no prorrateadas ítem por ítem
  // (§3.4 del plan). El esquema exige un `item_id` (trampa: no admite NULL), así
  // que se cuelgan del ÚLTIMO ítem, que es tan válido como cualquier otro para
  // guardar un dato que en realidad es del documento — no se reparte su valor.
  if (calculo.retenciones.length && items.length) {
    const ultimoItemId = (await client.query(
      `SELECT id FROM sst.documento_items WHERE documento_id = $1 ORDER BY orden DESC LIMIT 1`, [docId],
    )).rows[0].id;
    for (const ret of calculo.retenciones) {
      const original = retenciones.find((r) => r.codigo === ret.codigo);
      await client.query(
        `INSERT INTO sst.documento_item_tributos (item_id, retencion_id, base, tarifa, valor)
         VALUES ($1,$2,$3,$4,$5)`,
        [ultimoItemId, original?.id ?? null, deCentavos(ret.base), ret.tarifa, deCentavos(ret.valor)],
      );
    }
  }

  return docId;
}

// ─── API pública del módulo ─────────────────────────────────────────────────

/**
 * Corre `fn` dentro de la transacción `dbClient` si ya se está dentro de una
 * (los scripts de verificación con ROLLBACK la pasan), o abre una propia si no.
 * Mismo patrón que `relacion.service.js` (`db = pool`), adaptado a que aquí la
 * operación siempre necesita una transacción, nunca una sola consulta suelta.
 */
function conTransaccion(dbClient, fn) {
  return dbClient ? fn(dbClient) : withTransaction(fn);
}

/**
 * Crea el borrador desde una selección de A1-03 (misma forma que
 * `resolverSeleccion`: `{ arl_id | pagador_tercero_id, orden_ids }` o, en Bolívar,
 * `{ arl_id, prefactura_id, fila_ids }`). `dbClient` es solo para los scripts
 * de verificación (todo en una transacción con ROLLBACK); el resto del código
 * lo deja vacío.
 */
export async function crearBorrador({ arlId, pagadorTerceroId, ordenIds, prefacturaId, filaIds, observaciones, usuarioId }, dbClient = null) {
  return conTransaccion(dbClient, async (client) => {
    // Revalida DENTRO de la transacción: nada de fiarse de una selección hecha
    // hace rato en el navegador mientras otra persona creaba otro borrador.
    const seleccion = await resolverSeleccion({ arlId, pagadorTerceroId, ordenIds, prefacturaId, filaIds }, client);
    const pagador = seleccion.pagador;

    const [{ productoArl, productoPrivado }, condicion] = await Promise.all([
      productosPorDefecto(client),
      condicionDelPagador(pagador.tercero_id, client),
    ]);
    const esArl = (await client.query(`SELECT es_arl FROM sst.terceros WHERE id = $1`, [pagador.tercero_id])).rows[0].es_arl;
    const lineasConEsArl = seleccion.lineas.map((l) => ({ ...l, es_arl: esArl }));

    const sinValor = lineasConEsArl.filter((l) => l.valor_referencia == null);
    if (sinValor.length) {
      throw badRequest(
        `${sinValor.length === 1 ? 'Una línea no tiene' : `${sinValor.length} líneas no tienen`} un valor con qué facturar `
        + '(falta la tarifa de venta del pagador): '
        + sinValor.map((l) => l.codigo ?? `${l.codigo_cronograma}/${l.secuencia}`).join(', ') + '.',
      );
    }

    const retenciones = await retencionesDeVenta(condicion.retenciones_ids, client);
    const items = lineasConEsArl.flatMap((l) => {
      const honorarios = construirItemDesdeLinea(l, {
        productoArl, productoPrivado, formatoDescripcion: condicion.formato_descripcion,
      });
      // 30-sep-2026 · Los gastos que aprobó operación (transporte, alojamiento,
      // alimentación, tiempo muerto, material) van en su PROPIO ítem, con el
      // mismo producto: mezclarlos con las horas inventaría un valor hora que no
      // es el pactado. Las líneas de prefactura ya los traen dentro (gastos = 0).
      if (!(Number(l.gastos) > 0)) return [honorarios];
      return [honorarios, {
        ...honorarios,
        descripcion: `Gastos de desplazamiento (OS ${l.numero_orden || l.codigo || '—'})`,
        cantidad: 1,
        valor_unitario: Number(l.gastos),
      }];
    });
    const descuentoComercialPct = Number(condicion.descuento_comercial_pct) || 0;
    const calculo = calcular(items, descuentoComercialPct, retenciones);

    const fechaEmision = hoyCO();
    const { formaPagoId, medioPagoId } = await formaYMedioPago(condicion.plazo_dias, client);

    const docId = await guardarDocumento(client, {
      documentoId: null, pagador, prefactura: seleccion.prefactura, items, calculo,
      descuentoComercialPct, retenciones, observaciones, fechaEmision,
      formaPagoId, medioPagoId, plazoDias: condicion.plazo_dias, usuarioId,
    });
    return obtenerBorrador(docId, client);
  });
}

const DOCUMENTO_SELECT = `
  d.id, d.tipo, d.estado, d.reference_code, d.numero, d.prefijo,
  d.tercero_id, COALESCE(t.razon_social, btrim(concat_ws(' ', t.nombres, t.apellidos))) AS tercero_nombre,
  d.prefactura_id, pf.numero_prefactura,
  to_char(d.fecha_emision, 'YYYY-MM-DD') AS fecha_emision,
  to_char(d.fecha_vencimiento, 'YYYY-MM-DD') AS fecha_vencimiento,
  d.forma_pago_id, fp.nombre AS forma_pago_nombre, d.medio_pago_id, mp.nombre AS medio_pago_nombre,
  d.observaciones,
  d.total_bruto, d.total_descuento, d.subtotal, d.total_iva, d.total_retenciones, d.total_a_pagar,
  -- A1-05: se añaden aquí (no solo se escriben al validar) porque este SELECT
  -- es el único que arma el detalle de un documento para toda la pantalla; sin
  -- ellas, pdf_path/xml_path quedaban guardados en BD pero invisibles para
  -- quien los lee (el bug que costó una vuelta entera al verificar A1-05).
  d.cufe, d.qr_url, d.pdf_path, d.xml_path, d.errores,
  -- A2-01 · en una nota crédito: a qué factura corrige y por qué causal DIAN.
  d.causal, d.documento_referencia_id, ref.prefijo AS referencia_prefijo, ref.numero AS referencia_numero,
  -- A4-01 · en un documento soporte: la cuenta de cobro de la que sale.
  d.precuenta_id,
  d.creado_en, d.actualizado_en`;
const DOCUMENTO_FROM = `
  FROM sst.documentos_electronicos d
  JOIN sst.terceros t ON t.id = d.tercero_id
  LEFT JOIN sst.prefacturas pf ON pf.id = d.prefactura_id
  LEFT JOIN sst.formas_pago fp ON fp.id = d.forma_pago_id
  LEFT JOIN sst.medios_pago mp ON mp.id = d.medio_pago_id
  LEFT JOIN sst.documentos_electronicos ref ON ref.id = d.documento_referencia_id`;

export async function listarBorradores({ estado = 'BORRADOR', arlId, pagadorTerceroId, tipo = 'FACTURA' } = {}, client = pool) {
  // A1-08 · la pestaña «Emitidas» pide varios estados a la vez (VALIDADO,
  // RECHAZADO, ENVIANDO): se aceptan separados por coma.
  const params = [String(estado).split(',').map((e) => e.trim().toUpperCase()).filter(Boolean), tipo];
  let filtroArl = '';
  if (arlId) {
    params.push(arlId);
    filtroArl = ` AND EXISTS (SELECT 1 FROM sst.arls a WHERE a.tercero_id = d.tercero_id AND a.id = $3)`;
  } else if (pagadorTerceroId) {
    // A3-01 · Cliente particular: el tercero del documento ES el pagador.
    params.push(pagadorTerceroId);
    filtroArl = ` AND d.tercero_id = $3`;
  }
  const r = await client.query(
    `SELECT ${DOCUMENTO_SELECT} ${DOCUMENTO_FROM} WHERE d.tipo = $2 AND d.estado::text = ANY($1)${filtroArl}
      ORDER BY d.creado_en DESC`,
    params,
  );
  return r.rows;
}

/**
 * Detalle con los ítems y, si sigue en BORRADOR, los totales RECALCULADOS en el
 * momento (no solo los que quedaron guardados la última vez que se editó): usa
 * el `descuento_comercial_pct` que quedó en `respuesta_proveedor.calculo_meta`
 * al crear/editar (ver la nota de `guardarDocumento`). Un documento ya emitido
 * no se recalcula: quedó fijo en el momento de validarse.
 */
export async function obtenerBorrador(id, client = pool) {
  // A2-01 · el mismo detalle sirve para la nota crédito y (A4-01) el documento soporte.
  const doc = (await client.query(`SELECT ${DOCUMENTO_SELECT}, d.respuesta_proveedor ${DOCUMENTO_FROM} WHERE d.id = $1 AND d.tipo IN ('FACTURA', 'NOTA_CREDITO', 'DOC_SOPORTE', 'NOTA_AJUSTE_DS')`, [id])).rows[0];
  if (!doc) throw notFound('Ese documento no existe.');

  // A1-07 · la línea de tiempo del documento: propios de Orbita (CREADO,
  // ENVIANDO, VALIDADO, RECHAZADO, CORREGIDO…) y los que trae la DIAN vía
  // "Consultar eventos" (prefijo RADIAN_, ver eventos.service.js).
  const eventos = (await client.query(
    `SELECT codigo, descripcion, fecha, datos FROM sst.documento_eventos WHERE documento_id = $1 ORDER BY fecha`,
    [id],
  )).rows;

  const items = (await client.query(
    `SELECT id, orden_id, producto_id, codigo, descripcion, cantidad, valor_unitario, descuento, base, total_linea, orden
       FROM sst.documento_items WHERE documento_id = $1 ORDER BY orden`,
    [id],
  )).rows;
  const itemIds = items.map((i) => i.id);
  const tributos = itemIds.length ? (await client.query(
    `SELECT it.item_id, it.retencion_id, it.tributo_codigo, it.base, it.tarifa, it.valor,
            r.codigo AS retencion_codigo, r.tipo AS retencion_tipo
       FROM sst.documento_item_tributos it LEFT JOIN sst.retenciones r ON r.id = it.retencion_id
      WHERE it.item_id = ANY($1)`,
    [itemIds],
  )).rows : [];

  const ivaPorItem = new Map(tributos.filter((t) => t.retencion_id == null).map((t) => [t.item_id, t]));
  const retencionesAplicadas = tributos.filter((t) => t.retencion_id != null);

  let calculoVivo = null;
  if (doc.estado === 'BORRADOR' && items.length) {
    const pct = Number(doc.respuesta_proveedor?.calculo_meta?.descuento_comercial_pct) || 0;
    calculoVivo = calcular(
      items.map((it) => ({ cantidad: Number(it.cantidad), valor_unitario: Number(it.valor_unitario), iva_pct: Number(ivaPorItem.get(it.id)?.tarifa) || 0 })),
      pct,
      retencionesAplicadas.map((t) => ({ codigo: t.retencion_codigo, tipo: t.retencion_tipo, tarifa: Number(t.tarifa) })),
    );
  }

  return {
    ...doc,
    eventos,
    items: items.map((it, i) => ({
      ...it,
      iva_pct: Number(ivaPorItem.get(it.id)?.tarifa) || 0,
      iva_valor: ivaPorItem.get(it.id)?.valor ?? '0.00',
      // Con el recálculo vivo disponible, el total de la línea que se muestra
      // es el de HOY (por si un cambio de descuento la movió un céntimo); si
      // no, el que quedó guardado.
      total_linea: calculoVivo ? deCentavos(calculoVivo.items[i].totalLinea) : it.total_linea,
    })),
    retenciones: retencionesAplicadas.map((t) => ({ codigo: t.retencion_codigo, tipo: t.retencion_tipo, tarifa: t.tarifa, valor: t.valor })),
    totales: calculoVivo ? {
      total_bruto: deCentavos(calculoVivo.totalBruto), total_descuento: deCentavos(calculoVivo.totalDescuento),
      subtotal: deCentavos(calculoVivo.subtotal), total_iva: deCentavos(calculoVivo.totalIva),
      total_retenciones: deCentavos(calculoVivo.totalRetenciones), total_a_pagar: deCentavos(calculoVivo.totalAPagar),
    } : {
      total_bruto: doc.total_bruto, total_descuento: doc.total_descuento, subtotal: doc.subtotal,
      total_iva: doc.total_iva, total_retenciones: doc.total_retenciones, total_a_pagar: doc.total_a_pagar,
    },
  };
}

/**
 * Reemplaza los ítems del borrador (edición manual: descripción, cantidad,
 * valor unitario, producto) y opcionalmente el descuento, las retenciones,
 * fechas y observaciones. Solo sobre un documento en BORRADOR.
 */
export async function actualizarBorrador(id, body, usuarioId, dbClient = null) {
  return conTransaccion(dbClient, async (client) => {
    const actual = (await client.query(`SELECT tercero_id, prefactura_id, estado FROM sst.documentos_electronicos WHERE id = $1 AND tipo = 'FACTURA'`, [id])).rows[0];
    if (!actual) throw notFound('Esa factura no existe.');
    if (actual.estado !== 'BORRADOR') throw conflict('Solo se puede editar un documento en BORRADOR.');

    if (!Array.isArray(body.items) || !body.items.length) throw badRequest('El borrador necesita al menos un ítem.');
    const productos = new Map((await client.query(`SELECT id, codigo, tratamiento_iva, tarifa_iva FROM sst.productos`)).rows.map((p) => [p.id, p]));
    const items = body.items.map((raw, idx) => {
      const cantidad = Number(raw.cantidad);
      const valorUnitario = Number(raw.valor_unitario);
      if (!Number.isFinite(cantidad) || cantidad <= 0) throw badRequest(`Ítem ${idx + 1}: la cantidad debe ser mayor que cero.`);
      if (!Number.isFinite(valorUnitario) || valorUnitario < 0) throw badRequest(`Ítem ${idx + 1}: el valor unitario debe ser un número positivo.`);
      const descripcion = String(raw.descripcion ?? '').trim();
      if (!descripcion) throw badRequest(`Ítem ${idx + 1}: la descripción es obligatoria.`);
      const producto = raw.producto_id ? productos.get(raw.producto_id) : null;
      if (raw.producto_id && !producto) throw badRequest(`Ítem ${idx + 1}: ese producto no existe.`);
      return {
        orden_id: raw.orden_id ?? null,
        producto_id: producto?.id ?? null,
        codigo: producto?.codigo ?? raw.codigo ?? null,
        descripcion,
        cantidad,
        // Al centavo ANTES de calcular: es lo que se guarda y lo que se envía, y
        // el total tiene que salir de ese mismo número (ver cantidadYValorUnitario).
        valor_unitario: Number(deCentavos(aCentavos(valorUnitario))),
        iva_pct: producto?.tratamiento_iva === 'GRAVADO' ? Number(producto.tarifa_iva) : Number(raw.iva_pct) || 0,
      };
    });

    // Nada impide, por la forma del cuerpo, que alguien edite un borrador
    // metiéndole el orden_id de OTRA orden que ya está en un documento ajeno
    // (o de otro pagador): `resolverSeleccion` ya no corre aquí (esto es edición
    // libre de texto/cifras), así que se revalida a mano lo que sí es dinero.
    const ordenIds = items.map((it) => it.orden_id).filter(Boolean);
    if (ordenIds.length) {
      const choques = (await client.query(
        `SELECT DISTINCT o.orden_id FROM sst.documento_ordenes o
           JOIN sst.documentos_electronicos d ON d.id = o.documento_id
          WHERE o.orden_id = ANY($1) AND o.documento_id <> $2 AND d.estado IN ('BORRADOR', 'ENVIANDO', 'VALIDADO')`,
        [ordenIds, id],
      )).rows;
      if (choques.length) throw conflict('Alguna orden del borrador ya está en otra factura (borrador, enviando o validada).');
      const otroPagador = (await client.query(
        // A3-01 · El pagador de una orden particular es su propio tercero.
        `SELECT o.codigo FROM sst.ordenes_servicio o LEFT JOIN sst.arls a ON a.id = o.arl_id
          WHERE o.id = ANY($1) AND COALESCE(a.tercero_id, o.pagador_tercero_id) IS DISTINCT FROM $2`,
        [ordenIds, actual.tercero_id],
      )).rows;
      if (otroPagador.length) throw badRequest(`Alguna orden no es del pagador de este borrador: ${otroPagador.map((o) => o.codigo).join(', ')}.`);
    }

    const descuentoComercialPct = body.descuento_comercial_pct != null ? Number(body.descuento_comercial_pct) : 0;
    if (!Number.isFinite(descuentoComercialPct) || descuentoComercialPct < 0 || descuentoComercialPct > 100) {
      throw badRequest('El descuento comercial debe ser un número entre 0 y 100.');
    }
    const retenciones = await retencionesDeVenta(body.retenciones_ids, client);
    const calculo = calcular(items, descuentoComercialPct, retenciones);

    const fechaEmision = /^\d{4}-\d{2}-\d{2}$/.test(body.fecha_emision) ? body.fecha_emision : hoyCO();
    const plazoDias = Number.isFinite(Number(body.plazo_dias)) ? Number(body.plazo_dias) : 0;
    const { formaPagoId, medioPagoId } = await formaYMedioPago(plazoDias, client);

    const pagador = { tercero_id: actual.tercero_id };
    const prefactura = actual.prefactura_id ? { id: actual.prefactura_id } : null;
    await guardarDocumento(client, {
      documentoId: id, pagador, prefactura, items, calculo, descuentoComercialPct, retenciones,
      observaciones: body.observaciones, fechaEmision, formaPagoId, medioPagoId, plazoDias, usuarioId,
    });
    return obtenerBorrador(id, client);
  });
}

export async function eliminarBorrador(id, dbClient = null) {
  const r = await (dbClient ?? pool).query(`DELETE FROM sst.documentos_electronicos WHERE id = $1 AND tipo IN ('FACTURA', 'NOTA_CREDITO') AND estado = 'BORRADOR' RETURNING id`, [id]);
  if (!r.rows[0]) throw conflict('Solo se puede eliminar un documento en BORRADOR (o ya no existe).');
  return { id };
}
