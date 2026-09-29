import { pool } from '../../config/db.js';
import { badRequest, notFound } from '../../utils/httpError.js';
import { sendEmail } from '../../services/email.service.js';
import { storage } from '../../services/storage.service.js';
import { correoHtml, parrafo, bloqueTotal, tablaDatos, filaDato } from '../../services/email-layout.service.js';
import { enPesosCO } from '../../utils/formato.js';
import { obtenerBorrador } from './borrador.service.js';

/**
 * A1-06 (FEL-16) · Envío de la factura al cliente. Dos canales, a propósito:
 *
 *  - Al EMITIR (A1-05), Factus manda su PROPIO correo (`send_email: true`) al
 *    `correo_facturacion` del tercero — A1-05 ya exige que exista antes de
 *    emitir, así que siempre hay a quién mandarlo.
 *  - "Reenviar al cliente" (este módulo) usa el correo PROPIO de Orbita
 *    (`email.service.js`), con el PDF y el XML adjuntos: para cuando el de
 *    Factus no llegó, hay que mandarlo a otra persona (`correo` opcional, sin
 *    tocar la ficha del tercero), o se prefiere la plantilla de marca de JD&D.
 */
export async function reenviarAlCliente(documentoId, usuarioId, { correo } = {}) {
  const doc = (await pool.query(
    `SELECT d.id, d.tipo, d.estado, d.numero, d.prefijo, d.cufe, d.pdf_path, d.xml_path,
            d.total_a_pagar, to_char(d.fecha_emision, 'YYYY-MM-DD') AS fecha_emision,
            to_char(d.fecha_vencimiento, 'YYYY-MM-DD') AS fecha_vencimiento,
            ter.correo_facturacion,
            COALESCE(ter.razon_social, btrim(concat_ws(' ', ter.nombres, ter.apellidos))) AS tercero_nombre
       FROM sst.documentos_electronicos d JOIN sst.terceros ter ON ter.id = d.tercero_id
      WHERE d.id = $1 AND d.tipo = 'FACTURA'`,
    [documentoId],
  )).rows[0];
  if (!doc) throw notFound('Esa factura no existe.');
  if (doc.estado !== 'VALIDADO') throw badRequest('Solo se puede enviar una factura ya VALIDADA por la DIAN.');
  if (!doc.pdf_path || !doc.xml_path) throw badRequest('Esta factura no tiene el PDF o el XML guardados. Use "Consultar estado" para completarlos y vuelva a intentarlo.');

  const destino = String(correo ?? doc.correo_facturacion ?? '').trim();
  if (!destino) throw badRequest('El tercero no tiene correo de facturación y no se indicó uno alterno.');

  const [pdf, xml] = await Promise.all([storage.get(doc.pdf_path), storage.get(doc.xml_path)]);
  const numeroCompleto = `${doc.prefijo ?? ''}${doc.numero ?? ''}` || doc.reference_code;
  const totalTexto = enPesosCO(doc.total_a_pagar);

  await sendEmail({
    to: destino,
    subject: `Factura electrónica ${numeroCompleto} — JD&D Consultores`,
    // El texto plano queda completo (es lo que se ve en el driver 'console' y
    // lo que lee quien abre en texto plano): mismo criterio que las cuentas de
    // cobro (billing.service.js).
    text:
      `Estimado(a) ${doc.tercero_nombre},\n\n` +
      `Adjuntamos la factura electrónica ${numeroCompleto}, con su representación en PDF y el XML de la DIAN.\n\n` +
      `  · CUFE: ${doc.cufe ?? '—'}\n` +
      `  · Fecha de emisión: ${doc.fecha_emision}\n` +
      `  · Vencimiento: ${doc.fecha_vencimiento}\n` +
      `  · Total a pagar: ${totalTexto}\n\n` +
      `JD&D Consultores en Sistemas de Gestión\n`,
    html: correoHtml({
      titulo: 'Factura electrónica',
      subtitulo: `${numeroCompleto} · ${doc.tercero_nombre}`,
      pie: 'JD&D Consultores · Seguridad y Salud en el Trabajo',
      cuerpo: [
        parrafo(`Estimado(a) ${doc.tercero_nombre},`),
        parrafo('Adjuntamos la factura electrónica, con su representación en PDF y el XML de la DIAN.'),
        bloqueTotal('Total a pagar', totalTexto, `Vence ${doc.fecha_vencimiento}`),
        tablaDatos([
          filaDato('Número', numeroCompleto),
          filaDato('CUFE', doc.cufe),
          filaDato('Fecha de emisión', doc.fecha_emision),
        ]),
      ].join(''),
    }),
    attachments: [
      { filename: `${numeroCompleto}.pdf`, content: pdf },
      { filename: `${numeroCompleto}.xml`, content: xml },
    ],
  });

  await pool.query(
    `INSERT INTO sst.documento_eventos (documento_id, codigo, descripcion, usuario_id)
     VALUES ($1, 'CORREO_ENVIADO', $2, $3)`,
    [documentoId, `Reenviada a ${destino}.`, usuarioId],
  );

  return obtenerBorrador(documentoId);
}
