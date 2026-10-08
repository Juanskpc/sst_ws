import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { pool } from '../../config/db.js';
import { badRequest, conflict, notFound } from '../../utils/httpError.js';
import { esAxa, esBolivar } from '../../utils/bolivar.js';
import { storage } from '../../services/storage.service.js';
import { numeroCompleto } from './emision.service.js';

/**
 * 7-oct-2026 (reunión con JD&D) · PAQUETE PARA LA ARL de una factura ya emitida.
 *
 * Es lo que JD&D arma hoy a mano para radicar la factura y que se la paguen. Cada ARL
 * lo pide distinto; los modelos están en `1-cliente-jdd/` («FE 816.zip» de Bolívar y
 * «SOPORTES FE-714.pdf» de AXA):
 *
 *   · BOLÍVAR → un .zip con la carpeta «FE n»:
 *       1.FE-n.pdf                  la factura
 *       2.k.AT031-…-SEC s.pdf       por cada orden, sus soportes unidos en un PDF
 *       3.ACTIVIDADES REALIZADAS.pdf  la relación (actividad, n.º de prefactura, valor)
 *       4.PAZ Y SALVO.pdf           la carta de paz y salvo de seguridad social
 *   · AXA → un solo PDF («SOPORTES FE-n.pdf») que repite por cada orden: la orden de
 *     servicio original de AXA y los soportes del profesional.
 *   · COLMENA → pendiente: JD&D todavía no definió cómo lo entrega.
 *
 * El «3» y el «4» de Bolívar se generan sobre el membrete de JD&D
 * (`assets/paquete-arl/`). La firma del representante NO viaja por git: si el archivo
 * está en el servidor se estampa; si no, el paz y salvo sale con el espacio para firmar.
 *
 * ⚠️ En el modelo de AXA cada orden lleva además el correo «Caso aprobado» de la ARL.
 * Ese correo no está en ORBITA (llega al buzón de JD&D): mientras no haya dónde
 * cargarlo, el PDF sale sin él y la pantalla lo avisa.
 */

const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../assets/paquete-arl');
const asset = (nombre) => {
  const ruta = path.join(ASSETS, nombre);
  // Copia propia: pdf-lib lee `buffer` desde el byte 0 y los archivos chicos llegan dentro del pool de Node.
  return fs.existsSync(ruta) ? new Uint8Array(fs.readFileSync(ruta)) : null;
};

/** Quién firma y qué dice el pie del membrete. Lo que cambie se cambia aquí. */
const EMPRESA = {
  nombre: 'JD&D CONSULTORES EN SISTEMAS DE GESTION SAS',
  nombreCorto: 'JDYD CONSULTORES',
  razonEnCarta: 'JDYD CONSULTORES SAS',
  nit: '901.203.812-4',
  ciudadCarta: 'San Juan de Pasto',
  representante: 'José Luis Guacas Zambrano',
  cedula: '1.085.290.060',
  cedulaExpedida: 'Pasto',
  correo: 'asesoría.jddconsultores@gmail.com',
  telefonos: '3046401209-3144768516 - 3182901821',
};

const A4 = [595.22, 842];
const AZUL = rgb(0.06, 0.09, 0.55);
const NEGRO = rgb(0, 0, 0);
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const ORDEN_CASILLAS = ['acta', 'asistencia', 'informe', 'evidencias'];

const pesos = (v) => `$${Math.round(Number(v) || 0).toLocaleString('es-CO')}`;
/** Texto apto para un nombre de archivo dentro del zip (sin tildes raras ni separadores). */
const paraArchivo = (t, max = 60) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^A-Za-z0-9 ._-]+/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, max).trim();
/** Las fuentes estándar de PDF solo saben WinAnsi: lo que no cabe se cambia por «?» en vez de romper el PDF. */
const winAnsi = (t) => String(t ?? '').replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF‘’“”–—…•€]/g, '?');

function hoyColombia() {
  const d = new Date(Date.now() - 5 * 3600 * 1000);
  return { dia: d.getUTCDate(), mes: MESES[d.getUTCMonth()], anio: d.getUTCFullYear() };
}

/** Parte un texto en renglones que quepan en `ancho` puntos. */
function renglones(texto, fuente, tam, ancho) {
  const salida = [];
  for (const parrafo of String(texto).split('\n')) {
    let linea = '';
    for (const palabra of parrafo.split(/\s+/).filter(Boolean)) {
      const prueba = linea ? `${linea} ${palabra}` : palabra;
      if (fuente.widthOfTextAtSize(prueba, tam) <= ancho || !linea) linea = prueba;
      else { salida.push(linea); linea = palabra; }
    }
    salida.push(linea);
  }
  return salida;
}

/** Una hoja A4 con el membrete de JD&D: logo, razón social, marca de agua y pie. */
async function hojaMembretada(doc, recursos, separadorNit = ' : ') {
  const { negrita, encabezado, fondo } = recursos;
  const p = doc.addPage(A4);
  const [w, h] = A4;
  if (fondo) p.drawImage(fondo, { x: w - 300, y: 46, width: 300, height: 300 * (fondo.height / fondo.width) });
  if (encabezado) p.drawImage(encabezado, { x: 0, y: h - 110, width: 236, height: 236 * (encabezado.height / encabezado.width) });
  const centro = 372;
  const titulo = (t, y) => p.drawText(winAnsi(t), { x: centro - negrita.widthOfTextAtSize(t, 11.5) / 2, y, size: 11.5, font: negrita, color: AZUL });
  titulo('JD&D CONSULTORES EN SISTEMAS DE GESTION', h - 82);
  titulo('SAS', h - 96);
  titulo(`NIT${separadorNit}${EMPRESA.nit}`, h - 110);
  p.drawText(winAnsi(`${EMPRESA.correo} Teléfono: ${EMPRESA.telefonos}`), { x: 83, y: 108, size: 10.5, font: negrita, color: AZUL, maxWidth: 420, lineHeight: 13 });
  return p;
}

async function recursosPdf(doc) {
  const [normal, negrita] = await Promise.all([doc.embedFont(StandardFonts.Helvetica), doc.embedFont(StandardFonts.HelveticaBold)]);
  const enc = asset('membrete-encabezado.jpg');
  const fon = asset('membrete-fondo.jpg');
  const fir = asset('firma-representante.jpg');
  return {
    normal, negrita,
    encabezado: enc ? await doc.embedJpg(enc) : null,
    fondo: fon ? await doc.embedJpg(fon) : null,
    firma: fir ? await doc.embedJpg(fir) : null,
  };
}

/** «3.ACTIVIDADES REALIZADAS»: actividad, n.º de prefactura («estado de facturación») y valor de cada orden. */
export async function pdfActividades(ordenes) {
  const doc = await PDFDocument.create();
  const r = await recursosPdf(doc);
  const [w, h] = A4;
  const x0 = 41;
  const anchos = [381, 68, 69]; // actividad · estado de facturación · total
  const xs = [x0, x0 + anchos[0], x0 + anchos[0] + anchos[1], x0 + anchos[0] + anchos[1] + anchos[2]];
  const gris = rgb(0.82, 0.82, 0.82);
  let p = null;
  let y = 0;

  const celda = (texto, col, yBase, { fuente = r.normal, tam = 10, alinear = 'izq' } = {}) => {
    const t = winAnsi(texto);
    const ancho = fuente.widthOfTextAtSize(t, tam);
    const x = alinear === 'der' ? xs[col + 1] - 3 - ancho : alinear === 'centro' ? xs[col] + (anchos[col] - ancho) / 2 : xs[col] + 3;
    p.drawText(t, { x, y: yBase, size: tam, font: fuente, color: NEGRO });
  };
  const caja = (yArriba, alto, relleno = null) => {
    if (relleno) p.drawRectangle({ x: xs[0], y: yArriba - alto, width: xs[3] - xs[0], height: alto, color: relleno });
    p.drawRectangle({ x: xs[0], y: yArriba - alto, width: xs[3] - xs[0], height: alto, borderColor: NEGRO, borderWidth: 0.7 });
  };
  const verticales = (yArriba, alto) => {
    for (const x of [xs[1], xs[2]]) p.drawLine({ start: { x, y: yArriba }, end: { x, y: yArriba - alto }, thickness: 0.7, color: NEGRO });
  };
  const cabecera = async () => {
    p = await hojaMembretada(doc, r);
    y = h - 165;
    caja(y, 15, gris);
    const t = 'ACTIVIDADES';
    p.drawText(t, { x: (xs[0] + xs[3]) / 2 - r.negrita.widthOfTextAtSize(t, 10.5) / 2, y: y - 11, size: 10.5, font: r.negrita });
    y -= 15;
    caja(y, 28, gris);
    verticales(y, 28);
    celda('Actividad a realizar', 0, y - 23, { fuente: r.negrita, tam: 10, alinear: 'centro' });
    celda('Estado de', 1, y - 11, { fuente: r.negrita, tam: 10, alinear: 'centro' });
    celda('facturación', 1, y - 23, { fuente: r.negrita, tam: 10, alinear: 'centro' });
    celda('Total', 2, y - 17, { fuente: r.negrita, tam: 10, alinear: 'centro' });
    y -= 28;
  };

  await cabecera();
  for (const o of ordenes) {
    const lineas = renglones(winAnsi(o.actividad || o.codigo), r.normal, 10, anchos[0] - 6);
    const alto = Math.max(15, lineas.length * 12 + 3);
    if (y - alto < 150) await cabecera();
    caja(y, alto);
    verticales(y, alto);
    lineas.forEach((l, i) => celda(l, 0, y - 11 - i * 12));
    celda(o.numero_prefactura || '', 1, y - alto + 4, { alinear: 'centro' });
    celda(pesos(o.valor), 2, y - alto + 4, { alinear: 'der' });
    y -= alto;
  }
  return Buffer.from(await doc.save());
}

/** «4.PAZ Y SALVO»: la carta de seguridad social, con la fecha de hoy. */
export async function pdfPazYSalvo() {
  const doc = await PDFDocument.create();
  const r = await recursosPdf(doc);
  const p = await hojaMembretada(doc, r, ' – ');
  const h = A4[1];
  const x = 83;
  const f = hoyColombia();
  const negrita = (t, y, tam = 11.5) => p.drawText(winAnsi(t), { x, y, size: tam, font: r.negrita, color: NEGRO });
  negrita(`${EMPRESA.ciudadCarta}, ${f.dia} de ${f.mes} de ${f.anio}.`, h - 157);
  negrita('Señores:', h - 224);
  negrita('Cordial saludo,', h - 290);
  const parrafo = (texto, y) => {
    const ls = renglones(winAnsi(texto), r.normal, 10.5, 429);
    ls.forEach((l, i) => p.drawText(l, { x, y: y - i * 16, size: 10.5, font: r.normal, color: NEGRO }));
    return y - ls.length * 16;
  };
  let y = parrafo(
    `Yo, ${EMPRESA.representante}, identificado con cédula de ciudadanía No ${EMPRESA.cedula} expedida en ${EMPRESA.cedulaExpedida}, `
    + `en calidad de Representante Legal de ${EMPRESA.razonEnCarta}, identificada con NIT ${EMPRESA.nit}, informó que a la fecha nos `
    + 'encontramos al dia con el pago de seguridad social.', h - 332);
  y = parrafo(
    'Certifico además que A LA FECHA no hay saldos a mi cargo derivados de los aportes parafiscales y seguridad social a que '
    + 'estoy obligado de conformidad con las normas vigentes.', y - 22);
  // La firma solo se estampa si el archivo está en el servidor (no viaja por git).
  if (r.firma) p.drawImage(r.firma, { x: 83, y: y - 120, width: 76, height: 76 * (r.firma.height / r.firma.width) });
  negrita('Representante Legal', y - 150);
  negrita(EMPRESA.nombreCorto, y - 172);
  negrita(`NIT: ${EMPRESA.nit.replace(/\./g, '')}`, y - 194);
  return Buffer.from(await doc.save());
}

const CARTA = [612, 792];
/** Suma un archivo (PDF o foto) al PDF de salida. Misma regla que «unir soportes» de Órdenes. */
async function agregarAlPdf(salida, buffer, mime, nombre) {
  const tipo = String(mime || '').toLowerCase();
  const esPdf = tipo === 'application/pdf' || buffer.subarray(0, 4).toString() === '%PDF';
  try {
    if (esPdf) {
      const origen = await PDFDocument.load(buffer, { ignoreEncryption: true });
      (await salida.copyPages(origen, origen.getPageIndices())).forEach((pg) => salida.addPage(pg));
      return true;
    }
    if (tipo === 'image/jpeg' || tipo === 'image/png') {
      const img = tipo === 'image/png' ? await salida.embedPng(buffer) : await salida.embedJpg(buffer);
      const horizontal = img.width > img.height;
      const [ancho, alto] = horizontal ? [CARTA[1], CARTA[0]] : CARTA;
      const escala = Math.min((ancho - 48) / img.width, (alto - 48) / img.height, 1);
      const pg = salida.addPage([ancho, alto]);
      pg.drawImage(img, { x: (ancho - img.width * escala) / 2, y: (alto - img.height * escala) / 2, width: img.width * escala, height: img.height * escala });
      return true;
    }
  } catch {
    throw badRequest(`No se pudo leer «${nombre}» para armar el paquete: el archivo parece dañado.`);
  }
  return false; // Word, Excel…: no se puede unir a un PDF
}

/** La factura, su ARL y sus órdenes con lo que el paquete necesita de cada una. */
async function cargar(documentoId, db = pool) {
  const f = (await db.query(
    `SELECT d.id, d.tipo, d.estado, d.prefijo, d.numero, d.pdf_path, d.tercero_id,
            COALESCE(t.razon_social, btrim(concat_ws(' ', t.nombres, t.apellidos))) AS pagador,
            (SELECT a.nombre FROM sst.arls a WHERE a.tercero_id = d.tercero_id ORDER BY a.nombre LIMIT 1) AS arl
       FROM sst.documentos_electronicos d JOIN sst.terceros t ON t.id = d.tercero_id
      WHERE d.id = $1 AND d.tipo = 'FACTURA'`,
    [documentoId],
  )).rows[0];
  if (!f) throw notFound('Esa factura no existe.');
  const ordenes = (await db.query(
    `SELECT o.id, o.codigo, o.empresa_nombre, o.secuencia, o.codigo_cronograma, o.numero_orden, o.numero_prefactura,
            COALESCE(NULLIF(btrim(o.tema_actividad), ''), o.descripcion) AS actividad, o.tipo_actividad,
            o.url_archivo_original,
            (SELECT COALESCE(sum(i.total_linea), 0) FROM sst.documento_items i WHERE i.documento_id = $1 AND i.orden_id = o.id) AS valor,
            (SELECT count(*)::int FROM sst.archivos_soporte s WHERE s.orden_id = o.id) AS soportes
       FROM sst.documento_ordenes dor JOIN sst.ordenes_servicio o ON o.id = dor.orden_id
      WHERE dor.documento_id = $1
      ORDER BY o.codigo_cronograma NULLS LAST, o.secuencia NULLS LAST, o.codigo`,
    [documentoId],
  )).rows;
  const formato = esBolivar(f.arl) ? 'ZIP' : esAxa(f.arl) ? 'PDF' : null;
  return { factura: f, ordenes, formato, numero: numeroCompleto(f.prefijo, f.numero) };
}

/** Qué se puede armar para esta factura: formato, órdenes y lo que le falta a cada una. */
export async function infoPaquete(documentoId) {
  const { factura, ordenes, formato, numero } = await cargar(documentoId);
  return {
    numero,
    estado: factura.estado,
    pagador: factura.pagador,
    arl: factura.arl,
    formato,
    motivo: formato ? null : (factura.arl
      ? `Todavía no está definido cómo se entrega el paquete a ${factura.arl}.`
      : 'El paquete solo aplica a facturas de una ARL.'),
    tiene_factura_pdf: Boolean(factura.pdf_path),
    firma_disponible: Boolean(asset('firma-representante.jpg')),
    ordenes: ordenes.map((o) => ({
      id: o.id, codigo: o.codigo, empresa: o.empresa_nombre, secuencia: o.secuencia, actividad: o.actividad,
      valor: o.valor, soportes: o.soportes, tiene_original: Boolean(o.url_archivo_original),
    })),
  };
}

async function soportesDe(ordenId, db = pool) {
  const r = await db.query(
    `SELECT url_archivo, mime, COALESCE(nombre_archivo, nombre_original, 'soporte') AS nombre, categoria
       FROM sst.archivos_soporte WHERE orden_id = $1 ORDER BY subido_en`, [ordenId],
  );
  const peso = (c) => { const i = ORDEN_CASILLAS.indexOf(String(c ?? '').toLowerCase()); return i < 0 ? ORDEN_CASILLAS.length : i; };
  return r.rows.sort((a, b) => peso(a.categoria) - peso(b.categoria));
}

/**
 * Arma el paquete. `ordenIds` (opcional) lo limita a algunas órdenes de la factura.
 * Devuelve { nombre, mime, buffer, avisos }.
 */
export async function generarPaquete(documentoId, { ordenIds = null } = {}) {
  const { factura, ordenes: todas, formato, numero } = await cargar(documentoId);
  if (!['VALIDADO', 'ANULADO'].includes(factura.estado)) throw conflict('El paquete se arma cuando la factura ya está validada ante la DIAN.');
  if (!formato) {
    throw badRequest(factura.arl ? `Todavía no está definido cómo se entrega el paquete a ${factura.arl}.` : 'El paquete solo aplica a facturas de una ARL.');
  }
  const ordenes = ordenIds?.length ? todas.filter((o) => ordenIds.includes(o.id)) : todas;
  if (!ordenes.length) throw badRequest('Elija al menos una orden de la factura.');
  // «FE 816» en la carpeta y en los nombres, como en el modelo: prefijo y número separados.
  const soloNumero = String(factura.numero ?? '').replace(new RegExp(`^${factura.prefijo ?? ''}`), '') || numero;
  const etiqueta = `${factura.prefijo ?? 'FE'} ${soloNumero}`;
  const avisos = [];

  if (formato === 'PDF') {
    // AXA: un solo PDF; por cada orden, su orden de servicio original y sus soportes.
    const salida = await PDFDocument.create();
    for (const o of ordenes) {
      if (o.url_archivo_original) {
        const buf = await storage.get(o.url_archivo_original).catch(() => null);
        if (!buf || !(await agregarAlPdf(salida, buf, 'application/pdf', `orden ${o.codigo}`).catch(() => false))) {
          avisos.push(`${o.codigo}: no se pudo incluir la orden de servicio original.`);
        }
      } else {
        avisos.push(`${o.codigo}: no tiene guardada la orden de servicio original.`);
      }
      const sop = await soportesDe(o.id);
      if (!sop.length) avisos.push(`${o.codigo}: no tiene soportes cargados.`);
      for (const s of sop) {
        const buf = await storage.get(s.url_archivo).catch(() => null);
        if (!buf) { avisos.push(`${o.codigo}: el soporte «${s.nombre}» ya no está en el almacenamiento.`); continue; }
        if (!(await agregarAlPdf(salida, buf, s.mime, s.nombre))) avisos.push(`${o.codigo}: «${s.nombre}» no es PDF ni imagen y no se incluyó.`);
      }
    }
    if (!salida.getPageCount()) throw badRequest('Ninguna de las órdenes tiene documentos para armar el paquete.');
    return { nombre: `SOPORTES ${factura.prefijo ?? 'FE'}-${soloNumero}.pdf`, mime: 'application/pdf', buffer: Buffer.from(await salida.save()), avisos };
  }

  // Bolívar: el .zip con la factura, un PDF por orden, la relación y el paz y salvo.
  const zip = new JSZip();
  const carpeta = zip.folder(etiqueta);
  if (factura.pdf_path) {
    const pdf = await storage.get(factura.pdf_path).catch(() => null);
    if (pdf) carpeta.file(`1.${factura.prefijo ?? 'FE'}-${soloNumero}.pdf`, pdf);
    else avisos.push('No se encontró el PDF de la factura en el almacenamiento.');
  } else {
    avisos.push('La factura todavía no tiene su PDF guardado.');
  }
  let k = 0;
  for (const o of ordenes) {
    k += 1;
    const sop = await soportesDe(o.id);
    if (!sop.length) { avisos.push(`${o.codigo}: no tiene soportes cargados; no lleva archivo «2.${k}».`); continue; }
    const salida = await PDFDocument.create();
    for (const s of sop) {
      const buf = await storage.get(s.url_archivo).catch(() => null);
      if (!buf) { avisos.push(`${o.codigo}: el soporte «${s.nombre}» ya no está en el almacenamiento.`); continue; }
      if (!(await agregarAlPdf(salida, buf, s.mime, s.nombre))) avisos.push(`${o.codigo}: «${s.nombre}» no es PDF ni imagen y no se incluyó.`);
    }
    if (!salida.getPageCount()) continue;
    const partes = ['AT031', paraArchivo(String(o.actividad ?? '').split(/[.(]/)[0], 55), paraArchivo(o.empresa_nombre, 35)].filter(Boolean).join('-');
    carpeta.file(`2.${k}.${partes}${o.secuencia ? ` SEC ${paraArchivo(o.secuencia, 12)}` : ''}.pdf`, Buffer.from(await salida.save()));
  }
  carpeta.file('3.ACTIVIDADES REALIZADAS.pdf', await pdfActividades(ordenes));
  carpeta.file('4.PAZ Y SALVO.pdf', await pdfPazYSalvo());
  if (!asset('firma-representante.jpg')) avisos.push('El paz y salvo sale sin firma: el archivo de la firma no está en el servidor.');
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { nombre: `${etiqueta}.zip`, mime: 'application/zip', buffer, avisos };
}
