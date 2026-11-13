import JSZip from 'jszip';
import { numeroCompleto as numeroDeDocumento } from './emision.service.js';
import { pool } from '../../config/db.js';
import { env } from '../../config/env.js';
import { badRequest, notFound } from '../../utils/httpError.js';
import { sendEmail } from '../../services/email.service.js';
import { storage } from '../../services/storage.service.js';
import { correoHtml, parrafo, bloqueTotal, tablaDatos, filaDato } from '../../services/email-layout.service.js';
import { enPesosCO } from '../../utils/formato.js';
import { obtenerBorrador } from './borrador.service.js';
import { pdfDeDocumento, pdfPropioFactura } from './representacion.service.js';
import { proveedorFE } from './index.js';
import { readFile } from 'node:fs/promises';

/** Copia de `public/logoFacturacion.png` del frontend: el backend no ve esa carpeta. */
const LOGO_RUTA = new URL('../../../assets/correo/logoFacturacion.png', import.meta.url);
const LOGO_CID = 'logo-jdd-facturacion';

/** Facturas y notas crédito: los dos documentos que se le mandan al cliente. */
const TIPOS_ENVIABLES = ['FACTURA', 'NOTA_CREDITO'];

/**
 * A1-06 (FEL-16) · Envío de la factura (y, desde el 12-nov-2026, de la nota crédito) al
 * cliente.
 *
 * Hasta el 12-nov-2026 el correo de la emisión lo mandaba el proveedor tecnológico solo
 * (`send_email: true`) con SU PDF, que no imprime las retenciones: la contadora lo vio en la
 * NC93 (la retención sí iba en el XML a la DIAN). Ahora se emite con `send_email: false` y,
 * ya validado, ORBITA manda el CORREO OFICIAL (`enviarTrasValidar`):
 *   · el asunto en el formato de la DIAN y el ZIP con el AttachedDocument, tal como los da el
 *     proveedor (`contenidoCorreo`) — es la entrega formal al adquiriente y lo que leen los
 *     buzones de recepción automática de las ARL (un solo adjunto .zip);
 *   · pero dentro del ZIP va el PDF PROPIO (formato Siigo, con retenciones) en lugar del suyo.
 * Con FACTUS_CORREO_PDF_PROPIO=false todo vuelve al correo automático del proveedor.
 *
 * «Enviar al cliente» (`reenviarAlCliente`) manda ese mismo correo a quien se indique; si el
 * proveedor no da el ZIP, adjunta el PDF y el XML sueltos, como antes.
 */

/**
 * Se llama después de validar (y contabilizar) una factura o nota crédito. Nunca lanza:
 * el documento ya es válido ante la DIAN y un correo que falla no puede deshacer nada.
 * Deja en la línea de tiempo CORREO_ENVIADO o CORREO_FALLIDO (con el motivo).
 */
export async function enviarTrasValidar(documentoId, usuarioId) {
  if (!env.factus.correoConPdfPropio) return; // el proveedor ya lo mandó al emitir (send_email: true)
  try {
    const doc = await documentoParaEnviar(documentoId);
    if (!doc || doc.estado !== 'VALIDADO' || !doc.numero) return;
    const destino = String(doc.correo_facturacion ?? '').trim();
    if (!destino) throw new Error('el tercero no tiene correo de facturación');
    const { oficial } = await enviarCorreo(doc, destino, { exigirOficial: true });
    await registrarEvento(documentoId, 'CORREO_ENVIADO',
      `Enviada a ${destino} con el PDF de ORBITA${oficial.pdfPropio ? '' : ' (no se pudo armar: va el del proveedor)'} y el XML de la DIAN.`, usuarioId);
  } catch (e) {
    console.error(`[facturacion] Correo al cliente de ${documentoId}: ${e.message}`);
    await registrarEvento(documentoId, 'CORREO_FALLIDO',
      `No se pudo enviar al cliente: ${e.message}. Use «Enviar al cliente».`.slice(0, 2000), usuarioId).catch(() => {});
  }
}

export async function reenviarAlCliente(documentoId, usuarioId, { correo } = {}) {
  const doc = await documentoParaEnviar(documentoId);
  if (!doc) throw notFound('Esa factura no existe.');
  const cual = doc.tipo === 'NOTA_CREDITO' ? 'nota crédito' : 'factura';
  if (doc.estado !== 'VALIDADO') throw badRequest(`Solo se puede enviar una ${cual} ya VALIDADA por la DIAN.`);
  if (!doc.pdf_path || !doc.xml_path) throw badRequest(`Esta ${cual} no tiene el PDF o el XML guardados. Use "Consultar estado" para completarlos y vuelva a intentarlo.`);

  const destino = String(correo ?? doc.correo_facturacion ?? '').trim();
  if (!destino) throw badRequest('El tercero no tiene correo de facturación y no se indicó uno alterno.');

  await enviarCorreo(doc, destino, { exigirOficial: false });
  await registrarEvento(documentoId, 'CORREO_ENVIADO', `Reenviada a ${destino}.`, usuarioId);
  return obtenerBorrador(documentoId);
}

async function documentoParaEnviar(documentoId) {
  return (await pool.query(
    `SELECT d.id, d.tipo, d.estado, d.numero, d.prefijo, d.cufe, d.pdf_path, d.xml_path, d.reference_code,
            d.total_a_pagar, to_char(d.fecha_emision, 'YYYY-MM-DD') AS fecha_emision,
            to_char(d.fecha_vencimiento, 'YYYY-MM-DD') AS fecha_vencimiento,
            ref.prefijo AS referencia_prefijo, ref.numero AS referencia_numero,
            ter.correo_facturacion,
            COALESCE(ter.razon_social, btrim(concat_ws(' ', ter.nombres, ter.apellidos))) AS tercero_nombre
       FROM sst.documentos_electronicos d JOIN sst.terceros ter ON ter.id = d.tercero_id
       LEFT JOIN sst.documentos_electronicos ref ON ref.id = d.documento_referencia_id
      WHERE d.id = $1 AND d.tipo = ANY($2)`,
    [documentoId, TIPOS_ENVIABLES],
  )).rows[0];
}

/**
 * El ZIP oficial del proveedor con el PDF propio en lugar del suyo (mismo nombre de archivo,
 * que es el que la DIAN espera). Devuelve null si el proveedor no lo da.
 */
async function correoOficial(doc) {
  let contenido;
  try {
    contenido = await proveedorFE().contenidoCorreo({ tipo: doc.tipo, numeroDocumento: doc.numero });
  } catch (e) {
    console.error(`[facturacion] Contenido del correo oficial de ${doc.numero}: ${e.message}`);
    return null;
  }
  const zip = await JSZip.loadAsync(contenido.zip);
  const nombrePdf = Object.keys(zip.files).find((n) => /\.pdf$/i.test(n));
  const nombreXml = Object.keys(zip.files).find((n) => /\.xml$/i.test(n));
  const pdfPropio = await pdfPropioFactura(doc.id).catch((e) => {
    console.error(`[facturacion] PDF propio de ${doc.numero} para el correo: ${e.message}`);
    return null;
  });
  if (pdfPropio && nombrePdf) zip.file(nombrePdf, pdfPropio);
  const nombreZip = `${(nombreXml || nombrePdf || doc.numero).replace(/\.[^.]+$/, '')}.zip`;
  return {
    asunto: contenido.asunto,
    adjunto: { filename: nombreZip, content: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) },
    pdfPropio: Boolean(pdfPropio),
  };
}

/**
 * Manda el correo al cliente. Con el contenido oficial: su asunto y su ZIP como ÚNICO
 * adjunto (más el logo, que va dentro del cuerpo). Sin él: asunto de JD&D y PDF + XML
 * sueltos — salvo `exigirOficial`, que entonces falla (el envío de la emisión no se manda
 * sin el AttachedDocument).
 */
async function enviarCorreo(doc, destino, { exigirOficial }) {
  const oficial = await correoOficial(doc);
  if (!oficial && exigirOficial) throw new Error('el proveedor tecnológico no entregó el XML de la DIAN para el correo');

  const esNota = doc.tipo === 'NOTA_CREDITO';
  // 7-oct-2026 · Logo de JD&D en la cabecera del correo de la factura. Si el
  // archivo faltara, el correo sale igual con la cabecera de texto.
  const logo = await readFile(LOGO_RUTA).catch(() => null);
  const numeroCompleto = numeroDeDocumento(doc.prefijo, doc.numero) || doc.reference_code;
  const facturaReferida = numeroDeDocumento(doc.referencia_prefijo, doc.referencia_numero);
  const totalTexto = enPesosCO(doc.total_a_pagar);
  const titulo = esNota ? 'Nota crédito electrónica' : 'Factura electrónica';
  const queVa = oficial ? 'su representación en PDF y el XML de la DIAN, en un archivo .zip' : 'su representación en PDF y el XML de la DIAN';
  const presentacion = esNota
    ? `Adjuntamos la nota crédito electrónica ${numeroCompleto}${facturaReferida ? `, que corrige la factura ${facturaReferida}` : ''}, con ${queVa}.`
    : `Adjuntamos la factura electrónica ${numeroCompleto}, con ${queVa}.`;

  let adjuntos;
  if (oficial) {
    adjuntos = [oficial.adjunto];
  } else {
    // 8-oct-2026 · El PDF que se adjunta es el propio de JD&D (mismo formato de su software contable anterior).
    const [pdf, xml] = await Promise.all([pdfDeDocumento(doc.id, doc.pdf_path), storage.get(doc.xml_path)]);
    adjuntos = [
      { filename: `${numeroCompleto}.pdf`, content: pdf },
      { filename: `${numeroCompleto}.xml`, content: xml },
    ];
  }

  await sendEmail({
    to: destino,
    // El asunto oficial («NIT;Emisor;Número;Tipo;…») es el que buscan los buzones de recepción.
    subject: oficial?.asunto ?? `${titulo} ${numeroCompleto} — JD&D Consultores`,
    // El texto plano queda completo (es lo que se ve en el driver 'console' y
    // lo que lee quien abre en texto plano): mismo criterio que las cuentas de
    // cobro (billing.service.js).
    text:
      `Estimado(a) ${doc.tercero_nombre},\n\n` +
      `${presentacion}\n\n` +
      `  · ${esNota ? 'CUDE' : 'CUFE'}: ${doc.cufe ?? '—'}\n` +
      `  · Fecha de emisión: ${doc.fecha_emision}\n` +
      (esNota ? `  · Valor: ${totalTexto}\n\n` : `  · Vencimiento: ${doc.fecha_vencimiento}\n  · Total a pagar: ${totalTexto}\n\n`) +
      `JD&D Consultores en Sistemas de Gestión\n`,
    html: correoHtml({
      titulo,
      subtitulo: `${numeroCompleto} · ${doc.tercero_nombre}`,
      pie: 'JD&D Consultores · Seguridad y Salud en el Trabajo',
      logoCid: logo ? LOGO_CID : null,
      cuerpo: [
        parrafo(`Estimado(a) ${doc.tercero_nombre},`),
        parrafo(presentacion),
        esNota ? bloqueTotal('Valor de la nota', totalTexto) : bloqueTotal('Total a pagar', totalTexto, `Vence ${doc.fecha_vencimiento}`),
        tablaDatos([
          filaDato('Número', numeroCompleto),
          ...(esNota && facturaReferida ? [filaDato('Factura que corrige', facturaReferida)] : []),
          filaDato(esNota ? 'CUDE' : 'CUFE', doc.cufe),
          filaDato('Fecha de emisión', doc.fecha_emision),
        ]),
      ].join(''),
    }),
    attachments: [
      ...adjuntos,
      // El logo va DENTRO del correo (cid) y no como enlace: así se ve sin que el
      // cliente tenga que «mostrar imágenes».
      ...(logo ? [{ filename: 'logo-jdd.png', content: logo, cid: LOGO_CID, contentDisposition: 'inline' }] : []),
    ],
  });
  return { oficial: oficial ?? { pdfPropio: false } };
}

async function registrarEvento(documentoId, codigo, descripcion, usuarioId) {
  await pool.query(
    `INSERT INTO sst.documento_eventos (documento_id, codigo, descripcion, usuario_id) VALUES ($1, $2, $3, $4)`,
    [documentoId, codigo, descripcion, usuarioId],
  );
}
