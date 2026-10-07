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
  cargarDocumentoParaEmitir, finalizarRechazado, numeroCompleto, registrarFallaDeEnvio, registrarSinDecision,
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

const LISTA_SELECT = `
  SELECT d.id, d.estado, d.reference_code, d.prefijo, d.numero, d.cufe,
         to_char(d.fecha_emision, 'YYYY-MM-DD') AS fecha_emision,
         d.total_a_pagar, d.pdf_path IS NOT NULL AS tiene_pdf, d.xml_path IS NOT NULL AS tiene_xml,
         d.tercero_id, COALESCE(t.razon_social, btrim(concat_ws(' ', t.nombres, t.apellidos))) AS tercero_nombre,
         t.numero_documento AS tercero_documento,
         d.precuenta_id, pc.periodo, p.nombre AS profesional_nombre,
         (SELECT count(*)::int FROM sst.documento_items i WHERE i.documento_id = d.id) AS total_lineas,
         d.creado_en
    FROM sst.documentos_electronicos d
    JOIN sst.terceros t ON t.id = d.tercero_id
    LEFT JOIN sst.precuentas pc ON pc.id = d.precuenta_id
    LEFT JOIN sst.profesionales p ON p.id = pc.profesional_id`;

/** Lista por estado (varios separados por coma); `periodo` (AAAA-MM) la acota al mes de la cuenta de cobro. */
export async function listarSoportes({ estado, periodo } = {}) {
  const estados = String(estado || 'BORRADOR,ENVIANDO,VALIDADO,RECHAZADO')
    .split(',').map((e) => e.trim().toUpperCase()).filter(Boolean);
  const params = [estados];
  let filtro = '';
  if (periodo) {
    if (!/^\d{4}-\d{2}$/.test(String(periodo))) throw badRequest('El periodo va como AAAA-MM.');
    params.push(String(periodo));
    filtro = ` AND pc.periodo = $2`;
  }
  return (await pool.query(
    `${LISTA_SELECT} WHERE d.tipo = 'DOC_SOPORTE' AND d.estado = ANY($1)${filtro} ORDER BY d.creado_en DESC LIMIT 500`,
    params,
  )).rows;
}

/** Detalle: el de la factura (ítems, totales, línea de tiempo) más la cuenta de cobro de origen. */
export async function obtenerSoporte(id, client = pool) {
  const doc = await obtenerBorrador(id, client);
  if (doc.tipo !== 'DOC_SOPORTE') throw notFound('Ese documento soporte no existe.');
  const origen = doc.precuenta_id ? (await client.query(
    `SELECT pc.id, pc.periodo, pc.estado, p.nombre AS profesional_nombre
       FROM sst.precuentas pc JOIN sst.profesionales p ON p.id = pc.profesional_id WHERE pc.id = $1`,
    [doc.precuenta_id],
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
  return {
    ...doc,
    precuenta: origen ? { ...origen, periodo_largo: periodoLargo(origen.periodo) } : null,
    items: doc.items.map((it) => ({
      ...it,
      arl_nombre: porItem.get(it.id)?.arl_nombre ?? null,
      orden_codigo: porItem.get(it.id)?.orden_codigo ?? null,
    })),
  };
}

function validarSoporte({ doc, items, resolucion }) {
  if (doc.estado !== 'BORRADOR') {
    throw conflict(doc.estado === 'ENVIANDO'
      ? 'Este documento soporte ya se está enviando: use «Consultar estado», no lo emita de nuevo.'
      : `Este documento soporte ya está ${doc.estado.toLowerCase()}; no se puede volver a emitir.`);
  }
  if (!items.length) throw badRequest('El documento soporte no tiene líneas.');
  const faltan = [];
  if (!doc.numero_documento) faltan.push('número de documento');
  if (!doc.direccion) faltan.push('dirección');
  if (!doc.municipio_id) faltan.push('municipio');
  if (faltan.length) throw badRequest(`Al tercero ${doc.nombre} le falta ${faltan.join(', ')}. Complete su ficha en Terceros.`);
  if (!resolucion) {
    throw badRequest('No hay una resolución de numeración activa para documento soporte. Sincronícela en Parametrización → Numeración.');
  }
  const hoy = hoyCO();
  if (resolucion.fecha_hasta && resolucion.fecha_hasta < hoy) throw badRequest(`La resolución del documento soporte venció el ${resolucion.fecha_hasta}.`);
  if (resolucion.hasta != null && Number(resolucion.consecutivo_actual) >= Number(resolucion.hasta)) {
    throw badRequest('La resolución del documento soporte ya agotó su rango.');
  }
  if (!(Number(doc.total_a_pagar) > 0)) throw badRequest('El documento soporte no tiene un total mayor que cero.');
}

function intentarEmisionSoporte({ doc, items, formaPagoCodigo, medioPagoCodigo, resolucion }) {
  return proveedorFE().emitirDocumentoSoporte({
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
  });
}

/** VALIDADO: número, CUDS, PDF y XML en una transacción. Una descarga fallida no revierte nada. */
async function finalizarSoporteValidado(id, resultado, usuarioId) {
  return withTransaction(async (client) => {
    const avisos = [];
    const proveedor = proveedorFE();
    const [pdf, xml] = await Promise.all([
      proveedor.descargarPdfDocumentoSoporte(resultado.numeroDocumento).catch((e) => { avisos.push(`PDF: ${e.message}`); return null; }),
      proveedor.descargarXmlDocumentoSoporte(resultado.numeroDocumento).catch((e) => { avisos.push(`XML: ${e.message}`); return null; }),
    ]);
    const [pdfPath, xmlPath] = await Promise.all([
      pdf ? storage.put('soporte/pdf', `${resultado.numeroDocumento}.pdf`, Buffer.from(pdf.base64, 'base64')) : null,
      xml ? storage.put('soporte/xml', `${resultado.numeroDocumento}.xml`, Buffer.from(xml.base64, 'base64')) : null,
    ]);
    const resolucion = (await client.query(
      `SELECT prefijo FROM sst.resoluciones_numeracion WHERE tipo_documento = 'DOC_SOPORTE' AND activa
        ORDER BY sincronizada_en DESC NULLS LAST LIMIT 1`,
    )).rows[0];
    const prefijo = resolucion?.prefijo ?? null;
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
      [id, `Validado por la DIAN. Número ${numeroCompleto(prefijo, resultado.numeroDocumento)}, CUDS ${resultado.cufe ?? '—'}.`, usuarioId],
    );
    if (avisos.length) {
      await client.query(
        `INSERT INTO sst.documento_eventos (documento_id, codigo, descripcion, usuario_id) VALUES ($1, 'DESCARGA_FALLIDA', $2, $3)`,
        [id, `No se pudo descargar: ${avisos.join('; ')}`.slice(0, 2000), usuarioId],
      );
    }
  });
}

async function resolverResultado(id, resultado, usuarioId) {
  if (resultado.eventos?.rechazos?.length) {
    await finalizarRechazado(id, resultado.eventos.rechazos.map(([, v]) => v), resultado.respuestaCruda, usuarioId);
    return { pendiente: false };
  }
  if (resultado.validado && resultado.numeroDocumento) {
    await finalizarSoporteValidado(id, resultado, usuarioId);
    return { pendiente: false };
  }
  await registrarSinDecision(id, 'SIN_DECISION', 'Todavía no se valida ni se rechaza. Use «Consultar estado» en unos minutos.', usuarioId);
  return { pendiente: true };
}

const PENDIENTE = {
  pendiente: true,
  estado: 'ENVIANDO',
  aviso: 'No hubo respuesta definitiva de la DIAN; el documento soporte quedó en ENVIANDO. Use «Consultar estado» en unos minutos.',
};

/** Emite el borrador (ENVIANDO confirmado antes de llamar al proveedor). */
export async function emitirSoporte(id, usuarioId) {
  const datos = await withTransaction(async (client) => {
    const d = await cargarDocumentoParaEmitir(id, client, 'DOC_SOPORTE');
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
    resultado = await intentarEmisionSoporte(datos);
  } catch (e) {
    if (await registrarFallaDeEnvio(id, e, usuarioId)) return obtenerSoporte(id);
    return PENDIENTE;
  }
  const { pendiente } = await resolverResultado(id, resultado, usuarioId);
  return pendiente ? PENDIENTE : obtenerSoporte(id);
}

/** Reconcilia un DS que quedó ENVIANDO: con número consulta; sin número reintenta con el MISMO reference_code. */
export async function reconciliarSoporte(id, usuarioId) {
  const datos = await withTransaction((client) => cargarDocumentoParaEmitir(id, client, 'DOC_SOPORTE'));
  if (datos.doc.estado !== 'ENVIANDO') throw conflict(`Este documento soporte está ${datos.doc.estado.toLowerCase()}; no hay nada que reconciliar.`);
  if (!datos.doc.numero) {
    let resultado;
    try {
      resultado = await intentarEmisionSoporte(datos);
    } catch (e) {
      if (await registrarFallaDeEnvio(id, e, usuarioId)) return obtenerSoporte(id);
      return PENDIENTE;
    }
    const { pendiente } = await resolverResultado(id, resultado, usuarioId);
    return pendiente ? PENDIENTE : obtenerSoporte(id);
  }
  const estado = await proveedorFE().consultarDocumentoSoporte(datos.doc.numero);
  if (estado.estado === 'VALIDADO') {
    await finalizarSoporteValidado(id, {
      numeroDocumento: datos.doc.numero, cufe: estado.cufe, urlPublica: estado.urlPublica, respuestaCruda: estado.respuestaCruda,
    }, usuarioId);
    return obtenerSoporte(id);
  }
  if (estado.estado === 'RECHAZADO') {
    await finalizarRechazado(id, [estado.detalle || 'Rechazado por la DIAN.'], estado.respuestaCruda, usuarioId);
    return obtenerSoporte(id);
  }
  await registrarSinDecision(id, 'CONSULTA_ESTADO', 'Sigue en proceso ante la DIAN.', usuarioId);
  return PENDIENTE;
}

/** RECHAZADO → BORRADOR con un reference_code nuevo (el intento rechazado queda en la línea de tiempo). */
export async function corregirSoporte(id, usuarioId) {
  await withTransaction(async (client) => {
    const doc = (await client.query(
      `SELECT estado, reference_code FROM sst.documentos_electronicos WHERE id = $1 AND tipo = 'DOC_SOPORTE' FOR UPDATE`, [id],
    )).rows[0];
    if (!doc) throw notFound('Ese documento soporte no existe.');
    if (doc.estado !== 'RECHAZADO') throw conflict(`Solo se corrige un documento RECHAZADO (este está ${doc.estado.toLowerCase()}).`);
    await client.query(
      `UPDATE sst.documentos_electronicos SET estado = 'BORRADOR', reference_code = $2, errores = NULL, actualizado_por = $3 WHERE id = $1`,
      [id, generarReferenceCodeSoporte(), usuarioId],
    );
    await client.query(
      `INSERT INTO sst.documento_eventos (documento_id, codigo, descripcion, usuario_id) VALUES ($1, 'CORREGIDO', $2, $3)`,
      [id, `Vuelve a BORRADOR. El intento rechazado (${doc.reference_code}) queda en el historial; se emitirá con una referencia nueva.`, usuarioId],
    );
  });
  return obtenerSoporte(id);
}

/** Borra un BORRADOR (la cuenta de cobro queda libre para generar otro). */
export async function eliminarSoporte(id) {
  const r = await pool.query(
    `DELETE FROM sst.documentos_electronicos WHERE id = $1 AND tipo = 'DOC_SOPORTE' AND estado = 'BORRADOR' RETURNING id`, [id],
  );
  if (!r.rows[0]) throw conflict('Solo se puede eliminar un documento soporte en BORRADOR (o ya no existe).');
  return { id };
}
