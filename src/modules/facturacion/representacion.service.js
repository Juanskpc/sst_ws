import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/**
 * 7-oct-2026 (reunión con JD&D) · REPRESENTACIÓN GRÁFICA PROPIA de la factura.
 *
 * JD&D está acostumbrado al PDF que les daba su software contable anterior: logo a
 * la izquierda, datos de la empresa al centro, QR y recuadro del número a la derecha,
 * la tabla de ítems y los totales abajo. Este es ese mismo orden, con la identidad
 * de JD&D (azul del logo) y el pie de ORBITA.
 *
 * ⚠️ PROPUESTA: todavía NO reemplaza al PDF que devuelve el proveedor tecnológico
 * (el que se guarda en `pdf_path` y se envía al cliente). Solo se genera con
 * `scripts/muestra-factura-pdf.mjs` para que el cliente apruebe el diseño.
 *
 * Lleva lo que la DIAN exige en la representación gráfica: numeración y resolución,
 * emisor y adquirente, fechas, detalle, impuestos y retenciones, CUFE y QR.
 */

const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../assets/facturacion');
const A4 = [595.28, 841.89];
const AZUL = rgb(0.0, 0.11, 0.44);       // el azul oscuro del logo
const CELESTE = rgb(0.34, 0.67, 0.87);   // el celeste del logo
const TENUE = rgb(0.93, 0.95, 0.98);
const GRIS = rgb(0.4, 0.44, 0.5);
const LINEA = rgb(0.8, 0.83, 0.88);
const NEGRO = rgb(0.08, 0.09, 0.12);
const BLANCO = rgb(1, 1, 1);

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
/** 205336.81 → «Doscientos cinco mil trescientos treinta y seis pesos m/cte con ochenta y un centavos». */
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
  if (centavos) texto += ` con ${hasta999(centavos)} ${centavos === 1 ? 'centavo' : 'centavos'}`;
  return texto.charAt(0).toUpperCase() + texto.slice(1) + '.';
}

function renglones(texto, fuente, tam, ancho) {
  const salida = [];
  let linea = '';
  for (const palabra of winAnsi(texto).split(/\s+/).filter(Boolean)) {
    const prueba = linea ? `${linea} ${palabra}` : palabra;
    if (fuente.widthOfTextAtSize(prueba, tam) <= ancho || !linea) linea = prueba;
    else { salida.push(linea); linea = palabra; }
  }
  if (linea) salida.push(linea);
  return salida;
}

/**
 * @param doc      el detalle de `obtenerBorrador` (factura VALIDADA).
 * @param emisor   { razon_social, nit, dv, direccion, ciudad, telefono, correo }
 * @param cliente  { nombre, documento, direccion, ciudad, telefono }
 * @param resolucion { numero_resolucion, fecha_desde, fecha_hasta, prefijo, desde, hasta } | null
 * @param enlaceQr el enlace de consulta de la DIAN (va en el QR).
 */
export async function pdfFactura({ doc, emisor, cliente, resolucion = null, enlaceQr = null }) {
  const pdf = await PDFDocument.create();
  const [n, b] = await Promise.all([pdf.embedFont(StandardFonts.Helvetica), pdf.embedFont(StandardFonts.HelveticaBold)]);
  const rutaLogo = path.join(ASSETS, 'logo-jdd.jpg');
  const logo = fs.existsSync(rutaLogo) ? await pdf.embedJpg(new Uint8Array(fs.readFileSync(rutaLogo))) : null;
  const qr = enlaceQr ? await pdf.embedPng(await QRCode.toBuffer(enlaceQr, { margin: 0, width: 360, errorCorrectionLevel: 'M' })) : null;
  const [W, H] = A4;
  const M = 34;                 // margen
  const ANCHO = W - M * 2;
  const numero = String(doc.numero ?? '').replace(new RegExp(`^${doc.prefijo ?? ''}`), '');

  // Columnas de la tabla: ítem · código · descripción · cantidad · vr. unitario · vr. bruto · impuesto · retención · total
  const cols = [22, 36, 0, 32, 56, 56, 42, 52, 58];
  cols[2] = ANCHO - cols.reduce((a, c) => a + c, 0);
  const xs = cols.reduce((acc, c) => [...acc, acc[acc.length - 1] + c], [M]);
  const titulos = ['Ítem', 'Código', 'Descripción', 'Cant.', 'Vr. unitario', 'Vr. bruto', 'Impuesto', 'Retención', 'Vr. total'];

  let p;
  const texto = (t, x, y, { f = n, s = 8, c = NEGRO } = {}) => p.drawText(winAnsi(t), { x, y, size: s, font: f, color: c });
  const derecha = (t, xDer, y, o = {}) => texto(t, xDer - (o.f ?? n).widthOfTextAtSize(winAnsi(t), o.s ?? 8), y, o);
  const centro = (t, xCentro, y, o = {}) => texto(t, xCentro - (o.f ?? n).widthOfTextAtSize(winAnsi(t), o.s ?? 8) / 2, y, o);
  const caja = (x, y, w, h, o = {}) => p.drawRectangle({ x, y, width: w, height: h, borderColor: LINEA, borderWidth: 0.7, ...o });

  const cabeceraTabla = (y) => {
    p.drawRectangle({ x: M, y: y - 18, width: ANCHO, height: 18, color: AZUL });
    titulos.forEach((t, i) => centro(t, xs[i] + cols[i] / 2, y - 12, { f: b, s: 7.2, c: BLANCO }));
    return y - 18;
  };
  const pie = (num, total) => {
    p.drawLine({ start: { x: M, y: 40 }, end: { x: W - M, y: 40 }, thickness: 0.6, color: LINEA });
    texto('Representación gráfica de la factura electrónica de venta · Generada con ORBITA', M, 29, { s: 6.5, c: GRIS });
    derecha(`Página ${num} de ${total}`, W - M, 29, { s: 6.5, c: GRIS });
  };

  const nuevaPagina = (primera, conTabla = true) => {
    p = pdf.addPage(A4);
    // Franja superior con los dos azules del logo: el sello de la casa.
    p.drawRectangle({ x: 0, y: H - 9, width: W, height: 9, color: AZUL });
    p.drawRectangle({ x: W - 150, y: H - 9, width: 150, height: 9, color: CELESTE });
    if (!primera) {
      texto(`Factura electrónica de venta ${doc.prefijo ?? ''} ${numero}`, M, H - 32, { f: b, s: 9, c: AZUL });
      derecha(emisor.razon_social, W - M, H - 32, { s: 8, c: GRIS });
      return conTabla ? cabeceraTabla(H - 44) : H - 50;
    }

    // ── Encabezado: logo · empresa · QR · número
    let y = H - 24;
    if (logo) p.drawImage(logo, { x: M, y: y - 58, width: 132, height: 132 * (logo.height / logo.width) });
    // La empresa va centrada en el hueco entre el logo y el QR.
    const cx = (M + 138 + (W - M - 152 - 78)) / 2;
    const wEmp = (W - M - 152 - 78) - (M + 138) - 6;
    const razon = renglones(emisor.razon_social, b, 8.2, wEmp);
    razon.forEach((l, i) => centro(l, cx, y - 10 - i * 10, { f: b, s: 8.2, c: AZUL }));
    const yEmp = y - 10 - razon.length * 10;
    [`NIT ${emisor.nit}`, emisor.direccion, emisor.telefono ? `Tel: ${emisor.telefono}` : null, emisor.ciudad, emisor.correo]
      .filter(Boolean).forEach((l, i) => centro(l, cx, yEmp - i * 9, { s: 7.2, c: NEGRO }));
    if (qr) p.drawImage(qr, { x: W - M - 152 - 72, y: y - 70, width: 66, height: 66 });
    // Recuadro del número: lo que más se busca en la hoja.
    p.drawRectangle({ x: W - M - 152, y: y - 22, width: 152, height: 22, color: AZUL });
    centro('FACTURA ELECTRÓNICA DE VENTA', W - M - 76, y - 14.5, { f: b, s: 7.6, c: BLANCO });
    caja(W - M - 152, y - 70, 152, 48, { color: TENUE });
    centro(`No. ${doc.prefijo ?? ''} ${numero}`, W - M - 76, y - 44, { f: b, s: 14, c: AZUL });
    centro(doc.estado === 'ANULADO' ? 'ANULADA' : 'Validada por la DIAN', W - M - 76, y - 60, { s: 7, c: GRIS });

    // ── Adquirente y fechas
    y -= 86;
    const wCli = ANCHO - 162;
    caja(M, y - 52, wCli, 52);
    p.drawRectangle({ x: M, y: y - 52, width: 3, height: 52, color: CELESTE });
    const et = (t, x, yy) => texto(t, x, yy, { f: b, s: 7.4, c: AZUL });
    et('Señores', M + 10, y - 14); texto(cliente.nombre, M + 62, y - 14, { f: b, s: 8.2 });
    et('NIT', M + 10, y - 29); texto(cliente.documento, M + 62, y - 29);
    et('Teléfono', M + wCli / 2, y - 29); texto(cliente.telefono || '-', M + wCli / 2 + 46, y - 29);
    et('Dirección', M + 10, y - 44); texto(String(cliente.direccion || '-').slice(0, 34), M + 62, y - 44);
    et('Ciudad', M + wCli / 2, y - 44); texto(cliente.ciudad || '-', M + wCli / 2 + 46, y - 44);

    const xF = W - M - 152;
    p.drawRectangle({ x: xF, y: y - 14, width: 152, height: 14, color: TENUE, borderColor: LINEA, borderWidth: 0.7 });
    centro('Fecha de la factura', xF + 76, y - 10, { f: b, s: 7.2, c: AZUL });
    caja(xF, y - 52, 152, 38);
    const hora = new Date(new Date(doc.actualizado_en ?? doc.creado_en).getTime() - 5 * 3600e3).toISOString().slice(11, 16);
    [['Generación', `${fechaCO(doc.fecha_emision)}  ${hora}`], ['Expedición', `${fechaCO(doc.fecha_emision)}  ${hora}`], ['Vencimiento', fechaCO(doc.fecha_vencimiento)]]
      .forEach(([k, v], i) => { et(k, xF + 8, y - 25 - i * 11); derecha(v, xF + 146, y - 25 - i * 11, { s: 7.6 }); });

    return cabeceraTabla(y - 64);
  };

  // ── Ítems
  let y = nuevaPagina(true);
  const retePct = (doc.retenciones ?? []).reduce((a, r) => a + Number(r.tarifa || 0), 0);
  const filas = doc.items ?? [];
  filas.forEach((it, i) => {
    const desc = renglones(it.descripcion, n, 7.6, cols[2] - 8);
    const alto = Math.max(17, desc.length * 9.4 + 7);
    if (y - alto < 60) { y = nuevaPagina(false); }
    if (i % 2) p.drawRectangle({ x: M, y: y - alto, width: ANCHO, height: alto, color: rgb(0.975, 0.98, 0.99) });
    p.drawLine({ start: { x: M, y: y - alto }, end: { x: W - M, y: y - alto }, thickness: 0.5, color: LINEA });
    const yt = y - 11.5;
    centro(String(i + 1), xs[0] + cols[0] / 2, yt, { s: 7.6 });
    centro(it.codigo ?? '', xs[1] + cols[1] / 2, yt, { s: 7.6 });
    desc.forEach((l, k) => texto(l, xs[2] + 4, yt - k * 9.4, { s: 7.6 }));
    const bruto = Number(it.cantidad) * Number(it.valor_unitario);
    const rete = Number(it.base ?? it.total_linea) * retePct / 100;
    [Number(it.cantidad).toFixed(2), dinero(it.valor_unitario), dinero(bruto), dinero(it.iva_valor), dinero(rete), dinero(Number(it.total_linea) + Number(it.iva_valor || 0) - rete)]
      .forEach((v, k) => derecha(v, xs[4 + k] - 4, yt, { s: 7.6 }));
    y -= alto;
  });
  // Cierre de la tabla. Si no queda sitio para los totales y los datos fiscales, van en hoja aparte.
  p.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.7, color: LINEA });
  if (y < 300) y = nuevaPagina(false, false);

  // ── Totales (derecha) y condiciones (izquierda)
  const t = doc.totales ?? doc;
  const lineasTot = [
    ['Total bruto', t.total_bruto],
    ['Descuentos', t.total_descuento],
    ['Subtotal', t.subtotal],
    ...(Number(t.total_iva) ? [['IVA', t.total_iva]] : []),
    ...(doc.retenciones ?? []).map((r) => [`${r.tipo === 'RETEFUENTE' ? 'Retefuente' : r.tipo === 'RETEICA' ? 'ReteICA' : r.tipo === 'RETEIVA' ? 'ReteIVA' : r.codigo} ${Number(r.tarifa)}%`, r.valor]),
  ];
  const yBloque = Math.min(y - 18, 250);
  const xT = W - M - 196;
  let yt = yBloque;
  lineasTot.forEach(([k, v]) => {
    caja(xT, yt - 16, 196, 16);
    texto(k, xT + 8, yt - 11, { f: b, s: 7.6, c: AZUL });
    derecha(dinero(v), W - M - 8, yt - 11, { s: 8 });
    yt -= 16;
  });
  p.drawRectangle({ x: xT, y: yt - 22, width: 196, height: 22, color: AZUL });
  texto('TOTAL A PAGAR', xT + 8, yt - 14.5, { f: b, s: 8.4, c: BLANCO });
  derecha(`$ ${dinero(t.total_a_pagar)}`, W - M - 8, yt - 15, { f: b, s: 10.5, c: BLANCO });

  const wIzq = ANCHO - 196 - 18;
  let yi = yBloque - 8;
  const seccion = (titulo, cuerpo) => {
    texto(titulo, M, yi, { f: b, s: 7.8, c: AZUL });
    yi -= 10.5;
    renglones(cuerpo, n, 7.6, wIzq).forEach((l) => { texto(l, M + 4, yi, { s: 7.6 }); yi -= 9.4; });
    yi -= 5;
  };
  texto(`Total ítems: ${filas.length}`, M, yi, { f: b, s: 7.8, c: AZUL });
  yi -= 15;
  seccion('Valor en letras', valorEnLetras(t.total_a_pagar));
  seccion('Forma de pago', doc.forma_pago_nombre || '-');
  seccion('Medio de pago', `${doc.medio_pago_nombre || '-'} · vence el ${fechaCO(doc.fecha_vencimiento)} · $ ${dinero(t.total_a_pagar)}`);
  if (doc.observaciones) seccion('Observaciones', doc.observaciones);

  // ── Datos fiscales: CUFE y resolución
  const yFis = 112;
  p.drawRectangle({ x: M, y: yFis - 56, width: ANCHO, height: 56, color: TENUE });
  p.drawRectangle({ x: M, y: yFis - 56, width: 3, height: 56, color: AZUL });
  texto('CUFE', M + 10, yFis - 13, { f: b, s: 7.2, c: AZUL });
  renglones(String(doc.cufe ?? '').replace(/(.{48})/g, '$1 '), n, 6.8, ANCHO - 60).forEach((l, i) => texto(l, M + 40, yFis - 13 - i * 8.4, { s: 6.8 }));
  const res = resolucion?.numero_resolucion
    ? `Resolución DIAN ${resolucion.numero_resolucion}${resolucion.fecha_desde ? ` del ${fechaCO(resolucion.fecha_desde)}` : ''} · `
      + `numeración autorizada ${resolucion.prefijo ?? ''} ${resolucion.desde ?? ''} a ${resolucion.hasta ?? ''}`
      + `${resolucion.fecha_hasta ? ` · vigente hasta el ${fechaCO(resolucion.fecha_hasta)}` : ''}`
    : null;
  if (res) texto(res, M + 10, yFis - 36, { s: 7 });
  texto('Factura electrónica de venta validada por la DIAN. Consulte su validez con el código QR. La firma electrónica está en el XML.', M + 10, yFis - 48, { s: 6.6, c: GRIS });

  const paginas = pdf.getPages();
  paginas.forEach((pg, i) => { p = pg; pie(i + 1, paginas.length); });
  return Buffer.from(await pdf.save());
}
