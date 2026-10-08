import { PuertoFacturacionElectronica } from '../puerto.js';
import { request } from './factus.cliente.js';
import { hoyCO } from '../../../utils/formato.js';

/**
 * Factus nombra el documento de cada rango con un texto ("Factura de Venta",
 * "Nota Crédito"…), no con un código. Solo se mapean los que se vieron en el
 * sandbox el 27-sep-2026; cualquier otro (la Nota Débito, o una nómina que no se
 * ha visto todavía) sale con `null` para que quien sincroniza lo omita a la vista
 * en vez de adivinarlo.
 */
const DOCUMENTO_DE_FACTUS = {
  'factura de venta': 'FACTURA',
  'nota crédito': 'NOTA_CREDITO',
  'documento soporte': 'DOC_SOPORTE',
  'nota de ajuste documento soporte': 'NOTA_AJUSTE_DS',
};

/** Dos decimales fijos, como pide Factus en cada campo numérico del payload. */
const dosDec = (n) => Number(n ?? 0).toFixed(2);

/**
 * ⚠️ Hallazgo de A1-02 (27-sep-2026, probado en sandbox): `unit_measure_code`
 * de Factus v2 NO acepta el catálogo completo que publica su propia
 * documentación (`db/semillas/catalogos-dian.json`, sacado de esa misma
 * documentación). Se probaron 8 códigos alfabéticos que la doc lista como
 * válidos —incluida `HUR` (hora), la que necesita Orbita para sus servicios
 * por horas— y los 8 dieron "El campo código unidad de medida es inválido";
 * solo `94` (unidad) validó. No hay más códigos confirmados todavía. Mientras
 * no se pruebe otro, cualquier código no confirmado se manda como `94` y la
 * descripción de la línea es la que dice "N horas" (ya lo hace A1-04).
 */
const UNIDADES_CONFIRMADAS = new Set(['94']);
function unidadFactus(codigo) {
  return UNIDADES_CONFIRMADAS.has(codigo) ? codigo : '94';
}

/**
 * `EXENTO` (A0-06) se modela como IVA al 0 % (`code: '01', rate: '0.00'`), no
 * como `is_excluded: true`: excluido y exento son figuras legales distintas
 * (nota de docs/2-arquitectura/facturacion-electronica.md §7, punto 7) y "exento por norma" es
 * lo que dijo la reunión (A0-06, Q-14) — no lo que Factus llama excluido.
 * ⚠️ Sin confirmar contra el sandbox con un producto real todavía: ver la
 * bitácora de A1-02.
 */
function tributoDeLinea(tarifaIva) {
  const tarifa = Number(tarifaIva) || 0;
  return { taxes: [{ code: '01', rate: dosDec(tarifa) }] };
}

/** @param {import('../puerto.js').LineaDocumento} linea */
function mapearItem(linea, descuentoComercialPct, retenciones) {
  return {
    code_reference: linea.codigo || 'SVC',
    name: linea.descripcion,
    quantity: dosDec(linea.cantidad),
    discount_rate: dosDec(descuentoComercialPct || 0),
    price: dosDec(linea.valorUnitario),
    unit_measure_code: unidadFactus(linea.unidadMedidaCodigo || '94'),
    standard_code: '999', // estándar de adopción del contribuyente (catálogo DIAN)
    ...tributoDeLinea(linea.tarifaIva),
    // Se informan en el XML (código 05 IVA / 06 renta, A0-07); Factus NO las
    // resta del total que calcula — eso lo hace calculo.js para el total real.
    withholding_taxes: (retenciones || []).map((r) => ({ code: r.codigoFactus, rate: dosDec(r.tarifa) })),
  };
}

function mapearCustomer(receptor) {
  return {
    identification_document_code: receptor.tipoDocumentoIdentidad || '31',
    identification: String(receptor.nit).replace(/\D/g, ''),
    ...(receptor.tipoPersona === 'NATURAL'
      ? { names: receptor.razonSocial }
      : { company: receptor.razonSocial, trade_name: receptor.razonSocial }),
    legal_organization_code: receptor.tipoPersona === 'NATURAL' ? '2' : '1',
    tribute_code: receptor.tributoCodigo || 'ZZ',
    ...(receptor.responsabilidadesFiscales?.length ? { responsibilities: receptor.responsabilidadesFiscales } : {}),
    address: receptor.direccion || undefined,
    email: receptor.email || undefined,
    phone: receptor.telefono || undefined,
    municipality_code: receptor.municipioDane || undefined,
  };
}

/** Factus mezcla avisos y rechazos en `errors`; solo es rechazo si el texto dice «Rechazo». */
function clasificarErrores(errors) {
  const entradas = Object.entries(errors || {});
  const rechazos = entradas.filter(([, v]) => /rechazo/i.test(String(v)));
  const avisos = entradas.filter(([, v]) => !/rechazo/i.test(String(v)));
  return { rechazos, avisos };
}

/**
 * Adaptador de Factus. `emitirFactura`, `consultarEstado`, `descargarPdf` y
 * `descargarXml` confirmados contra el sandbox el 27-sep-2026 (A1-02); el resto
 * (documento soporte, nómina) sigue pendiente de sus propias fichas (A4-01, A5-01).
 *
 * ⚠️ Sigue bloqueado para PRODUCCIÓN hasta cerrar: los datos fiscales reales de
 * JD&D (A0-09, hoy vacíos a propósito) y la compra del paquete real (S-01). Todo
 * lo de aquí se ha probado solo contra `api-sandbox.factus.com.co`.
 */
export class FactusAdaptador extends PuertoFacturacionElectronica {
  /** GET /v2/numbering-ranges (paginado de a 10), confirmado contra el sandbox. */
  async listarRangosNumeracion() {
    const rangos = [];
    for (let pagina = 1, ultima = 1; pagina <= ultima; pagina++) {
      const r = await request('GET', '/v2/numbering-ranges', undefined, { query: { page: pagina } });
      rangos.push(...(r.data?.data ?? []));
      ultima = r.data?.pagination?.last_page ?? 1;
    }
    return rangos.map((x) => ({
      proveedorId: Number(x.id),
      tipoDocumento: DOCUMENTO_DE_FACTUS[String(x.document || '').trim().toLowerCase()] ?? null,
      documentoProveedor: x.document,
      prefijo: x.prefix ?? null,
      desde: x.from == null ? null : Number(x.from),
      hasta: x.to == null ? null : Number(x.to),
      actual: Number(x.current ?? 0),
      numeroResolucion: x.resolution_number || null,
      fechaDesde: x.start_date ?? null,
      fechaHasta: x.end_date ?? null,
      activo: Boolean(x.is_active) && !x.deleted_at,
    }));
  }

  /**
   * POST /v2/bills/validate (confirmado: es el mismo endpoint que usa
   * ADMIN_APP/admin_ws/scripts/factus_factura_prueba.js). Emisión síncrona: al
   * responder, la factura ya quedó VALIDADO o RECHAZADO (o, más raro, sin
   * decidir — "is_validated: false" sin rechazos, la DIAN va lenta).
   *
   * ⚠️ `payment_details[].amount` lo calcula QUIEN LLAMA (con `calculo.js`, la
   * fuente de verdad de Orbita), no este adaptador: Factus exige que el pago
   * declarado cuadre con lo que ÉL calcula, y ese es justo el número que hay que
   * comparar después contra `totales.total` del resultado.
   * @param {import('../puerto.js').DatosFactura & {formaPagoCodigo: string, medioPagoCodigo: string, montoAPagar: string}} datos
   */
  async emitirFactura(datos) {
    const factura = {
      reference_code: datos.referenceCode,
      document: '01', // factura electrónica de venta
      operation_type: '10', // estándar
      send_email: datos.enviarCorreo === true,
      observation: datos.observacion || undefined,
      numbering_range_id: datos.numberingRangeId || undefined,
      payment_details: [{
        payment_form: datos.formaPagoCodigo || '2', // crédito, como las facturas reales (§3.4)
        payment_method_code: datos.medioPagoCodigo || 'ZZZ', // "Otro", como las facturas reales
        amount: datos.montoAPagar,
        // Factus lo exige aunque sea de contado (probado en sandbox, 27-sep-2026:
        // sin este campo rechaza con "El campo fecha de vencimiento es obligatorio").
        // Vencimiento = emisión + plazo_dias del pagador (A0-07); a falta de una
        // fecha de emisión explícita, usa hoy + el plazo.
        due_date: datos.fechaVencimiento || hoyCO(),
      }],
      customer: mapearCustomer(datos.receptor),
      items: datos.items.map((it) => mapearItem(it, datos.descuentoComercialPct, datos.retenciones)),
    };

    const r = await request('POST', '/v2/bills/validate', factura);
    const bill = r.data || {};
    const { rechazos, avisos } = clasificarErrores(bill.errors);

    return {
      referenceCode: datos.referenceCode,
      numeroDocumento: bill.number || null,
      validado: Boolean(bill.is_validated),
      cufe: bill.cufe || null,
      urlPublica: bill.links?.public_url || null,
      // Nombres confirmados contra la respuesta real del sandbox (27-sep-2026):
      // `gross_amount` (bruto sin descuento), `taxable_amount` (base gravable,
      // que en las dos facturas de prueba coincidió con nuestro `subtotal`),
      // `tax_amount` (IVA) y `total`. ⚠️ `total` es SIEMPRE bruto: Factus no
      // resta ninguna retención (ver la nota de cabecera de `calculo.js` y la
      // bitácora de A1-02 en el plan).
      totales: {
        totalBruto: bill.totals?.gross_amount ?? null,
        subtotal: bill.totals?.taxable_amount ?? null,
        totalIva: bill.totals?.tax_amount ?? null,
        total: bill.totals?.total ?? null,
      },
      eventos: { rechazos, avisos },
      respuestaCruda: r,
    };
  }

  /**
   * GET /v2/bills/:number (confirmado: developers.factus.com.co/facturas/ver).
   * Es la reconciliación de "Consultar estado" (§5.1.5): solo sirve con el
   * NÚMERO que ya asignó Factus; si la emisión se cortó antes de recibirlo, no
   * hay nada que consultar todavía y hay que reintentar con el MISMO reference_code.
   */
  async consultarEstado(numeroDocumento) {
    if (!numeroDocumento) {
      return { estado: 'SIN_NUMERO', detalle: 'Todavía sin número asignado: reintente la emisión con la misma referencia, no cree una nueva.' };
    }
    const r = await request('GET', `/v2/bills/${encodeURIComponent(numeroDocumento)}`);
    const bill = r.data || {};
    const { rechazos } = clasificarErrores(bill.errors);
    return {
      estado: rechazos.length ? 'RECHAZADO' : bill.is_validated ? 'VALIDADO' : 'ENVIANDO',
      detalle: rechazos.map(([, v]) => v).join('; ') || undefined,
      // A1-05 (reconciliación de un documento que quedó ENVIANDO): el mismo
      // objeto `bill` ya trae esto — se enriquece aquí en vez de hacer que
      // quien reconcilia tenga que volver a emitir solo para conseguirlo.
      cufe: bill.cufe || null,
      urlPublica: bill.links?.public_url || null,
      totales: {
        totalBruto: bill.totals?.gross_amount ?? null,
        subtotal: bill.totals?.taxable_amount ?? null,
        totalIva: bill.totals?.tax_amount ?? null,
        total: bill.totals?.total ?? null,
      },
      respuestaCruda: r,
    };
  }

  /**
   * A1-07 (FEL-12, 19) · `GET /v2/bills/:number/radian/events` — confirmado en
   * la documentación pública el 28-sep-2026 (respuesta real de sandbox contra
   * una factura recién validada, sin eventos todavía: `{status:"OK",
   * message:"Solicitud exitosa", data: []}`). Los NOMBRES de campo de cada
   * evento dentro de `data` **no se han visto poblados** (ninguna factura de
   * prueba acumuló eventos reales todavía): se intentan varias claves
   * plausibles y se **conserva el objeto crudo entero** en `crudo` para no
   * perder nada si el nombre real es otro — `eventos.service.js` lo guarda tal
   * cual en `documento_eventos.datos`.
   *
   * ⚠️ Sin adaptador de ESCRITURA: la doc pública (`/recepcion-de-documentos/
   * emitir-evento/`) solo documenta `PATCH /v2/receptions/bills/:bill_id/
   * radian/events/:tipo` para eventos sobre facturas RECIBIDAS (C8-01, Fase C),
   * y dice que la aceptación tácita (034) "ocurre automáticamente pasados 3
   * días hábiles" del lado de la DIAN — no algo que el EMISOR registre a mano.
   * Un `POST /v2/bills/:number/radian/events/034` de prueba sí existe (devolvió
   * 422 pidiendo identidad de persona natural), pero su semántica para una
   * factura EMITIDA por nosotros no está confirmada; no se implementa a
   * ciegas contra un endpoint fiscal sin confirmar (regla del plan §1.6). Ver
   * Q-26.
   */
  async consultarEventosRadian(numeroDocumento) {
    const r = await request('GET', `/v2/bills/${encodeURIComponent(numeroDocumento)}/radian/events`);
    const lista = Array.isArray(r.data) ? r.data : [];
    return lista.map((e) => ({
      codigo: String(e.event_code ?? e.code ?? e.codigo ?? e.type ?? 'DESCONOCIDO'),
      descripcion: e.event_name ?? e.name ?? e.description ?? e.descripcion ?? null,
      fecha: e.date ?? e.event_date ?? e.datetime ?? e.created_at ?? null,
      crudo: e,
    }));
  }

  /** GET /v2/bills/:number/download-pdf (confirmado en la documentación de Factus). */
  async descargarPdf(numeroDocumento) {
    const r = await request('GET', `/v2/bills/${encodeURIComponent(numeroDocumento)}/download-pdf`);
    const base64 = r.data?.pdf_base_64_encoded;
    if (!base64) throw new Error(`El proveedor tecnológico no devolvió el PDF de ${numeroDocumento}`);
    return { base64 };
  }

  /** GET /v2/bills/:number/download-xml (confirmado; developers.factus.com.co la documenta con "/" final,
   * pero el propio script ya verificado de ADMIN_APP la llama sin esa barra y funciona). */
  async descargarXml(numeroDocumento) {
    const r = await request('GET', `/v2/bills/${encodeURIComponent(numeroDocumento)}/download-xml`);
    const base64 = r.data?.xml_base_64_encoded;
    if (!base64) throw new Error(`El proveedor tecnológico no devolvió el XML de ${numeroDocumento}`);
    return { base64 };
  }

  // ─── A2-01 · Nota crédito ─────────────────────────────────────────────────
  // Endpoints de la documentación oficial (developers.factus.com.co/notas-credito,
  // leída el 29-sep-2026): POST /v2/credit-notes/validate, GET /v2/credit-notes/:number,
  // GET /v2/credit-notes/:number/download-pdf|download-xml. Mismo cuerpo que la
  // factura más `correction_concept_code` (tabla 1..6 de la DIAN), `customization_id`
  // "20" (nota que referencia una factura) y `bill_number` (la factura corregida,
  // con su prefijo). La forma de la RESPUESTA no está en la doc: se lee tolerante
  // (`credit_note` o el objeto raíz) y se guarda cruda, como con la factura.

  /** @param {object} datos los de `emitirFactura` + `conceptoCorreccion` y `numeroFactura`. */
  async emitirNotaCredito(datos) {
    const nota = {
      reference_code: datos.referenceCode,
      correction_concept_code: String(datos.conceptoCorreccion),
      customization_id: '20',
      bill_number: datos.numeroFactura,
      numbering_range_id: datos.numberingRangeId || undefined,
      observation: datos.observacion ? String(datos.observacion).slice(0, 500) : undefined,
      send_email: datos.enviarCorreo === true,
      payment_details: [{
        payment_form: datos.formaPagoCodigo || '1',
        payment_method_code: datos.medioPagoCodigo || 'ZZZ',
        amount: datos.montoAPagar,
        ...(String(datos.formaPagoCodigo) === '2' ? { due_date: datos.fechaVencimiento || hoyCO() } : {}),
      }],
      customer: mapearCustomer(datos.receptor),
      items: datos.items.map((it) => mapearItem(it, datos.descuentoComercialPct, datos.retenciones)),
    };
    const r = await request('POST', '/v2/credit-notes/validate', nota);
    const nc = r.data?.credit_note || r.data || {};
    const { rechazos, avisos } = clasificarErrores(nc.errors);
    return {
      referenceCode: datos.referenceCode,
      numeroDocumento: nc.number || null,
      validado: Boolean(nc.is_validated),
      cufe: nc.cude || nc.cufe || null,
      urlPublica: nc.links?.public_url || null,
      totales: {
        totalBruto: nc.totals?.gross_amount ?? null,
        subtotal: nc.totals?.taxable_amount ?? null,
        totalIva: nc.totals?.tax_amount ?? null,
        total: nc.totals?.total ?? null,
      },
      eventos: { rechazos, avisos },
      respuestaCruda: r,
    };
  }

  /** GET /v2/credit-notes/:number · reconciliación de una nota que quedó ENVIANDO. */
  async consultarNotaCredito(numeroDocumento) {
    if (!numeroDocumento) {
      return { estado: 'SIN_NUMERO', detalle: 'Todavía sin número asignado: reintente con la misma referencia.' };
    }
    const r = await request('GET', `/v2/credit-notes/${encodeURIComponent(numeroDocumento)}`);
    const nc = r.data?.credit_note || r.data || {};
    const { rechazos } = clasificarErrores(nc.errors);
    return {
      estado: rechazos.length ? 'RECHAZADO' : nc.is_validated ? 'VALIDADO' : 'ENVIANDO',
      detalle: rechazos.map(([, v]) => v).join('; ') || undefined,
      cufe: nc.cude || nc.cufe || null,
      urlPublica: nc.links?.public_url || null,
      respuestaCruda: r,
    };
  }

  async descargarPdfNotaCredito(numeroDocumento) {
    const r = await request('GET', `/v2/credit-notes/${encodeURIComponent(numeroDocumento)}/download-pdf`);
    const base64 = r.data?.pdf_base_64_encoded;
    if (!base64) throw new Error(`El proveedor tecnológico no devolvió el PDF de ${numeroDocumento}`);
    return { base64 };
  }

  async descargarXmlNotaCredito(numeroDocumento) {
    const r = await request('GET', `/v2/credit-notes/${encodeURIComponent(numeroDocumento)}/download-xml`);
    const base64 = r.data?.xml_base_64_encoded;
    if (!base64) throw new Error(`El proveedor tecnológico no devolvió el XML de ${numeroDocumento}`);
    return { base64 };
  }

  // ─── A4-01 · Documento soporte ────────────────────────────────────────────
  // POST /v2/support-documents/validate, GET /v2/support-documents/:number y
  // /download-pdf (developers.factus.com.co/documentos-soporte, leída el
  // 7-oct-2026). Probado en sandbox con `scripts/factus-probar-ds.mjs`: validó
  // SEDS984000922 y la respuesta trae `number` (con el prefijo pegado), `cuds`,
  // `is_validated`, `totals` y `links.qr`. Hallazgo: la DIAN exige que el
  // proveedor residente vaya con documento tipo NIT (31) aunque sea persona
  // natural — su cédula con el DV —; con 13 (cédula) rechaza con 422.

  /**
   * @param {{referenceCode: string, proveedor: object, items: {codigo?: string, descripcion: string, cantidad: number, valorUnitario: number}[],
   *   numberingRangeId?: number, formaPagoCodigo: string, medioPagoCodigo: string, montoAPagar: string,
   *   fechaVencimiento?: string, observacion?: string}} datos
   */
  async emitirDocumentoSoporte(datos) {
    const p = datos.proveedor;
    const juridica = p.tipoPersona !== 'NATURAL';
    const cuerpo = {
      reference_code: datos.referenceCode,
      numbering_range_id: datos.numberingRangeId || undefined,
      observation: datos.observacion ? String(datos.observacion).slice(0, 500) : undefined,
      payment_details: [{
        payment_form: datos.formaPagoCodigo || '2',
        payment_method_code: datos.medioPagoCodigo || 'ZZZ',
        amount: datos.montoAPagar,
        ...(String(datos.formaPagoCodigo || '2') === '2' ? { due_date: datos.fechaVencimiento || hoyCO() } : {}),
      }],
      provider: {
        identification_document_code: '31',
        identification: String(p.nit).replace(/\D/g, ''),
        dv: p.dv != null ? String(p.dv) : undefined,
        legal_organization_code: juridica ? '1' : '2',
        names: p.razonSocial,
        ...(juridica ? { company: p.razonSocial } : {}),
        address: p.direccion,
        country_code: 'CO',
        municipality_code: p.municipioDane || undefined,
        email: p.email || undefined,
        phone: p.telefono || undefined,
      },
      // Honorarios sin IVA: el tributo 01 va en 0 % y excluido, como lo validó el sandbox.
      items: datos.items.map((it) => ({
        code_reference: it.codigo || 'HON',
        name: it.descripcion,
        quantity: dosDec(it.cantidad),
        discount_rate: '0.00',
        price: dosDec(it.valorUnitario),
        unit_measure_code: '94',
        standard_code: '999',
        taxes: [{ code: '01', rate: '0.00', is_excluded: true }],
      })),
    };
    const r = await request('POST', '/v2/support-documents/validate', cuerpo);
    const ds = r.data?.support_document || r.data || {};
    const { rechazos, avisos } = clasificarErrores(ds.errors);
    return {
      referenceCode: datos.referenceCode,
      numeroDocumento: ds.number || null,
      validado: Boolean(ds.is_validated),
      cufe: ds.cuds || ds.cude || null,
      urlPublica: ds.links?.qr || ds.links?.public_url || null,
      totales: { total: ds.totals?.total ?? null },
      eventos: { rechazos, avisos },
      respuestaCruda: r,
    };
  }

  /** GET /v2/support-documents/:number · reconciliación de un DS que quedó ENVIANDO. */
  async consultarDocumentoSoporte(numeroDocumento) {
    if (!numeroDocumento) {
      return { estado: 'SIN_NUMERO', detalle: 'Todavía sin número asignado: reintente con la misma referencia.' };
    }
    const r = await request('GET', `/v2/support-documents/${encodeURIComponent(numeroDocumento)}`);
    const ds = r.data?.support_document || r.data || {};
    const { rechazos } = clasificarErrores(ds.errors);
    return {
      estado: rechazos.length ? 'RECHAZADO' : ds.is_validated ? 'VALIDADO' : 'ENVIANDO',
      detalle: rechazos.map(([, v]) => v).join('; ') || undefined,
      cufe: ds.cuds || ds.cude || null,
      urlPublica: ds.links?.qr || ds.links?.public_url || null,
      respuestaCruda: r,
    };
  }

  async descargarPdfDocumentoSoporte(numeroDocumento) {
    const r = await request('GET', `/v2/support-documents/${encodeURIComponent(numeroDocumento)}/download-pdf`);
    const base64 = r.data?.pdf_base_64_encoded;
    if (!base64) throw new Error(`El proveedor tecnológico no devolvió el PDF de ${numeroDocumento}`);
    return { base64 };
  }

  // ─── A4-03 · Nota de ajuste al documento soporte ──────────────────────────
  // POST /v2/adjustment-notes/validate con el mismo cuerpo del DS más
  // `support_document_number` y `correction_concept_code` (1 devolución parcial,
  // 2 anulación, 3 rebaja, 4 ajuste de precio, 5 otros). Probado en sandbox el
  // 7-oct-2026 (`scripts/factus-probar-nota-ajuste.mjs`): validó NA140; la
  // respuesta trae `number` con el prefijo, `cuds` y `support_document`.

  /** @param {object} datos los de `emitirDocumentoSoporte` + `numeroDocumentoSoporte` y `conceptoCorreccion`. */
  async emitirNotaAjusteSoporte(datos) {
    const p = datos.proveedor;
    const juridica = p.tipoPersona !== 'NATURAL';
    const cuerpo = {
      reference_code: datos.referenceCode,
      numbering_range_id: datos.numberingRangeId || undefined,
      support_document_number: datos.numeroDocumentoSoporte,
      correction_concept_code: String(datos.conceptoCorreccion),
      observation: datos.observacion ? String(datos.observacion).slice(0, 500) : undefined,
      payment_details: [{
        payment_form: datos.formaPagoCodigo || '2',
        payment_method_code: datos.medioPagoCodigo || 'ZZZ',
        amount: datos.montoAPagar,
        ...(String(datos.formaPagoCodigo || '2') === '2' ? { due_date: datos.fechaVencimiento || hoyCO() } : {}),
      }],
      provider: {
        identification_document_code: '31',
        identification: String(p.nit).replace(/\D/g, ''),
        dv: p.dv != null ? String(p.dv) : undefined,
        legal_organization_code: juridica ? '1' : '2',
        names: p.razonSocial,
        ...(juridica ? { company: p.razonSocial } : {}),
        address: p.direccion,
        country_code: 'CO',
        municipality_code: p.municipioDane || undefined,
        email: p.email || undefined,
        phone: p.telefono || undefined,
      },
      items: datos.items.map((it) => ({
        code_reference: it.codigo || 'HON',
        name: it.descripcion,
        quantity: dosDec(it.cantidad),
        discount_rate: '0.00',
        price: dosDec(it.valorUnitario),
        unit_measure_code: '94',
        standard_code: '999',
        taxes: [{ code: '01', rate: '0.00', is_excluded: true }],
      })),
    };
    const r = await request('POST', '/v2/adjustment-notes/validate', cuerpo);
    const na = r.data?.adjustment_note || r.data || {};
    const { rechazos, avisos } = clasificarErrores(na.errors);
    return {
      referenceCode: datos.referenceCode,
      numeroDocumento: na.number || null,
      validado: Boolean(na.is_validated),
      cufe: na.cuds || na.cude || null,
      urlPublica: na.links?.qr || na.links?.public_url || null,
      totales: { total: na.totals?.total ?? null },
      eventos: { rechazos, avisos },
      respuestaCruda: r,
    };
  }

  async consultarNotaAjusteSoporte(numeroDocumento) {
    if (!numeroDocumento) {
      return { estado: 'SIN_NUMERO', detalle: 'Todavía sin número asignado: reintente con la misma referencia.' };
    }
    const r = await request('GET', `/v2/adjustment-notes/${encodeURIComponent(numeroDocumento)}`);
    const na = r.data?.adjustment_note || r.data || {};
    const { rechazos } = clasificarErrores(na.errors);
    return {
      estado: rechazos.length ? 'RECHAZADO' : na.is_validated ? 'VALIDADO' : 'ENVIANDO',
      detalle: rechazos.map(([, v]) => v).join('; ') || undefined,
      cufe: na.cuds || na.cude || null,
      urlPublica: na.links?.qr || na.links?.public_url || null,
      respuestaCruda: r,
    };
  }

  async descargarPdfNotaAjusteSoporte(numeroDocumento) {
    const r = await request('GET', `/v2/adjustment-notes/${encodeURIComponent(numeroDocumento)}/download-pdf`);
    const base64 = r.data?.pdf_base_64_encoded;
    if (!base64) throw new Error(`El proveedor tecnológico no devolvió el PDF de ${numeroDocumento}`);
    return { base64 };
  }

  async descargarXmlNotaAjusteSoporte(numeroDocumento) {
    const r = await request('GET', `/v2/adjustment-notes/${encodeURIComponent(numeroDocumento)}/download-xml`);
    const base64 = r.data?.xml_base_64_encoded;
    if (!base64) throw new Error(`El proveedor tecnológico no devolvió el XML de ${numeroDocumento}`);
    return { base64 };
  }

  async descargarXmlDocumentoSoporte(numeroDocumento) {
    const r = await request('GET', `/v2/support-documents/${encodeURIComponent(numeroDocumento)}/download-xml`);
    const base64 = r.data?.xml_base_64_encoded;
    if (!base64) throw new Error(`El proveedor tecnológico no devolvió el XML de ${numeroDocumento}`);
    return { base64 };
  }

  // ─── A5-01 · Nómina electrónica ──────────────────────────────────────────────
  // POST /v2/payrolls (developers.factus.com.co/nomina/crear-y-validar, leída el
  // 8-oct-2026). Un documento por trabajador y periodo. Va por la cuenta 'nomina' del
  // cliente (`env.factusNomina`), que en producción es la misma de facturación.

  /**
   * Arma el cuerpo de la nómina a partir de la liquidación de `nomina/calculo.js`.
   * Separado de `emitirNominaElectronica` para poder revisarlo sin enviar nada.
   *
   * @param {{referenceCode: string, observacion?: string, rangoId?: string,
   *   periodo: {anio: number, mes: number},
   *   pago: {metodoCodigo: string, banco?: string, tipoCuenta?: string, numeroCuenta?: string, fecha: string},
   *   trabajador: {tipoDocumentoCodigo?: string, numeroDocumento: string, primerNombre: string, otrosNombres?: string,
   *     primerApellido: string, segundoApellido: string, direccion: string, municipioDane: string,
   *     salarioIntegral?: boolean, altoRiesgo?: boolean, tipoTrabajadorCodigo?: string, subtipoCodigo?: string,
   *     tipoContratoCodigo: string, codigoEmpleado?: string, salario: number, fechaIngreso: string, fechaRetiro?: string},
   *   liquidacion: ReturnType<import('../../nomina/calculo.js').liquidar>}} datos
   */
  cuerpoNomina(datos) {
    const t = datos.trabajador;
    const { devengados: d, deducciones: x } = datos.liquidacion;
    const fechas = (o) => ({ ...(o.inicio ? { start_date: o.inicio } : {}), ...(o.fin ? { end_date: o.fin } : {}) });

    const accruals = { suel: { amount: dosDec(d.sueldo) } };
    if (d.auxilioTransporte > 0) accruals.tra = [{ amount: dosDec(d.auxilioTransporte), accrual_type_code: 1 }];
    if (d.comisiones > 0) accruals.comi = [{ amount: dosDec(d.comisiones) }];
    if (d.bonificacion > 0) accruals.boni = [{ amount: dosDec(d.bonificacion), accrual_type_code: 1 }];
    if (d.horas.length) {
      accruals.hora = d.horas.map((h) => ({
        quantity: String(h.cantidad), percentage: dosDec(h.porcentaje), amount: dosDec(h.valor),
        ...fechas(h), accrual_type_code: String(h.codigo),
      }));
    }
    if (d.vacaciones.length) accruals.vaca = d.vacaciones.map((v) => ({ quantity: v.dias, amount: dosDec(v.valor), ...fechas(v), accrual_type_code: v.codigo }));
    if (d.licencias.length) {
      // La licencia no remunerada (tipo 3) va sin valor.
      accruals.lice = d.licencias.map((l) => ({ quantity: l.dias, ...(l.codigo === 3 ? {} : { amount: dosDec(l.valor) }), ...fechas(l), accrual_type_code: l.codigo }));
    }
    if (d.incapacidades.length) accruals.inca = d.incapacidades.map((i) => ({ quantity: i.dias, amount: dosDec(i.valor), ...fechas(i), accrual_type_code: i.codigo }));
    if (d.prima) accruals.prim = { quantity: d.prima.dias, amount: dosDec(d.prima.valor), accrual_type_code: 1 };
    if (d.cesantias) {
      accruals.cesa = [
        { amount: dosDec(d.cesantias.valor), accrual_type_code: 1 },
        { amount: dosDec(d.cesantias.intereses), percentage: dosDec(d.cesantias.porcentajeIntereses), accrual_type_code: 2 },
      ];
    }

    const deductions = {
      salu: { amount: dosDec(x.salud.valor), percentage: dosDec(x.salud.porcentaje) },
      pens: { amount: dosDec(x.pension.valor), percentage: dosDec(x.pension.porcentaje) },
    };
    // Fondo de solidaridad pensional: obligatorio desde 4 salarios mínimos. El proveedor lo
    // exige como LISTA (el 8-oct-2026 rechazó un objeto: «debe ser una lista»), una fila por
    // subcuenta: 0,5 % a solidaridad (tipo 1) y el resto a subsistencia (tipo 2).
    if (x.fondoSolidaridad) {
      const { valor, porcentaje } = x.fondoSolidaridad;
      const solidaridad = Math.round(valor * 0.5 / porcentaje * 100) / 100;
      deductions.dedu = [
        { amount: dosDec(solidaridad), percentage: dosDec(0.5), deduction_type_code: 1 },
        { amount: dosDec(valor - solidaridad), percentage: dosDec(porcentaje - 0.5), deduction_type_code: 2 },
      ];
    }

    // Banco y cuenta solo cuando el pago es por consignación (42), transferencia (47) o
    // ilimitada (98): con otro medio el proveedor no los espera.
    const conCuenta = ['42', '47', '98'].includes(String(datos.pago.metodoCodigo));
    return {
      reference_code: datos.referenceCode,
      observation: datos.observacion ? String(datos.observacion).slice(0, 500) : undefined,
      numbering_range_id: datos.rangoId || undefined,
      settlement_period: { month: String(datos.periodo.mes), year: String(datos.periodo.anio), payroll_period_code: '5' }, // 5 = mensual
      payment: {
        payment_method_code: String(datos.pago.metodoCodigo),
        ...(conCuenta ? { bank_name: datos.pago.banco, account_type: String(datos.pago.tipoCuenta), account_number: String(datos.pago.numeroCuenta) } : {}),
        payment_date: datos.pago.fecha,
      },
      worker: {
        identification_document_code: t.tipoDocumentoCodigo || '13',
        identification_number: String(t.numeroDocumento),
        first_name: t.primerNombre,
        ...(t.otrosNombres ? { other_names: t.otrosNombres } : {}),
        first_surname: t.primerApellido,
        second_surname: t.segundoApellido,
        address: t.direccion,
        country_code: 'CO',
        municipality_code: t.municipioDane,
        has_integral_salary: Boolean(t.salarioIntegral),
        has_high_risk: Boolean(t.altoRiesgo),
        worker_subtype: t.subtipoCodigo || '00',
        contract_type: String(t.tipoContratoCodigo),
        ...(t.codigoEmpleado ? { employee_code: String(t.codigoEmpleado) } : {}),
        worker_type_code: t.tipoTrabajadorCodigo || '01',
        salary: dosDec(t.salario),
        entry_date: t.fechaIngreso,
        ...(t.fechaRetiro ? { retirement_date: t.fechaRetiro } : {}),
        days_worked: dosDec(datos.liquidacion.diasTrabajados),
      },
      accruals,
      deductions,
    };
  }

  /** Emite la nómina. Devuelve la misma forma que las demás emisiones (`cufe` lleva el CUNE). */
  async emitirNominaElectronica(datos) {
    const r = await request('POST', '/v2/payrolls', this.cuerpoNomina(datos), { perfil: 'nomina' });
    const n = r.data?.payroll || r.data || {};
    const { rechazos, avisos } = clasificarErrores(n.errors);
    return {
      referenceCode: datos.referenceCode,
      numeroDocumento: n.number || null,
      validado: Boolean(n.is_validated),
      cufe: n.cune || null,
      urlPublica: n.qr || null,
      totales: { devengado: n.total_accruals ?? null, deducido: n.total_deductions ?? null, total: n.net_balance ?? null },
      eventos: { rechazos, avisos },
      respuestaCruda: r,
    };
  }

  /**
   * DELETE /v2/payrolls/reference/:reference_code · quita una nómina que el proveedor creó
   * pero la DIAN no validó. Mientras exista, bloquea la creación de cualquier otra (409).
   */
  async eliminarNominaNoValidada(referenceCode) {
    await request('DELETE', `/v2/payrolls/reference/${encodeURIComponent(referenceCode)}`, undefined, { perfil: 'nomina' });
  }

  /**
   * Nota de ajuste de ELIMINACIÓN: anula una nómina ya validada (para corregirla se elimina
   * y se emite otra). POST /v2/adjustment-payrolls, probado en el ambiente de pruebas el
   * 8-oct-2026 (NAN1…NAN4). Una nómina solo admite una nota: la segunda responde 422.
   * @param {{referenceCode: string, numeroNomina: string, rangoId?: string}} datos
   */
  async emitirNotaAjusteNomina(datos) {
    const r = await request('POST', '/v2/adjustment-payrolls', {
      payroll_number: datos.numeroNomina,
      reference_code: datos.referenceCode,
      numbering_range_id: datos.rangoId || undefined,
    }, { perfil: 'nomina' });
    const n = r.data?.adjustment_payroll || r.data || {};
    const { rechazos, avisos } = clasificarErrores(n.errors);
    return {
      referenceCode: datos.referenceCode,
      numeroDocumento: n.number || null,
      validado: Boolean(n.is_validated),
      cufe: n.cune || null,
      urlPublica: n.qr || null,
      eventos: { rechazos, avisos },
      respuestaCruda: r,
    };
  }

  /** GET /v2/numbering-ranges/payrolls · rangos de nómina y de nota de ajuste de nómina. */
  async listarRangosNomina() {
    const r = await request('GET', '/v2/numbering-ranges/payrolls', undefined, { perfil: 'nomina' });
    const filas = Array.isArray(r.data) ? r.data : (r.data?.data ?? []);
    return filas.map((x) => ({
      proveedorId: x.id,
      documentoProveedor: x.document,
      esNotaAjuste: /ajuste/i.test(String(x.document)),
      prefijo: x.prefix ?? null,
      actual: Number(x.current ?? 0),
      activo: Boolean(x.is_active) && !x.deleted_at,
    }));
  }
}
