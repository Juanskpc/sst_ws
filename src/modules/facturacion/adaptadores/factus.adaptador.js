import { PuertoFacturacionElectronica } from '../puerto.js';
import { request } from './factus.cliente.js';

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
 * (nota de docs/facturacion-electronica.md §7, punto 7) y "exento por norma" es
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
        due_date: datos.fechaVencimiento || new Date().toISOString().slice(0, 10),
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
        ...(String(datos.formaPagoCodigo) === '2' ? { due_date: datos.fechaVencimiento || new Date().toISOString().slice(0, 10) } : {}),
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

  async emitirDocumentoSoporte() {
    throw new Error('La emisión de documento soporte todavía no está disponible.');
  }

  async emitirNominaElectronica() {
    throw new Error('La emisión de nómina electrónica todavía no está disponible.');
  }
}
