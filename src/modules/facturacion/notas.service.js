import crypto from 'node:crypto';
import { pool, withTransaction } from '../../config/db.js';
import { badRequest, conflict, notFound } from '../../utils/httpError.js';
import { aCentavos, deCentavos } from '../../utils/dinero.js';
import { storage } from '../../services/storage.service.js';
import { proveedorFE } from './index.js';
import { calcularDocumento } from './calculo.js';
import { obtenerBorrador } from './borrador.service.js';
import {
  cargarDocumentoParaEmitir, construirReceptor, contabilizarTrasValidar, finalizarRechazado, numeroCompleto,
  registrarFallaDeEnvio, registrarSinDecision, validarParaEmitir,
} from './emision.service.js';
import { hoyCO } from '../../utils/formato.js';

/**
 * A2-01 (FEL-11) · Nota crédito sobre una factura VALIDADA.
 *
 * Una nota crédito no se «edita» como un borrador de factura: se arma a partir
 * de la factura que corrige, eligiendo la causal DIAN y, si es parcial, qué
 * ítems y cuántas unidades devuelve. Después se emite con el mismo circuito de
 * dos fases que la factura (ENVIANDO confirmado antes de llamar a Factus).
 *
 * La causal «2 · Anulación» es la que tiene efecto en el eje de cobro: al
 * validarse, la factura pasa a ANULADO (el trigger de `documento_ordenes` suelta
 * sus órdenes) y cada orden vuelve a NO FACTURADA con historial, para poder
 * entrar en otra factura. Es el caso real FE-811 → FE-813 del §3.4 del plan.
 * Las demás causales dejan la factura VALIDADA y las órdenes facturadas.
 */

/** Tabla oficial de Factus (developers.factus.com.co/tablas-de-referencia, 29-sep-2026). */
export const CAUSALES_NOTA_CREDITO = {
  1: 'Devolución parcial de los bienes y/o no aceptación parcial del servicio',
  2: 'Anulación de factura electrónica',
  3: 'Rebaja o descuento parcial o total',
  4: 'Ajuste de precio',
  5: 'Descuento comercial por pronto pago',
  6: 'Descuento comercial por volumen de ventas',
};
const ANULACION = '2';

/**
 * Eventos tras los cuales, según Factus (pregunta 2 abierta), podría rechazarse
 * una nota crédito: aceptación expresa (033) o tácita (034, o el apunte interno
 * de ORBITA). No se bloquea — no está confirmado — pero se avisa.
 */
const EVENTO_ACEPTACION = /^(RADIAN_033|RADIAN_034|ACEPTACION_TACITA)$/;

const generarReferenceCodeNota = () => `ORB-NC-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

function conTransaccion(dbClient, fn) {
  return dbClient ? fn(dbClient) : withTransaction(fn);
}

/**
 * Crea la nota crédito en BORRADOR.
 * @param {string} facturaId
 * @param {{causal: string|number, lineas?: {item_id: string, cantidad: number}[], observaciones?: string}} datos
 *   Sin `lineas` (o con causal de anulación) se acredita la factura COMPLETA.
 */
export async function crearNotaCredito(facturaId, { causal, lineas, observaciones }, usuarioId, dbClient = null) {
  const codigo = String(causal ?? '').trim();
  if (!CAUSALES_NOTA_CREDITO[codigo]) throw badRequest('Elija la causal de la nota crédito (códigos 1 a 6 de la DIAN).');

  const creada = await conTransaccion(dbClient, async (client) => {
    const factura = (await client.query(
      `SELECT * FROM sst.documentos_electronicos WHERE id = $1 AND tipo = 'FACTURA' FOR UPDATE`, [facturaId],
    )).rows[0];
    if (!factura) throw notFound('Esa factura no existe.');
    if (factura.estado !== 'VALIDADO') {
      throw conflict(`Solo se hace nota crédito sobre una factura validada (esta está ${factura.estado.toLowerCase()}).`);
    }

    // Una nota a la vez por factura: dos borradores en paralelo acreditarían
    // dos veces lo mismo antes de que ninguno se valide.
    const abierta = (await client.query(
      `SELECT reference_code FROM sst.documentos_electronicos
        WHERE documento_referencia_id = $1 AND tipo = 'NOTA_CREDITO' AND estado IN ('BORRADOR', 'ENVIANDO', 'RECHAZADO')`,
      [facturaId],
    )).rows[0];
    if (abierta) throw conflict(`Esta factura ya tiene una nota crédito en curso (${abierta.reference_code}): emítala o elimínela primero.`);

    const itemsFactura = (await client.query(
      `SELECT it.id, it.orden_id, it.producto_id, it.codigo, it.descripcion, it.cantidad, it.valor_unitario,
              COALESCE(tiva.tarifa, 0) AS iva_pct
         FROM sst.documento_items it
         LEFT JOIN sst.documento_item_tributos tiva ON tiva.item_id = it.id AND tiva.retencion_id IS NULL
        WHERE it.documento_id = $1 ORDER BY it.orden`,
      [facturaId],
    )).rows;
    if (!itemsFactura.length) throw badRequest('La factura no tiene ítems.');

    // Lo ya acreditado por notas VALIDADAS, por ítem (se identifica por orden y
    // descripción: la nota copia los ítems de la factura). Sirve para no dejar
    // devolver más de lo facturado sumando varias notas parciales.
    const acreditado = (await client.query(
      `SELECT it.orden_id, it.descripcion, SUM(it.cantidad) AS cantidad
         FROM sst.documento_items it JOIN sst.documentos_electronicos d ON d.id = it.documento_id
        WHERE d.documento_referencia_id = $1 AND d.tipo = 'NOTA_CREDITO' AND d.estado = 'VALIDADO'
        GROUP BY 1, 2`,
      [facturaId],
    )).rows;
    const yaAcreditado = (it) => Number(acreditado.find((a) => a.orden_id === it.orden_id && a.descripcion === it.descripcion)?.cantidad ?? 0);

    let items;
    if (codigo === ANULACION || !lineas?.length) {
      if (acreditado.length) {
        throw conflict('La factura ya tiene notas crédito parciales validadas: una anulación total ya no cuadra. Acredite el saldo con una nota parcial.');
      }
      items = itemsFactura.map((it) => ({ ...it, cantidad: Number(it.cantidad) }));
    } else {
      items = lineas.map((l) => {
        const it = itemsFactura.find((x) => x.id === l.item_id);
        if (!it) throw badRequest('Algún ítem elegido no pertenece a esta factura.');
        const cantidad = Number(l.cantidad);
        const disponible = Number(it.cantidad) - yaAcreditado(it);
        if (!(cantidad > 0)) throw badRequest(`La cantidad de «${it.descripcion}» debe ser mayor que cero.`);
        if (cantidad > disponible + 1e-9) {
          throw badRequest(`De «${it.descripcion}» solo quedan ${disponible} por acreditar.`);
        }
        return { ...it, cantidad };
      });
    }

    // Mismas retenciones y mismo descuento comercial que la factura: la nota
    // es su espejo proporcional (así la registra Siigo, NC-1-87 del §3.5).
    const retenciones = (await client.query(
      `SELECT DISTINCT r.id, r.codigo, r.tipo, it.tarifa
         FROM sst.documento_item_tributos it
         JOIN sst.retenciones r ON r.id = it.retencion_id
         JOIN sst.documento_items di ON di.id = it.item_id
        WHERE di.documento_id = $1`,
      [facturaId],
    )).rows;
    const descuentoPct = Number(factura.total_bruto) > 0
      ? Math.round((Number(factura.total_descuento) / Number(factura.total_bruto)) * 10000) / 100
      : 0;

    const calculo = calcularDocumento({
      items: items.map((it) => ({ cantidad: it.cantidad, valorUnitario: Number(it.valor_unitario), ivaPct: Number(it.iva_pct) })),
      descuentoComercialPct: descuentoPct,
      retenciones: retenciones.map((r) => ({ codigo: r.codigo, tipo: r.tipo, tarifa: Number(r.tarifa) })),
    });

    const hoy = hoyCO();
    const numeroFactura = numeroCompleto(factura.prefijo, factura.numero);
    const nota = (await client.query(
      `INSERT INTO sst.documentos_electronicos
         (tipo, reference_code, estado, tercero_id, documento_referencia_id, causal, fecha_emision, fecha_vencimiento,
          forma_pago_id, medio_pago_id, observaciones,
          total_bruto, total_descuento, subtotal, total_iva, total_retenciones, total_a_pagar,
          respuesta_proveedor, creado_por, actualizado_por)
       VALUES ('NOTA_CREDITO', $1, 'BORRADOR', $2, $3, $4, $5, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16)
       RETURNING id`,
      [
        generarReferenceCodeNota(), factura.tercero_id, facturaId, codigo, hoy,
        factura.forma_pago_id, factura.medio_pago_id, observaciones?.trim() || null,
        deCentavos(calculo.totalBruto), deCentavos(calculo.totalDescuento), deCentavos(calculo.subtotal),
        deCentavos(calculo.totalIva), deCentavos(calculo.totalRetenciones), deCentavos(calculo.totalAPagar),
        JSON.stringify({ calculo_meta: { descuento_comercial_pct: descuentoPct } }),
        usuarioId,
      ],
    )).rows[0];

    let ultimoItemId = null;
    for (const [i, it] of items.entries()) {
      const c = calculo.items[i];
      ultimoItemId = (await client.query(
        `INSERT INTO sst.documento_items
           (documento_id, orden_id, producto_id, codigo, descripcion, cantidad, valor_unitario, descuento, base, total_linea, orden)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [nota.id, it.orden_id, it.producto_id, it.codigo, it.descripcion, it.cantidad,
          deCentavos(aCentavos(Number(it.valor_unitario))), deCentavos(c.descuento), deCentavos(c.base), deCentavos(c.totalLinea), i],
      )).rows[0].id;
      if (Number(it.iva_pct) > 0) {
        await client.query(
          `INSERT INTO sst.documento_item_tributos (item_id, tributo_codigo, base, tarifa, valor) VALUES ($1, '01', $2, $3, $4)`,
          [ultimoItemId, deCentavos(c.base), it.iva_pct, deCentavos(c.iva)],
        );
      }
    }
    // Retenciones del documento, colgadas del último ítem (mismo criterio que la factura).
    for (const ret of calculo.retenciones) {
      const original = retenciones.find((r) => r.codigo === ret.codigo);
      await client.query(
        `INSERT INTO sst.documento_item_tributos (item_id, retencion_id, base, tarifa, valor) VALUES ($1,$2,$3,$4,$5)`,
        [ultimoItemId, original?.id ?? null, deCentavos(ret.base), ret.tarifa, deCentavos(ret.valor)],
      );
    }

    await client.query(
      `INSERT INTO sst.documento_eventos (documento_id, codigo, descripcion, usuario_id) VALUES ($1, 'CREADO', $2, $3)`,
      [nota.id, `Nota crédito sobre la factura ${numeroFactura} · causal ${codigo}: ${CAUSALES_NOTA_CREDITO[codigo]}.`, usuarioId],
    );
    await client.query(
      `INSERT INTO sst.documento_eventos (documento_id, codigo, descripcion, usuario_id) VALUES ($1, 'NOTA_CREDITO_CREADA', $2, $3)`,
      [facturaId, `Se creó una nota crédito en borrador (causal ${codigo}: ${CAUSALES_NOTA_CREDITO[codigo]}).`, usuarioId],
    );

    const aceptada = (await client.query(
      `SELECT codigo FROM sst.documento_eventos WHERE documento_id = $1`, [facturaId],
    )).rows.some((e) => EVENTO_ACEPTACION.test(e.codigo));
    return { id: nota.id, aceptada };
  });

  const detalle = await obtenerBorrador(creada.id, dbClient ?? pool);
  return {
    ...detalle,
    advertencia: creada.aceptada
      ? 'La factura ya tiene un evento de aceptación: la nota crédito podría ser rechazada.'
      : null,
  };
}

/** Número de la factura que la nota corrige (Factus lo pide en `bill_number`). */
async function numeroDeFacturaReferida(nota, client) {
  const f = (await client.query(
    `SELECT prefijo, numero, estado FROM sst.documentos_electronicos WHERE id = $1`, [nota.documento_referencia_id],
  )).rows[0];
  if (!f?.numero) throw badRequest('La nota no tiene una factura validada a la cual referirse.');
  if (f.estado !== 'VALIDADO') throw conflict(`La factura referida está ${f.estado.toLowerCase()}: ya no admite notas crédito.`);
  return numeroCompleto(f.prefijo, f.numero);
}

async function intentarEmisionNota({ doc, items, retenciones, formaPagoCodigo, medioPagoCodigo, resolucion }, numeroFactura) {
  const descuentoComercialPct = Number(doc.respuesta_proveedor?.calculo_meta?.descuento_comercial_pct) || 0;
  return proveedorFE().emitirNotaCredito({
    referenceCode: doc.reference_code,
    conceptoCorreccion: doc.causal,
    numeroFactura,
    receptor: construirReceptor(doc),
    items: items.map((it) => ({
      codigo: it.codigo,
      descripcion: it.descripcion,
      cantidad: Number(it.cantidad),
      valorUnitario: Number(it.valor_unitario),
      unidadMedidaCodigo: '94',
      tarifaIva: Number(it.iva_pct) || 0,
    })),
    descuentoComercialPct,
    retenciones: retenciones.map((r) => ({ codigoFactus: r.factus_tributo_id, tarifa: Number(r.tarifa) })),
    numberingRangeId: resolucion.factus_rango_id ? Number(resolucion.factus_rango_id) : undefined,
    formaPagoCodigo,
    medioPagoCodigo,
    montoAPagar: deCentavos(Math.round((Number(doc.subtotal) + Number(doc.total_iva)) * 100)),
    fechaVencimiento: doc.fecha_vencimiento,
    observacion: doc.observaciones || CAUSALES_NOTA_CREDITO[doc.causal],
    enviarCorreo: true,
  });
}

/**
 * VALIDADA: número, CUDE, PDF y XML; y si es anulación, la factura queda ANULADO
 * y sus órdenes vuelven a NO FACTURADA con historial. Todo en una transacción.
 */
async function finalizarNotaValidada(notaId, resultado, usuarioId) {
  const r = await finalizarNotaValidadaTx(notaId, resultado, usuarioId);
  // B2-01 · Igual que la factura: se contabiliza después, sin arriesgar la validación.
  await contabilizarTrasValidar(notaId, usuarioId);
  return r;
}

async function finalizarNotaValidadaTx(notaId, resultado, usuarioId) {
  return withTransaction(async (client) => {
    const avisos = [];
    const [pdf, xml] = await Promise.all([
      proveedorFE().descargarPdfNotaCredito(resultado.numeroDocumento).catch((e) => { avisos.push(`PDF: ${e.message}`); return null; }),
      proveedorFE().descargarXmlNotaCredito(resultado.numeroDocumento).catch((e) => { avisos.push(`XML: ${e.message}`); return null; }),
    ]);
    const [pdfPath, xmlPath] = await Promise.all([
      pdf ? storage.put('facturacion/pdf', `${resultado.numeroDocumento}.pdf`, Buffer.from(pdf.base64, 'base64')) : null,
      xml ? storage.put('facturacion/xml', `${resultado.numeroDocumento}.xml`, Buffer.from(xml.base64, 'base64')) : null,
    ]);
    const nota = (await client.query(`SELECT * FROM sst.documentos_electronicos WHERE id = $1 FOR UPDATE`, [notaId])).rows[0];
    const resolucion = (await client.query(
      `SELECT prefijo FROM sst.resoluciones_numeracion WHERE tipo_documento = 'NOTA_CREDITO' AND activa
        ORDER BY (prefijo = 'NC') DESC, sincronizada_en DESC NULLS LAST LIMIT 1`,
    )).rows[0];
    const numeroNota = numeroCompleto(resolucion?.prefijo, resultado.numeroDocumento);

    await client.query(
      `UPDATE sst.documentos_electronicos
          SET estado = 'VALIDADO', numero = $2, prefijo = $3, cufe = $4, qr_url = $5,
              pdf_path = COALESCE($6, pdf_path), xml_path = COALESCE($7, xml_path),
              respuesta_proveedor = $8, actualizado_por = $9
        WHERE id = $1`,
      [notaId, resultado.numeroDocumento, resolucion?.prefijo ?? null, resultado.cufe, resultado.urlPublica,
        pdfPath, xmlPath, JSON.stringify(resultado.respuestaCruda ?? {}), usuarioId],
    );
    await client.query(
      `INSERT INTO sst.documento_eventos (documento_id, codigo, descripcion, usuario_id) VALUES ($1, 'VALIDADO', $2, $3)`,
      [notaId, `Validada por la DIAN. Número ${numeroNota}, CUDE ${resultado.cufe ?? '—'}.`, usuarioId],
    );
    if (avisos.length) {
      await client.query(
        `INSERT INTO sst.documento_eventos (documento_id, codigo, descripcion, usuario_id) VALUES ($1, 'DESCARGA_FALLIDA', $2, $3)`,
        [notaId, `No se pudo descargar: ${avisos.join('; ')}`.slice(0, 2000), usuarioId],
      );
    }

    const factura = (await client.query(
      `SELECT id, prefijo, numero FROM sst.documentos_electronicos WHERE id = $1 FOR UPDATE`, [nota.documento_referencia_id],
    )).rows[0];
    const numeroFactura = numeroCompleto(factura.prefijo, factura.numero);
    await client.query(
      `INSERT INTO sst.documento_eventos (documento_id, codigo, descripcion, usuario_id) VALUES ($1, 'NOTA_CREDITO', $2, $3)`,
      [factura.id, `Nota crédito ${numeroNota} validada (causal ${nota.causal}: ${CAUSALES_NOTA_CREDITO[nota.causal]}).`, usuarioId],
    );

    if (nota.causal === ANULACION) {
      // El trigger `trg_documentos_electronicos_propagar_validado` limpia
      // `documento_validado_id` al salir de VALIDADO: las órdenes quedan libres.
      await client.query(
        `UPDATE sst.documentos_electronicos SET estado = 'ANULADO', actualizado_por = $2 WHERE id = $1`, [factura.id, usuarioId],
      );
      await client.query(
        `INSERT INTO sst.documento_eventos (documento_id, codigo, descripcion, usuario_id) VALUES ($1, 'ANULADO', $2, $3)`,
        [factura.id, `Anulada por la nota crédito ${numeroNota}. Sus órdenes vuelven a estar pendientes por facturar.`, usuarioId],
      );
      const ordenes = (await client.query(
        `SELECT DISTINCT orden_id FROM sst.documento_items WHERE documento_id = $1 AND orden_id IS NOT NULL`, [factura.id],
      )).rows;
      for (const { orden_id: ordenId } of ordenes) {
        const previa = (await client.query(
          `SELECT estado_cobro::text AS estado_cobro, cobro_numero_factura FROM sst.ordenes_servicio WHERE id = $1 FOR UPDATE`, [ordenId],
        )).rows[0];
        // Solo se libera si la orden sigue facturada con ESTA factura: si ya la
        // movió otra cosa (un marcado manual posterior), no se pisa.
        if (!previa || previa.estado_cobro !== 'FACTURADA' || (previa.cobro_numero_factura && previa.cobro_numero_factura !== numeroFactura)) continue;
        await client.query(
          `UPDATE sst.ordenes_servicio
              SET estado_cobro = 'NO FACTURADA'::sst.estado_cobro, cobro_numero_factura = NULL,
                  cobro_actualizado_en = now(), cobro_actualizado_por = $2, actualizado_en = now()
            WHERE id = $1`,
          [ordenId, usuarioId],
        );
        await client.query(
          `INSERT INTO sst.historial_cobro_orden (orden_id, estado_anterior, estado_nuevo, numero_factura, observacion, documento_id, cambiado_por)
           VALUES ($1, 'FACTURADA'::sst.estado_cobro, 'NO FACTURADA'::sst.estado_cobro, $2, $3, $4, $5)`,
          [ordenId, numeroFactura, `Factura anulada con la nota crédito ${numeroNota}.`, notaId, usuarioId],
        );
      }
    }
    return obtenerBorrador(notaId, client);
  });
}

async function resolverResultadoNota(notaId, resultado, usuarioId) {
  if (resultado.eventos?.rechazos?.length) {
    await finalizarRechazado(notaId, resultado.eventos.rechazos.map(([, v]) => v), resultado.respuestaCruda, usuarioId);
    return { pendiente: false, estado: 'RECHAZADO' };
  }
  if (resultado.validado && resultado.numeroDocumento) {
    await finalizarNotaValidada(notaId, resultado, usuarioId);
    return { pendiente: false, estado: 'VALIDADO' };
  }
  await registrarSinDecision(notaId, 'SIN_DECISION', 'Todavía no se valida ni se rechaza. Use «Consultar estado» en unos minutos.', usuarioId);
  return { pendiente: true, estado: 'ENVIANDO' };
}

/** Emite la nota: mismo circuito que la factura (ENVIANDO confirmado antes de llamar a Factus). */
export async function emitirNotaCredito(notaId, usuarioId) {
  const { datos, numeroFactura } = await withTransaction(async (client) => {
    const d = await cargarDocumentoParaEmitir(notaId, client, 'NOTA_CREDITO');
    validarParaEmitir(d);
    const numero = await numeroDeFacturaReferida(d.doc, client);
    await client.query(`UPDATE sst.documentos_electronicos SET estado = 'ENVIANDO', actualizado_por = $2 WHERE id = $1`, [notaId, usuarioId]);
    await client.query(
      `INSERT INTO sst.documento_eventos (documento_id, codigo, descripcion, usuario_id) VALUES ($1, 'ENVIANDO', 'Enviada a la DIAN.', $2)`,
      [notaId, usuarioId],
    );
    return { datos: d, numeroFactura: numero };
  });

  let resultado;
  try {
    resultado = await intentarEmisionNota(datos, numeroFactura);
  } catch (e) {
    if (await registrarFallaDeEnvio(notaId, e, usuarioId)) return obtenerBorrador(notaId);
    return { pendiente: true, estado: 'ENVIANDO', aviso: 'No hubo respuesta del servicio de facturación electrónica; la nota quedó en ENVIANDO. Use «Consultar estado» en unos minutos.' };
  }
  const resuelto = await resolverResultadoNota(notaId, resultado, usuarioId);
  return resuelto.pendiente ? resuelto : obtenerBorrador(notaId);
}

/** Reconcilia una nota que quedó ENVIANDO (con número: consulta; sin número: reintenta con el MISMO reference_code). */
export async function reconciliarNotaCredito(notaId, usuarioId) {
  const datos = await withTransaction((client) => cargarDocumentoParaEmitir(notaId, client, 'NOTA_CREDITO'));
  if (datos.doc.estado !== 'ENVIANDO') throw conflict(`Esta nota está ${datos.doc.estado.toLowerCase()}; no hay nada que reconciliar.`);
  if (!datos.doc.numero) {
    const numeroFactura = await numeroDeFacturaReferida(datos.doc, pool);
    let resultado;
    try {
      resultado = await intentarEmisionNota(datos, numeroFactura);
    } catch (e) {
      if (await registrarFallaDeEnvio(notaId, e, usuarioId)) return obtenerBorrador(notaId);
      return { pendiente: true, estado: 'ENVIANDO' };
    }
    const resuelto = await resolverResultadoNota(notaId, resultado, usuarioId);
    return resuelto.pendiente ? resuelto : obtenerBorrador(notaId);
  }
  const estado = await proveedorFE().consultarNotaCredito(datos.doc.numero);
  if (estado.estado === 'VALIDADO') {
    await finalizarNotaValidada(notaId, {
      validado: true, numeroDocumento: datos.doc.numero, cufe: estado.cufe, urlPublica: estado.urlPublica,
      respuestaCruda: estado.respuestaCruda,
    }, usuarioId);
    return obtenerBorrador(notaId);
  }
  if (estado.estado === 'RECHAZADO') {
    await finalizarRechazado(notaId, [estado.detalle || 'Rechazada por la DIAN.'], estado.respuestaCruda, usuarioId);
    return obtenerBorrador(notaId);
  }
  await registrarSinDecision(notaId, 'CONSULTA_ESTADO', 'Sigue en proceso ante la DIAN.', usuarioId);
  return { pendiente: true, estado: 'ENVIANDO' };
}
