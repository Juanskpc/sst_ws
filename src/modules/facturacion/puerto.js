/**
 * Puerto de "proveedor de facturación electrónica" (patrón puerto + adaptador).
 *
 * Diseño únicamente — no hay ningún adaptador real conectado todavía. Ver
 * docs/2-arquitectura/facturacion-electronica.md §4 (arquitectura) y §7 (qué se puede avanzar
 * sin el dato de volumen). No usar en producción hasta cerrar D-1, D-3, D-5.
 *
 * Un `receptor` NO es siempre una ARL: la reunión del 19-sep-2026 confirmó que
 * JD&D también factura a empresas privadas contratadas de forma directa (ej.
 * Alkosto), así que el puerto modela al receptor de forma genérica (NIT, razón
 * social, dirección) y no asume `sst.arls` como única fuente.
 *
 * Este puerto cubre SOLO documentos electrónicos DIAN (factura, documento
 * soporte, nómina). El módulo contable completo que JD&D pidió reemplazar de
 * Siigo (comprobantes de egreso, recibos de caja, provisiones, conciliación
 * bancaria) es un alcance aparte, sin diseñar todavía — ver §8.H, D-7.
 *
 * @typedef {object} Receptor
 * @property {string} nit
 * @property {number} [dv]
 * @property {string} [tipoDocumentoIdentidad] Código DIAN ('31' NIT, '13' cédula…); por defecto NIT.
 * @property {string} razonSocial
 * @property {'JURIDICA'|'NATURAL'} [tipoPersona] Por defecto JURIDICA.
 * @property {string} [direccion]
 * @property {string} [municipioDane]
 * @property {string} [email]
 * @property {string} [telefono]
 * @property {string} [tributoCodigo] Código DIAN del tributo del receptor ('ZZ' No aplica, si no se sabe).
 * @property {string[]} [responsabilidadesFiscales] Códigos O-xx / R-99-PN.
 *
 * @typedef {object} LineaDocumento
 * @property {string} [codigo] Código propio del producto/servicio.
 * @property {string} descripcion
 * @property {number} cantidad
 * @property {number} valorUnitario Precio NETO (sin impuestos ni descuento), en pesos.
 * @property {string} [unidadMedidaCodigo] Código DIAN de unidad ('94' unidad, 'HUR' hora…); por defecto '94'.
 * @property {number} [tarifaIva] 0 si no aplica.
 *
 * @typedef {object} RetencionDocumento
 * @property {string} codigoFactus Código de tributo en Factus ('05' IVA, '06' renta); ver A0-07.
 * @property {number} tarifa Porcentaje (11 = 11 %, 1.1 = 1,1 %).
 *
 * @typedef {object} DatosFactura
 * @property {string} referenceCode Único por intento de emisión (idempotencia, §5.1.5).
 * @property {Receptor} receptor
 * @property {LineaDocumento[]} items
 * @property {number} [descuentoComercialPct] Se aplica por igual a cada línea (`discount_rate` de Factus).
 * @property {RetencionDocumento[]} [retenciones] Se informan en CADA línea (`withholding_taxes`); no
 *   descuentan el total que calcula Factus (eso es cosa de `calculo.js`, no del proveedor — ver su módulo).
 * @property {number} [numberingRangeId] Rango de Factus a usar; si se omite, Factus elige el único activo.
 * @property {boolean} [enviarCorreo] `send_email`; por defecto false (lo decide A1-06, no el adaptador).
 * @property {string} [observacion]
 *
 * @typedef {object} ResultadoEmision
 * @property {string} referenceCode
 * @property {string|null} numeroDocumento Prefijo + consecutivo; null si aún no valida.
 * @property {boolean} validado
 * @property {string|null} cufe
 * @property {string|null} urlPublica
 * @property {{totalBruto: string, subtotal: string, totalIva: string, total: string}} totales Tal como los
 *   devuelve EL PROVEEDOR (pueden no coincidir con `calculo.js`: ver la nota de A1-02 en la bitácora).
 * @property {{rechazos: [string,string][], avisos: [string,string][]}} eventos
 * @property {object} respuestaCruda Para guardar en `respuesta_proveedor` (A1-01).
 */

/**
 * Contrato que debe cumplir cualquier adaptador de proveedor de FE.
 * Cada método de un adaptador real hace la llamada HTTP correspondiente;
 * aquí solo se documenta la forma. Nunca importar un adaptador concreto
 * fuera de `sst_ws/src/modules/facturacion/` — el resto del código depende
 * de este contrato, no de Factus.
 */
export class PuertoFacturacionElectronica {
  /** @param {DatosFactura} datos
   *  @returns {Promise<ResultadoEmision>} */
  // eslint-disable-next-line no-unused-vars
  async emitirFactura(datos) {
    throw new Error('PuertoFacturacionElectronica.emitirFactura no implementado');
  }

  /** Descarga el PDF ya validado, en base64 (para guardarlo en storage.service.js).
   * @param {string} numeroDocumento
   *  @returns {Promise<{base64: string}>} */
  // eslint-disable-next-line no-unused-vars
  async descargarPdf(numeroDocumento) {
    throw new Error('PuertoFacturacionElectronica.descargarPdf no implementado');
  }

  /** @param {string} numeroDocumento
   *  @returns {Promise<{base64: string}>} */
  // eslint-disable-next-line no-unused-vars
  async descargarXml(numeroDocumento) {
    throw new Error('PuertoFacturacionElectronica.descargarXml no implementado');
  }

  /** A4-01 · El proveedor del DS es el profesional (o quien vende a JD&D sin facturar).
   *  También: `consultarDocumentoSoporte`, `descargarPdfDocumentoSoporte`, `descargarXmlDocumentoSoporte`.
   *  @param {{referenceCode: string, proveedor: Receptor, items: LineaDocumento[], montoAPagar: string}} datos
   *  @returns {Promise<ResultadoEmision>} */
  // eslint-disable-next-line no-unused-vars
  async emitirDocumentoSoporte(datos) {
    throw new Error('PuertoFacturacionElectronica.emitirDocumentoSoporte no implementado');
  }

  /**
   * Volumen mínimo (un solo empleado, ver docs/2-arquitectura/facturacion-electronica.md §8.E) —
   * incluido aquí solo para dejar completo el contrato de los tres tipos de
   * documento DIAN (D-8), no porque vaya a construirse antes que los otros dos.
   * @param {{empleado: object, periodoPago: {desde: string, hasta: string}, devengados: object, deducciones: object}} datos
   *  @returns {Promise<ResultadoEmision>} */
  // eslint-disable-next-line no-unused-vars
  async emitirNominaElectronica(datos) {
    throw new Error('PuertoFacturacionElectronica.emitirNominaElectronica no implementado');
  }

  /**
   * A0-08 · Rangos de numeración autorizados que el proveedor tiene para JD&D.
   * Un rango con `tipoDocumento: null` es de un documento que Orbita no emite
   * (p. ej. notas débito) y quien sincroniza lo omite.
   * @returns {Promise<Array<{proveedorId: number, tipoDocumento: string|null, documentoProveedor: string,
   *   prefijo: string|null, desde: number|null, hasta: number|null, actual: number,
   *   numeroResolucion: string|null, fechaDesde: string|null, fechaHasta: string|null, activo: boolean}>>} */
  // eslint-disable-next-line no-unused-vars
  async listarRangosNumeracion() {
    throw new Error('PuertoFacturacionElectronica.listarRangosNumeracion no implementado');
  }

  /**
   * Reconcilia el estado real de un documento que quedó `ENVIANDO` (timeout o
   * corte de red, §5.1.5). Solo por número: la fuente de A1-02
   * (developers.factus.com.co/facturas/ver) confirma `GET /v2/bills/:number`;
   * no hay endpoint confirmado por `reference_code` para un documento que
   * Factus nunca llegó a crear (si `numeroDocumento` es null, no hay nada que
   * consultar: se reintenta la emisión, nunca a ciegas con el mismo reference_code).
   * @param {string} numeroDocumento
   *  @returns {Promise<{estado: string, detalle?: string}>} */
  // eslint-disable-next-line no-unused-vars
  async consultarEstado(numeroDocumento) {
    throw new Error('PuertoFacturacionElectronica.consultarEstado no implementado');
  }

  /**
   * A1-07 (FEL-12, 19) · Eventos RADIAN de una factura EMITIDA (acuse, reclamo,
   * recibo, aceptación expresa/tácita que la DIAN va anotando). Solo lectura:
   * no hay método de escritura en este puerto porque el endpoint de registrar
   * un evento no está confirmado para facturas propias (ver la nota de
   * `factus.adaptador.js`, Q-26).
   * @param {string} numeroDocumento
   *  @returns {Promise<Array<{codigo: string, descripcion: string|null, fecha: string|null, crudo: object}>>} */
  // eslint-disable-next-line no-unused-vars
  async consultarEventosRadian(numeroDocumento) {
    throw new Error('PuertoFacturacionElectronica.consultarEventosRadian no implementado');
  }
}
