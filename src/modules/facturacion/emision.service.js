import { pool, withTransaction } from '../../config/db.js';
import { badRequest, conflict, notFound } from '../../utils/httpError.js';
import { deCentavos } from '../../utils/dinero.js';
import { storage } from '../../services/storage.service.js';
import { proveedorFE } from './index.js';
import { faltantesParaFacturar } from '../terceros/terceros.service.js';
import { generarReferenceCode, obtenerBorrador } from './borrador.service.js';

/**
 * A1-05 (FEL-10) · Emitir un documento contra Factus y conectar con el eje de
 * cobro. En dos fases, aposta:
 *
 *  1. `emitirDocumento`: valida, pasa el documento a ENVIANDO **y confirma esa
 *     transacción** antes de llamar a Factus. Si el proceso muere entre la
 *     llamada y guardar el resultado (corte de red, timeout, un despliegue a
 *     mitad de camino), el documento queda en ENVIANDO — nunca en BORRADOR con
 *     una factura que Factus ya podría haber creado — y `reconciliarDocumento`
 *     es quien lo resuelve después. Ninguna llamada a Factus ocurre dentro de
 *     una transacción de Postgres abierta (§5.1.5 del plan).
 *  2. `reconciliarDocumento`: para un documento que quedó ENVIANDO. Con número
 *     de Factus, consulta su estado real; sin número (la respuesta nunca llegó
 *     a tener uno), reintenta la emisión con el MISMO `reference_code` — nunca
 *     con uno nuevo, porque duplicaría el intento del lado de Factus.
 */

// ─── Construcción del payload (compartida por emitir y reconciliar) ────────

async function cargarDocumentoParaEmitir(id, client) {
  // Columnas explícitas (no se reutiliza `TERCERO_SELECT` de terceros.service):
  // ese SELECT trae `t.id` sin alias, y mezclado con `d.*` la columna `id` del
  // TERCERO pisaría la del DOCUMENTO en el objeto que arma `pg` (gana la
  // última columna con ese nombre) — justo el bug que costaría más caro aquí.
  const doc = (await client.query(
    `SELECT d.*,
            -- pg devuelve DATE como objeto Date; se sobreescribe con texto
            -- plano (mismo truco que borrador.service.js) porque Factus
            -- espera "AAAA-MM-DD", no un ISO con hora.
            to_char(d.fecha_emision, 'YYYY-MM-DD') AS fecha_emision,
            to_char(d.fecha_vencimiento, 'YYYY-MM-DD') AS fecha_vencimiento,
            ter.tipo_persona, ter.numero_documento, ter.dv, td.codigo_dian AS tipo_documento_codigo,
            COALESCE(ter.razon_social, btrim(concat_ws(' ', ter.nombres, ter.apellidos))) AS nombre,
            ter.direccion, ter.municipio_id, m.codigo_dian AS municipio_codigo,
            ter.correo_facturacion, ter.telefono, ter.responsabilidades_fiscales
       FROM sst.documentos_electronicos d
       JOIN sst.terceros ter ON ter.id = d.tercero_id
       LEFT JOIN sst.tipos_documento_identidad td ON td.id = ter.tipo_documento_id
       LEFT JOIN sst.municipios m ON m.id = ter.municipio_id
      WHERE d.id = $1 AND d.tipo = 'FACTURA'`,
    [id],
  )).rows[0];
  if (!doc) throw notFound('Esa factura no existe.');

  const items = (await client.query(
    `SELECT it.id, it.orden_id, it.codigo, it.descripcion, it.cantidad, it.valor_unitario,
            tiva.tarifa AS iva_pct
       FROM sst.documento_items it
       LEFT JOIN sst.documento_item_tributos tiva ON tiva.item_id = it.id AND tiva.retencion_id IS NULL
      WHERE it.documento_id = $1 ORDER BY it.orden`,
    [id],
  )).rows;

  // Solo RETEFUENTE y RETEIVA se informan a Factus: la autorretención es un
  // tributo que JD&D se practica a sí misma y Factus rechaza dos
  // withholding_taxes con el mismo código (hallazgo de A1-02, 27-sep-2026).
  const retenciones = (await client.query(
    `SELECT DISTINCT r.tipo, r.factus_tributo_id, it.tarifa
       FROM sst.documento_item_tributos it
       JOIN sst.retenciones r ON r.id = it.retencion_id
       JOIN sst.documento_items di ON di.id = it.item_id
      WHERE di.documento_id = $1 AND r.tipo IN ('RETEFUENTE', 'RETEIVA') AND r.factus_tributo_id IS NOT NULL`,
    [id],
  )).rows;

  const [forma, medio] = await Promise.all([
    doc.forma_pago_id ? client.query(`SELECT codigo_dian FROM sst.formas_pago WHERE id = $1`, [doc.forma_pago_id]) : null,
    doc.medio_pago_id ? client.query(`SELECT codigo_dian FROM sst.medios_pago WHERE id = $1`, [doc.medio_pago_id]) : null,
  ]);

  const resolucion = (await client.query(
    `SELECT id, prefijo, desde, hasta, consecutivo_actual, factus_rango_id, activa,
            to_char(fecha_hasta, 'YYYY-MM-DD') AS fecha_hasta
       FROM sst.resoluciones_numeracion WHERE tipo_documento = 'FACTURA' AND activa ORDER BY sincronizada_en DESC NULLS LAST LIMIT 1`,
  )).rows[0];

  return {
    doc,
    items,
    retenciones,
    formaPagoCodigo: forma?.rows[0]?.codigo_dian ?? '1',
    medioPagoCodigo: medio?.rows[0]?.codigo_dian ?? 'ZZZ',
    resolucion,
  };
}

/** Paso 1 de la ficha: todo lo que debe cumplirse ANTES de llamar a Factus. */
function validarParaEmitir({ doc, items, resolucion }) {
  if (doc.estado !== 'BORRADOR') {
    throw conflict(
      doc.estado === 'ENVIANDO' ? 'Este documento ya se está enviando: use "Consultar estado", no emitirlo de nuevo.'
        : `Este documento ya está ${doc.estado.toLowerCase()}; no se puede volver a emitir.`,
    );
  }
  if (!items.length) throw badRequest('El documento no tiene ítems.');

  const faltantes = faltantesParaFacturar(doc);
  if (doc.tipo_documento_codigo === '31' && doc.dv == null) faltantes.push('dígito de verificación');
  if (faltantes.length) {
    throw badRequest(`Al tercero le falta ${faltantes.join(', ')} para poder facturarle. Complete su ficha en Terceros.`);
  }

  if (!resolucion) throw badRequest('No hay una resolución de numeración activa para facturas. Sincronícela en Parametrización → Resoluciones.');
  const hoy = new Date().toISOString().slice(0, 10);
  if (resolucion.fecha_hasta && resolucion.fecha_hasta < hoy) throw badRequest(`La resolución de numeración venció el ${resolucion.fecha_hasta}.`);
  if (resolucion.hasta != null && Number(resolucion.consecutivo_actual) >= Number(resolucion.hasta)) {
    throw badRequest('La resolución de numeración ya agotó su rango; sincronice o gestione una nueva con el proveedor.');
  }

  const bruto = Number(doc.subtotal) + Number(doc.total_iva);
  if (!(bruto > 0)) throw badRequest('El documento no tiene un total mayor que cero.');
}

/** Vuelve a comprobar, con lock, que las órdenes del documento sigan libres (paso 1, punto "órdenes aún libres"). */
async function verificarOrdenesLibres(client, documentoId, items) {
  const ordenIds = items.map((it) => it.orden_id).filter(Boolean);
  if (!ordenIds.length) return;
  // FOR UPDATE: si dos emisiones de documentos distintos comparten por error
  // una orden, la segunda espera a que la primera termine su transacción (que
  // ya deja `estado_cobro = FACTURADA`) en vez de correr en paralelo a ciegas.
  const ocupadas = (await client.query(
    `SELECT o.codigo FROM sst.ordenes_servicio o
      WHERE o.id = ANY($1::uuid[]) AND (o.estado_cobro = 'FACTURADA' OR EXISTS (
        SELECT 1 FROM sst.documento_ordenes dor
         WHERE dor.orden_id = o.id AND dor.documento_id <> $2 AND dor.documento_validado_id IS NOT NULL
      ))
      FOR UPDATE`,
    [ordenIds, documentoId],
  )).rows;
  if (ocupadas.length) {
    throw conflict(`Alguna orden ya se facturó por otro documento mientras este seguía en borrador: ${ocupadas.map((o) => o.codigo).join(', ')}.`);
  }
}

function construirReceptor(doc) {
  return {
    nit: doc.numero_documento,
    dv: doc.dv ?? undefined,
    tipoDocumentoIdentidad: doc.tipo_documento_codigo || '31',
    tipoPersona: doc.tipo_persona,
    razonSocial: doc.nombre,
    direccion: doc.direccion,
    municipioDane: doc.municipio_codigo,
    email: doc.correo_facturacion,
    telefono: doc.telefono || undefined,
    // 'ZZ' (No aplica) para todos, como en las dos facturas reales que A1-02
    // reprodujo en el sandbox: los terceros de Orbita no guardan un tributo DIAN
    // propio (solo `regimen`, que no es el mismo catálogo).
    tributoCodigo: 'ZZ',
    responsabilidadesFiscales: doc.responsabilidades_fiscales?.length ? doc.responsabilidades_fiscales : undefined,
  };
}

/** Llama al adaptador con el `reference_code` que ya tiene el documento (nunca uno nuevo: es la clave de idempotencia). */
async function intentarEmision({ doc, items, retenciones, formaPagoCodigo, medioPagoCodigo, resolucion }) {
  const descuentoComercialPct = Number(doc.respuesta_proveedor?.calculo_meta?.descuento_comercial_pct) || 0;
  return proveedorFE().emitirFactura({
    referenceCode: doc.reference_code,
    receptor: construirReceptor(doc),
    items: items.map((it) => ({
      codigo: it.codigo,
      descripcion: it.descripcion,
      cantidad: Number(it.cantidad),
      valorUnitario: Number(it.valor_unitario),
      unidadMedidaCodigo: '94', // ver la nota de `borrador.service.js`: HUR se rechaza en el sandbox
      tarifaIva: Number(it.iva_pct) || 0,
    })),
    descuentoComercialPct,
    retenciones: retenciones.map((r) => ({ codigoFactus: r.factus_tributo_id, tarifa: Number(r.tarifa) })),
    numberingRangeId: resolucion.factus_rango_id ? Number(resolucion.factus_rango_id) : undefined,
    formaPagoCodigo,
    medioPagoCodigo,
    montoAPagar: deCentavos(Math.round((Number(doc.subtotal) + Number(doc.total_iva)) * 100)),
    fechaVencimiento: doc.fecha_vencimiento,
    observacion: doc.observaciones || undefined,
    // A1-06: Factus manda su propio correo al `correo_facturacion` del tercero
    // en cuanto valida (A1-05 ya exige que ese correo exista antes de emitir,
    // así que nunca se manda "al aire"). "Reenviar al cliente" (envio.service.js)
    // es aparte, con el correo propio de Orbita, para reintentos o para
    // mandarlo a alguien distinto sin tocar la ficha del tercero.
    enviarCorreo: true,
  });
}

// ─── Finalización (común a emitir y a reconciliar) ──────────────────────────

/**
 * Número "de pantalla" de un documento. Factus devuelve el número CON el prefijo
 * ya pegado ("SETP990019103", visto en la respuesta real guardada en
 * ADMIN_APP/admin_ws/tmp/factus), y aquí además se guarda el prefijo aparte: sin
 * esta comprobación la orden quedaba facturada con "SETPSETP990019103" (bug de
 * A1-05 encontrado al construir A2-01, 29-sep).
 */
export function numeroCompleto(prefijo, numero) {
  if (!numero) return null;
  const n = String(numero);
  return prefijo && !n.startsWith(prefijo) ? `${prefijo}${n}` : n;
}

/**
 * VALIDADO: guarda número/CUFE/PDF/XML y marca cada orden como FACTURADA, todo
 * en una transacción. La factura ya quedó VALIDADO en la DIAN pase lo que pase
 * aquí abajo (Factus no depende de esto), así que si el PDF o el XML no se
 * pueden descargar NO se revierte nada: se guarda un evento con el motivo
 * (nunca se traga el error) para que se reintente a mano ("Descargar de
 * nuevo", pendiente de pantalla) en vez de dejarlo en silencio.
 */
async function finalizarValidado(documentoId, resultado, usuarioId) {
  return withTransaction(async (client) => {
    const avisosDescarga = [];
    const [pdf, xml] = await Promise.all([
      proveedorFE().descargarPdf(resultado.numeroDocumento).catch((e) => { avisosDescarga.push(`PDF: ${e.message}`); return null; }),
      proveedorFE().descargarXml(resultado.numeroDocumento).catch((e) => { avisosDescarga.push(`XML: ${e.message}`); return null; }),
    ]);
    const [pdfPath, xmlPath] = await Promise.all([
      pdf ? storage.put('facturacion/pdf', `${resultado.numeroDocumento}.pdf`, Buffer.from(pdf.base64, 'base64')) : null,
      xml ? storage.put('facturacion/xml', `${resultado.numeroDocumento}.xml`, Buffer.from(xml.base64, 'base64')) : null,
    ]);

    const resolucion = (await client.query(`SELECT prefijo FROM sst.resoluciones_numeracion WHERE tipo_documento = 'FACTURA' AND activa LIMIT 1`)).rows[0];
    await client.query(
      `UPDATE sst.documentos_electronicos
          SET estado = 'VALIDADO', numero = $2, prefijo = $3, cufe = $4, qr_url = $5,
              pdf_path = COALESCE($6, pdf_path), xml_path = COALESCE($7, xml_path),
              respuesta_proveedor = $8, actualizado_por = $9
        WHERE id = $1`,
      [documentoId, resultado.numeroDocumento, resolucion?.prefijo ?? null, resultado.cufe, resultado.urlPublica,
        pdfPath, xmlPath, JSON.stringify(resultado.respuestaCruda ?? {}), usuarioId],
    );
    await client.query(
      `INSERT INTO sst.documento_eventos (documento_id, codigo, descripcion, usuario_id)
       VALUES ($1, 'VALIDADO', $2, $3)`,
      [documentoId, `Validada por la DIAN. Número ${numeroCompleto(resolucion?.prefijo, resultado.numeroDocumento)}, CUFE ${resultado.cufe ?? '—'}.`, usuarioId],
    );
    if (avisosDescarga.length) {
      await client.query(
        `INSERT INTO sst.documento_eventos (documento_id, codigo, descripcion, usuario_id) VALUES ($1, 'DESCARGA_FALLIDA', $2, $3)`,
        [documentoId, `No se pudo descargar: ${avisosDescarga.join('; ')}`.slice(0, 2000), usuarioId],
      );
    }

    const items = (await client.query(`SELECT orden_id FROM sst.documento_items WHERE documento_id = $1 AND orden_id IS NOT NULL`, [documentoId])).rows;
    const numeroFactura = numeroCompleto(resolucion?.prefijo, resultado.numeroDocumento);
    for (const { orden_id: ordenId } of items) {
      const previa = (await client.query(`SELECT estado_cobro::text AS estado_cobro FROM sst.ordenes_servicio WHERE id = $1 FOR UPDATE`, [ordenId])).rows[0];
      if (!previa || previa.estado_cobro === 'FACTURADA') continue; // ya facturada (reconciliación repetida): no duplica el historial
      await client.query(
        `UPDATE sst.ordenes_servicio
            SET estado_cobro = 'FACTURADA'::sst.estado_cobro, cobro_numero_factura = $2,
                cobro_actualizado_en = now(), cobro_actualizado_por = $3, actualizado_en = now()
          WHERE id = $1`,
        [ordenId, numeroFactura, usuarioId],
      );
      await client.query(
        `INSERT INTO sst.historial_cobro_orden (orden_id, estado_anterior, estado_nuevo, numero_factura, documento_id, cambiado_por)
         VALUES ($1, $2::sst.estado_cobro, 'FACTURADA'::sst.estado_cobro, $3, $4, $5)`,
        [ordenId, previa.estado_cobro, numeroFactura, documentoId, usuarioId],
      );
    }
    return obtenerBorrador(documentoId, client);
  });
}

async function finalizarRechazado(documentoId, mensajes, respuestaCruda, usuarioId) {
  await pool.query(
    `UPDATE sst.documentos_electronicos SET estado = 'RECHAZADO', errores = $2, respuesta_proveedor = $3, actualizado_por = $4 WHERE id = $1`,
    [documentoId, JSON.stringify(mensajes), JSON.stringify(respuestaCruda ?? {}), usuarioId],
  );
  await pool.query(
    `INSERT INTO sst.documento_eventos (documento_id, codigo, descripcion, usuario_id) VALUES ($1, 'RECHAZADO', $2, $3)`,
    [documentoId, mensajes.join('; ').slice(0, 2000) || 'Rechazada por la DIAN.', usuarioId],
  );
}

async function registrarSinDecision(documentoId, codigo, descripcion, usuarioId) {
  await pool.query(
    `INSERT INTO sst.documento_eventos (documento_id, codigo, descripcion, usuario_id) VALUES ($1, $2, $3, $4)`,
    [documentoId, codigo, descripcion, usuarioId],
  );
}

/** Aplica el resultado de `intentarEmision`/`consultarEstado`: valida→guarda, rechaza→guarda, ni uno ni otro→deja en ENVIANDO. */
async function resolverResultado(documentoId, resultado, usuarioId) {
  if (resultado.eventos?.rechazos?.length) {
    await finalizarRechazado(documentoId, resultado.eventos.rechazos.map(([, v]) => v), resultado.respuestaCruda, usuarioId);
    return { pendiente: false, estado: 'RECHAZADO' };
  }
  if (resultado.validado && resultado.numeroDocumento) {
    await finalizarValidado(documentoId, resultado, usuarioId);
    return { pendiente: false, estado: 'VALIDADO' };
  }
  await registrarSinDecision(
    documentoId, 'SIN_DECISION',
    'Factus todavía no valida ni rechaza (la DIAN va lenta). Use "Consultar estado" en unos minutos.',
    usuarioId,
  );
  return { pendiente: true, estado: 'ENVIANDO' };
}

// ─── API pública ─────────────────────────────────────────────────────────────

/**
 * Emite el documento: valida, pasa a ENVIANDO (transacción propia, confirmada
 * antes de llamar a Factus) y resuelve el resultado. Nunca lanza un error
 * "duro" por un timeout de Factus: en ese caso el documento queda ENVIANDO y la
 * función devuelve `{ pendiente: true }` para que la pantalla lo diga.
 */
export async function emitirDocumento(documentoId, usuarioId) {
  const datos = await withTransaction(async (client) => {
    const d = await cargarDocumentoParaEmitir(documentoId, client);
    validarParaEmitir(d);
    await verificarOrdenesLibres(client, documentoId, d.items);
    await client.query(`UPDATE sst.documentos_electronicos SET estado = 'ENVIANDO', actualizado_por = $2 WHERE id = $1`, [documentoId, usuarioId]);
    await client.query(
      `INSERT INTO sst.documento_eventos (documento_id, codigo, descripcion, usuario_id) VALUES ($1, 'ENVIANDO', 'Enviada a Factus.', $2)`,
      [documentoId, usuarioId],
    );
    return d;
  });

  let resultado;
  try {
    resultado = await intentarEmision(datos);
  } catch (e) {
    await registrarSinDecision(documentoId, 'ERROR_RED', `No se pudo contactar al proveedor: ${e.message}`.slice(0, 2000), usuarioId);
    return { pendiente: true, estado: 'ENVIANDO', aviso: 'No se pudo contactar a Factus; el documento quedó en ENVIANDO. Use "Consultar estado" en unos minutos.' };
  }
  const resuelto = await resolverResultado(documentoId, resultado, usuarioId);
  return resuelto.pendiente ? resuelto : obtenerBorrador(documentoId);
}

/**
 * Reconcilia un documento que quedó ENVIANDO: con número, consulta su estado
 * real en Factus; sin número, reintenta la emisión con el MISMO reference_code
 * (idempotente del lado de Factus — nunca uno nuevo).
 */
export async function reconciliarDocumento(documentoId, usuarioId) {
  const datos = await withTransaction(async (client) => cargarDocumentoParaEmitir(documentoId, client));
  if (datos.doc.estado !== 'ENVIANDO') {
    throw conflict(`Este documento está ${datos.doc.estado.toLowerCase()}; no hay nada que reconciliar.`);
  }

  if (!datos.doc.numero) {
    let resultado;
    try {
      resultado = await intentarEmision(datos);
    } catch (e) {
      await registrarSinDecision(documentoId, 'ERROR_RED', `No se pudo contactar al proveedor: ${e.message}`.slice(0, 2000), usuarioId);
      return { pendiente: true, estado: 'ENVIANDO' };
    }
    const resuelto = await resolverResultado(documentoId, resultado, usuarioId);
    return resuelto.pendiente ? resuelto : obtenerBorrador(documentoId);
  }

  const estado = await proveedorFE().consultarEstado(datos.doc.numero);
  if (estado.estado === 'VALIDADO') {
    const resuelto = await resolverResultado(documentoId, {
      validado: true, numeroDocumento: datos.doc.numero, cufe: estado.cufe, urlPublica: estado.urlPublica,
      totales: estado.totales, eventos: { rechazos: [], avisos: [] }, respuestaCruda: estado.respuestaCruda,
    }, usuarioId);
    return resuelto.pendiente ? resuelto : obtenerBorrador(documentoId);
  }
  if (estado.estado === 'RECHAZADO') {
    await finalizarRechazado(documentoId, [estado.detalle || 'Rechazada por la DIAN.'], estado.respuestaCruda, usuarioId);
    return obtenerBorrador(documentoId);
  }
  await registrarSinDecision(documentoId, 'CONSULTA_ESTADO', 'Sigue en proceso en Factus.', usuarioId);
  return { pendiente: true, estado: 'ENVIANDO' };
}

/**
 * A1-07 (FEL-12) · Corrige un documento RECHAZADO: vuelve a BORRADOR (con
 * `errores` limpio) y estrena un `reference_code` **nuevo** — el rechazado
 * queda "quemado" del lado de Factus, así que reemitir con el mismo código no
 * es un reintento válido, es repetir el mismo intento que ya falló. El
 * historial de eventos NO se toca: sigue contando lo que pasó, incluido el
 * rechazo original.
 *
 * Después de esto, el documento se edita con `actualizarBorrador` (A1-04) y se
 * vuelve a intentar con `emitirDocumento` (A1-05) como cualquier borrador.
 */
export async function corregirDocumento(documentoId, usuarioId) {
  return withTransaction(async (client) => {
    const doc = (await client.query(
      `SELECT id, estado, reference_code FROM sst.documentos_electronicos WHERE id = $1 AND tipo = 'FACTURA' FOR UPDATE`,
      [documentoId],
    )).rows[0];
    if (!doc) throw notFound('Esa factura no existe.');
    if (doc.estado !== 'RECHAZADO') throw conflict(`Solo se corrige un documento RECHAZADO (este está ${doc.estado.toLowerCase()}).`);

    const nuevoReferenceCode = generarReferenceCode();
    await client.query(
      `UPDATE sst.documentos_electronicos
          SET estado = 'BORRADOR', reference_code = $2, errores = NULL, actualizado_por = $3
        WHERE id = $1`,
      [documentoId, nuevoReferenceCode, usuarioId],
    );
    await client.query(
      `INSERT INTO sst.documento_eventos (documento_id, codigo, descripcion, usuario_id)
       VALUES ($1, 'CORREGIDO', $2, $3)`,
      [documentoId, `Vuelve a BORRADOR para corregirse. El intento rechazado (${doc.reference_code}) queda en el historial; se reemitirá con un reference_code nuevo.`, usuarioId],
    );
    return obtenerBorrador(documentoId, client);
  });
}
