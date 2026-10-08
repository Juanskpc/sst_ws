import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { pool } from '../../config/db.js';
import { storage } from '../../services/storage.service.js';
import { obtenerBorrador } from './borrador.service.js';

/**
 * 7-oct-2026 (reunión con JD&D) · REPRESENTACIÓN GRÁFICA PROPIA de la factura.
 *
 * JD&D pidió EL MISMO formato que les daba su software contable anterior, porque
 * trae datos que el PDF del proveedor tecnológico no muestra y que sus clientes (las
 * ARL) ya esperan ver. El modelo es `1-cliente-jdd/FE 816.zip → 1.FE-816.pdf`; las
 * medidas de abajo están tomadas de ese PDF (A4, en puntos, medidas desde arriba).
 * Una primera propuesta con otro diseño fue rechazada: aquí no se «mejora» nada.
 *
 * Desde el 8-oct-2026 es el PDF que se ve, se descarga, se reenvía y va en el paquete para
 * la ARL (`pdfDeDocumento`). El correo automático de la emisión lo sigue mandando el
 * proveedor tecnológico con su propio PDF.
 */

const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../assets/facturacion');
const [W, H] = [595.22, 842];
const NEGRO = rgb(0, 0, 0);
const LINEA = rgb(0.84, 0.84, 0.84);
const LATERAL = rgb(0.2, 0.25, 0.4);

// Marco y tabla, tal como en el modelo.
const IZQ = 39;
const DER = 543.5;
const TABLA_ARRIBA = 191;
const TABLA_CABECERA = 21;
// El modelo deja en blanco el último tramo de la hoja. JD&D pidió aprovecharla entera: el marco baja
// hasta el margen inferior, la tabla de ítems gana ese alto y todo lo que va debajo se corre igual.
const EXTRA = 80;
const TABLA_ABAJO = 479 + EXTRA;
// ítem · código · descripción · cantidad · vr. unitario · vr. bruto · impto. cargo · impto. rete. · vr. total
const COLS = [39, 58, 86, 277.6, 311, 359.4, 407.6, 451, 494, 543.5];
const TITULOS = [['Ítem'], ['Código'], ['Descripción'], ['Cantidad'], ['Vr. Unitario'], ['Vr. Bruto'], ['Valor', 'Impto.Cargo'], ['Valor', 'Impto.Rete.'], ['Vr. Total']];

const winAnsi = (t) => String(t ?? '').replace(/—/g, '-').replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF‘’“”–…•€]/g, '?');
const dinero = (v) => (Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fechaCO = (f) => { const [a, m, d] = String(f ?? '').slice(0, 10).split('-'); return a && m && d ? `${d}/${m}/${a}` : ''; };

// ── Valor en letras ──────────────────────────────────────────────────────────
const UNI = ['', 'un', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce', 'quince',
  'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte', 'veintiún', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco',
  'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'];
const DEC = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const CEN = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];
function hasta999(n) {
  if (n === 100) return 'cien';
  const c = Math.floor(n / 100);
  const r = n % 100;
  const resto = r < 30 ? UNI[r] : DEC[Math.floor(r / 10)] + (r % 10 ? ` y ${UNI[r % 10]}` : '');
  return [CEN[c], resto].filter(Boolean).join(' ');
}
/** 7993892.78 → «Siete millones novecientos noventa y tres mil ochocientos noventa y dos pesos m/cte con setenta y ocho cent.» */
export function valorEnLetras(valor) {
  const total = Math.round((Number(valor) || 0) * 100);
  const entero = Math.floor(total / 100);
  const centavos = total % 100;
  const millones = Math.floor(entero / 1e6);
  const miles = Math.floor((entero % 1e6) / 1000);
  const resto = entero % 1000;
  const partes = [];
  if (millones) partes.push(millones === 1 ? 'un millón' : `${hasta999(millones)} millones`);
  if (miles) partes.push(miles === 1 ? 'mil' : `${hasta999(miles)} mil`);
  if (resto) partes.push(hasta999(resto));
  let texto = partes.join(' ') || 'cero';
  // «un millón de pesos», pero «un millón doscientos mil pesos».
  texto += (millones && !miles && !resto ? ' de' : '') + (entero === 1 ? ' peso' : ' pesos') + ' m/cte';
  if (centavos) texto += ` con ${hasta999(centavos)} cent.`;
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

function renglones(texto, fuente, tam, ancho) {
  const salida = [];
  for (const parrafo of winAnsi(texto).split('\n')) {
    let linea = '';
    for (const palabra of parrafo.split(/\s+/).filter(Boolean)) {
      const prueba = linea ? `${linea} ${palabra}` : palabra;
      if (fuente.widthOfTextAtSize(prueba, tam) <= ancho || !linea) linea = prueba;
      else { salida.push(linea); linea = palabra; }
    }
    if (linea) salida.push(linea);
  }
  return salida;
}

/** Meses completos entre dos fechas ISO (la «Vigencia» de la autorización de numeración). */
function mesesEntre(desde, hasta) {
  const [a1, m1] = String(desde ?? '').split('-').map(Number);
  const [a2, m2] = String(hasta ?? '').split('-').map(Number);
  return a1 && a2 ? (a2 - a1) * 12 + (m2 - m1) : null;
}

/**
 * @param doc      el detalle de `obtenerBorrador` (factura VALIDADA).
 * @param emisor   { razon_social, nit, direccion, ciudad, telefono, correo, regimen, actividad }
 * @param cliente  { nombre, documento, direccion, ciudad, telefono }
 * @param resolucion { numero_resolucion, fecha_desde, fecha_hasta, prefijo, desde, hasta } | null
 * @param enlaceQr el enlace de consulta de la DIAN (va en el QR).
 * @param lateral  el texto vertical del borde derecho (fabricante del software y proveedor tecnológico).
 */
export async function pdfFactura({ doc, emisor, cliente, resolucion = null, enlaceQr = null, lateral = null }) {
  const pdf = await PDFDocument.create();
  const [n, b] = await Promise.all([pdf.embedFont(StandardFonts.Helvetica), pdf.embedFont(StandardFonts.HelveticaBold)]);
  const rutaLogo = path.join(ASSETS, 'logo-jdd.jpg');
  const logo = fs.existsSync(rutaLogo) ? await pdf.embedJpg(new Uint8Array(fs.readFileSync(rutaLogo))) : null;
  const qr = enlaceQr ? await pdf.embedPng(await QRCode.toBuffer(enlaceQr, { margin: 0, width: 420, errorCorrectionLevel: 'M' })) : null;
  const numero = String(doc.numero ?? '').replace(new RegExp(`^${doc.prefijo ?? ''}`), '');
  const titulo = `No. ${doc.prefijo ?? ''} ${numero}`;

  // Todas las medidas van «desde arriba», como se leen en el modelo.
  let p;
  const texto = (t, x, arriba, { f = n, s = 7, c = NEGRO } = {}) => p.drawText(winAnsi(t), { x, y: H - arriba, size: s, font: f, color: c });
  const ancho = (t, o = {}) => (o.f ?? n).widthOfTextAtSize(winAnsi(t), o.s ?? 7);
  const derecha = (t, xDer, arriba, o = {}) => texto(t, xDer - ancho(t, o), arriba, o);
  const centro = (t, xCentro, arriba, o = {}) => texto(t, xCentro - ancho(t, o) / 2, arriba, o);
  const caja = (x1, arriba, x2, abajo) => p.drawRectangle({ x: x1, y: H - abajo, width: x2 - x1, height: abajo - arriba, borderColor: LINEA, borderWidth: 0.8 });
  const hor = (x1, x2, arriba) => p.drawLine({ start: { x: x1, y: H - arriba }, end: { x: x2, y: H - arriba }, thickness: 0.8, color: LINEA });
  const ver = (x, arriba, abajo) => p.drawLine({ start: { x, y: H - arriba }, end: { x, y: H - abajo }, thickness: 0.8, color: LINEA });

  const marco = () => {
    // El marco redondeado que rodea toda la factura.
    const [x, y, w, h, r] = [33, 33.5, 529, 695.5 + EXTRA, 4];
    p.drawSvgPath(`M ${r},0 H ${w - r} Q ${w},0 ${w},${r} V ${h - r} Q ${w},${h} ${w - r},${h} H ${r} Q 0,${h} 0,${h - r} V ${r} Q 0,0 ${r},0 Z`,
      { x, y: H - y, borderColor: LINEA, borderWidth: 0.8 });
    if (lateral) p.drawText(winAnsi(lateral), { x: 554.5, y: H - 538 - EXTRA, size: 5.2, font: n, color: LATERAL, rotate: degrees(90) });
  };

  const encabezado = () => {
    if (logo) {
      const wLogo = 80;
      p.drawImage(logo, { x: 83, y: H - 92, width: wLogo, height: wLogo * (logo.height / logo.width) });
    }
    const cx = 231.5;
    let y = 57;
    renglones(emisor.razon_social, b, 6.6, 138).forEach((l) => { centro(l, cx, y, { f: b, s: 6.6 }); y += 7.6; });
    [`NIT ${emisor.nit}`, emisor.direccion, emisor.telefono ? `Tel: ${emisor.telefono}` : null, emisor.ciudad, emisor.correo]
      // Cada dato se parte si no cabe entre el logo y el QR (la dirección nueva es más larga que la del modelo).
      .filter(Boolean).flatMap((l) => renglones(l, n, 6.6, 138)).forEach((l) => { centro(l, cx, y, { s: 6.6 }); y += 7.5; });
    if (qr) p.drawImage(qr, { x: 306.5, y: H - 113, width: 71.5, height: 71.5 });
    caja(382.5, 62.5, DER, 97.5);
    centro('Factura electrónica de venta', (382.5 + DER) / 2, 78.5, { s: 9 });
    centro(titulo, (382.5 + DER) / 2, 88, { f: b, s: 7.6 });

    // Adquirente
    const nombre = renglones(cliente.nombre, n, 6.6, 357 - 104 - 4).slice(0, 2);
    caja(IZQ, 127.5, 357, 168.5);
    hor(104, 357, 146); hor(104, 357, 157.5);
    texto('Señores', 40.8, 139.5, { f: b, s: 6.6 });
    nombre.forEach((l, i) => texto(l, 104, (nombre.length > 1 ? 135.5 : 139.5) + i * 7.6, { s: 6.6 }));
    texto('NIT', 40.8, 154.2, { f: b, s: 6.6 }); texto(cliente.documento, 104, 154.2, { s: 6.6 });
    texto('Teléfono', 213, 154.2, { f: b, s: 6.6 }); texto(cliente.telefono || '', 263, 154.2, { s: 6.6 });
    texto('Dirección', 40.8, 165.5, { f: b, s: 6.6 }); texto(String(cliente.direccion || '').slice(0, 36), 104, 165.5, { s: 6.6 });
    texto('Ciudad', 213, 165.5, { f: b, s: 6.6 }); texto(cliente.ciudad || '', 263, 165.5, { s: 6.6 });

    // Fecha y hora
    const xF = 381;
    const xV = 435;
    caja(xF, 121, DER, 174.5);
    hor(xF, DER, 134.7); ver(xV, 134.7, 174.5);
    hor(xV, DER, 147.7); hor(xV, DER, 161.5);
    centro('Fecha y hora Factura', (xF + DER) / 2, 130.2, { f: b, s: 6.6 });
    const hora = new Date(new Date(doc.actualizado_en ?? doc.creado_en).getTime() - 5 * 3600e3).toISOString().slice(11, 16);
    centro('Generación', (xF + xV) / 2, 143.5, { f: b, s: 6.6 }); centro(`${fechaCO(doc.fecha_emision)}, ${hora}`, (xV + DER) / 2, 144, { s: 6.6 });
    centro('Expedición', (xF + xV) / 2, 157, { f: b, s: 6.6 }); centro(`${fechaCO(doc.fecha_emision)}, ${hora}`, (xV + DER) / 2, 157.5, { s: 6.6 });
    centro('Vencimiento', (xF + xV) / 2, 170, { f: b, s: 5.4 }); centro(fechaCO(doc.fecha_vencimiento), (xV + DER) / 2, 170.2, { s: 6.6 });
  };

  const tabla = () => {
    caja(IZQ, TABLA_ARRIBA, DER, TABLA_ABAJO);
    hor(IZQ, DER, TABLA_ARRIBA + TABLA_CABECERA);
    COLS.slice(1, -1).forEach((x) => ver(x, TABLA_ARRIBA, TABLA_ARRIBA + TABLA_CABECERA));
    TITULOS.forEach((t, i) => {
      const cx = (COLS[i] + COLS[i + 1]) / 2;
      if (t.length === 1) centro(t[0], cx, TABLA_ARRIBA + 13, { f: b, s: 6.6 });
      else t.forEach((l, k) => centro(l, cx, TABLA_ARRIBA + 9.5 + k * 7.5, { f: b, s: 6.6 }));
    });
  };

  const nuevaPagina = () => { p = pdf.addPage([W, H]); marco(); encabezado(); tabla(); return TABLA_ARRIBA + TABLA_CABECERA; };

  // ── Ítems
  let y = nuevaPagina();
  const retePct = (doc.retenciones ?? []).reduce((a, r) => a + Number(r.tarifa || 0), 0);
  const filas = doc.items ?? [];
  filas.forEach((it, i) => {
    const desc = renglones(it.descripcion, n, 6.6, COLS[3] - COLS[2] - 8);
    const alto = Math.max(16, desc.length * 7.6 + 9);
    if (y + alto > TABLA_ABAJO) y = nuevaPagina();
    COLS.slice(1, -1).forEach((x) => ver(x, y, y + alto));
    hor(IZQ, DER, y + alto);
    centro(String(i + 1), (COLS[0] + COLS[1]) / 2, y + alto / 2 + 2.4, { s: 6.6 });
    texto(it.codigo ?? '', COLS[1] + 3.5, y + 9.5, { s: 6.6 });
    desc.forEach((l, k) => texto(l, COLS[2] + 3.5, y + 10 + k * 7.6, { s: 6.6 }));
    const bruto = Number(it.cantidad) * Number(it.valor_unitario);
    const rete = Number(it.base ?? it.total_linea) * retePct / 100;
    [Number(it.cantidad).toFixed(2), dinero(it.valor_unitario), dinero(bruto), dinero(it.iva_valor), dinero(rete), dinero(Number(it.total_linea) + Number(it.iva_valor || 0) - rete)]
      .forEach((v, k) => derecha(v, COLS[4 + k] - 4.5, y + 10, { s: 6.6 }));
    y += alto;
  });

  // ── Pie de la última hoja: totales a la derecha, condiciones a la izquierda
  const t = doc.totales ?? doc;
  const nombreRete = (r) => `${r.tipo === 'RETEFUENTE' ? 'Retefuente' : r.tipo === 'RETEICA' ? 'ReteICA' : r.tipo === 'RETEIVA' ? 'ReteIVA' : r.codigo} ${Number(r.tarifa)}%`;
  const lineasTot = [
    ['Total Bruto', t.total_bruto, true],
    ...(Number(t.total_descuento) ? [['Descuentos', t.total_descuento, false], ['Subtotal', t.subtotal, false]] : []),
    ...(Number(t.total_iva) ? [['IVA', t.total_iva, false]] : []),
    ...(doc.retenciones ?? []).map((r) => [nombreRete(r), r.valor, false]),
    ['Total a Pagar', t.total_a_pagar, true],
  ];
  const xT = 381;
  const xTV = 462;
  let yt = 484.7 + EXTRA;
  lineasTot.forEach(([k, v, negrita]) => {
    caja(xT, yt, DER, yt + 16.4);
    ver(xTV, yt, yt + 16.4);
    texto(k, xT + 3, yt + 10.5, { f: negrita ? b : n, s: 6.6 });
    derecha(dinero(v), DER - 4.5, yt + 10.5, { s: 6.6 });
    yt += 16.4;
  });

  texto('Total items:', IZQ, 492 + EXTRA, { f: b, s: 9 });
  texto(String(filas.length), IZQ + ancho('Total items: ', { f: b, s: 9 }), 492 + EXTRA, { s: 9 });
  texto('Valor en Letras:', IZQ, 511 + EXTRA, { f: b, s: 9 });
  renglones(valorEnLetras(t.total_a_pagar), n, 6.6, 330).forEach((l, i) => texto(l, 44, 519.5 + EXTRA + i * 7.6, { s: 6.6 }));
  texto('Forma de pago:', IZQ, 535.5 + EXTRA, { f: b, s: 9 });
  texto(doc.forma_pago_nombre || '', 44, 545.5 + EXTRA, { s: 9 });
  texto('Medio de pago:', IZQ, 564.5 + EXTRA, { f: b, s: 9 });
  texto(`${doc.medio_pago_nombre || 'Otro'} - ${doc.forma_pago_nombre || ''} - Cuota No. 001 vence el ${String(doc.fecha_vencimiento ?? '').slice(0, 10)} por`, 46, 574 + EXTRA, { s: 6.6 });
  texto('$', 276, 574 + EXTRA, { s: 6.6 });
  derecha(dinero(t.total_a_pagar), 345.5, 574 + EXTRA, { s: 6.6 });
  texto('Observaciones:', IZQ, 603.5 + EXTRA, { f: b, s: 9 });
  if (doc.observaciones) renglones(doc.observaciones, n, 6.6, 480).slice(0, 8).forEach((l, i) => texto(l, 44, 613 + EXTRA + i * 7.6, { s: 6.6 }));

  // ── Leyenda legal, autorización de numeración y CUFE (centrados, como en el modelo)
  const cx = 297.6;
  const vigencia = mesesEntre(resolucion?.fecha_desde, resolucion?.fecha_hasta);
  const legal = 'A esta factura de venta aplican las normas relativas a la letra de cambio (artículo 5 Ley 1231 de 2008). Con esta el Comprador declara haber recibido real y materialmente las mercancías o prestación de servicios descritos en este título - Valor.';
  const autoriz = resolucion?.numero_resolucion
    ? `Número Autorización Electrónica ${resolucion.numero_resolucion} aprobado en ${String(resolucion.fecha_desde ?? '').replace(/-/g, '')} prefijo ${resolucion.prefijo ?? ''} desde el número ${resolucion.desde ?? ''} al ${resolucion.hasta ?? ''}${vigencia ? ` Vigencia: ${vigencia} Meses` : ''}`
    : '';
  // Normal + negrita en el mismo párrafo centrado: se parte por palabras llevando la fuente de cada una.
  const palabras = [...legal.split(' ').map((w) => [w, n]), ...autoriz.split(' ').filter(Boolean).map((w) => [w, b])];
  const lineas = [[]];
  let wLinea = 0;
  for (const [w, f] of palabras) {
    const wPal = f.widthOfTextAtSize(winAnsi(`${w} `), 5.7);
    if (wLinea + wPal > 476 && lineas[lineas.length - 1].length) { lineas.push([]); wLinea = 0; }
    lineas[lineas.length - 1].push([w, f]);
    wLinea += wPal;
  }
  let yl = 688 + EXTRA;
  for (const linea of lineas) {
    const total = linea.reduce((a, [w, f]) => a + f.widthOfTextAtSize(winAnsi(`${w} `), 5.7), 0);
    let x = cx - total / 2;
    for (const [w, f] of linea) { texto(w, x, yl, { f, s: 5.7 }); x += f.widthOfTextAtSize(winAnsi(`${w} `), 5.7); }
    yl += 6.5;
  }
  const fiscal = [emisor.regimen, emisor.actividad ? `Actividad Económica ${emisor.actividad}` : null].filter(Boolean).join(' - ');
  if (fiscal) { centro(fiscal, cx, yl, { s: 5.7 }); yl += 6.5; }
  const wCufe = ancho('CUFE: ', { f: b, s: 5.7 }) + ancho(doc.cufe ?? '', { s: 5.7 });
  texto('CUFE:', cx - wCufe / 2, yl, { f: b, s: 5.7 });
  texto(doc.cufe ?? '', cx - wCufe / 2 + ancho('CUFE: ', { f: b, s: 5.7 }), yl, { s: 5.7 });

  return Buffer.from(await pdf.save());
}

/**
 * La leyenda del borde derecho. JD&D factura en modo «software propio» ante la DIAN, y es
 * la misma frase que trae el PDF que entrega el proveedor tecnológico.
 */
const LEYENDA_LATERAL = 'Software: ORBITA. Factura electrónica generada con software propio autorizado por la DIAN. Firma electrónica: ver en el XML.';

/**
 * 8-oct-2026 · El PDF propio de una factura ya validada, armado con lo que hay en la base.
 * Es el que se ve, se descarga, se reenvía al cliente y va en el paquete para la ARL.
 *
 * Devuelve `null` cuando no se puede armar (no es una factura validada, o falta la
 * empresa emisora en Parametrización): quien llama cae entonces al PDF guardado del
 * proveedor (`pdf_path`). Las notas crédito y los documentos soporte siguen con ese.
 */
export async function pdfPropioFactura(documentoId, db = pool) {
  const doc = await obtenerBorrador(documentoId, db);
  if (doc.tipo !== 'FACTURA' || !['VALIDADO', 'ANULADO'].includes(doc.estado) || !doc.cufe) return null;

  const e = (await db.query(
    `SELECT e.razon_social, e.nit, e.dv, e.direccion, e.telefono, e.correo, e.ciiu_principal, e.responsabilidades_rut, m.nombre AS municipio
       FROM sst.emisor e LEFT JOIN sst.municipios m ON m.id = e.municipio_id WHERE e.id = 1`,
  )).rows[0];
  if (!e) return null;
  const t = (await db.query(
    `SELECT COALESCE(t.razon_social, btrim(concat_ws(' ', t.nombres, t.apellidos))) AS nombre, t.numero_documento, t.dv, t.direccion, t.telefono, m.nombre AS municipio
       FROM sst.terceros t LEFT JOIN sst.municipios m ON m.id = t.municipio_id WHERE t.id = $1`, [doc.tercero_id],
  )).rows[0];
  const resolucion = (await db.query(
    `SELECT numero_resolucion, fecha_desde::text, fecha_hasta::text, prefijo, desde, hasta FROM sst.resoluciones_numeracion
      WHERE tipo_documento = 'FACTURA' AND prefijo = $1 ORDER BY activa DESC LIMIT 1`, [doc.prefijo],
  )).rows[0] ?? null;

  const conDv = (numero, dv) => `${/^\d+$/.test(String(numero)) ? Number(numero).toLocaleString('es-CO') : numero}${dv != null ? `-${dv}` : ''}`;
  const rut = e.responsabilidades_rut ?? [];
  return pdfFactura({
    doc,
    emisor: {
      razon_social: e.razon_social, nit: conDv(e.nit, e.dv), direccion: e.direccion, telefono: e.telefono, correo: e.correo,
      ciudad: e.municipio ? `${e.municipio} - Colombia` : null,
      regimen: rut.includes('48') ? 'Responsable de IVA' : rut.includes('49') ? 'No responsable de IVA' : null,
      actividad: e.ciiu_principal,
    },
    cliente: {
      nombre: t?.nombre ?? doc.tercero_nombre, documento: t ? conDv(t.numero_documento, t.dv) : '',
      direccion: t?.direccion, telefono: t?.telefono, ciudad: t?.municipio ? `${t.municipio} - Colombia` : null,
    },
    resolucion,
    enlaceQr: doc.qr_url,
    lateral: LEYENDA_LATERAL,
  });
}

/**
 * El PDF que se le muestra o entrega a alguien: el propio si se puede armar y, si no, el
 * guardado del proveedor. Un fallo al dibujarlo no debe dejar a nadie sin su factura.
 */
export async function pdfDeDocumento(documentoId, pdfPath, db = pool) {
  const propio = await pdfPropioFactura(documentoId, db).catch((err) => {
    console.error(`[facturacion] No se pudo armar el PDF propio de ${documentoId}: ${err.message}`);
    return null;
  });
  if (propio) return propio;
  return pdfPath ? storage.get(pdfPath) : null;
}
