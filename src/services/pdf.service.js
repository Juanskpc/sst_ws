import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/**
 * Genera un PDF de formato auto-diligenciado (M4 / FOR) a partir de la OS.
 * Deja espacios en blanco para firmas físicas del profesional y del cliente.
 * Devuelve un Buffer.
 */
export async function generateFormatoPdf({ template, order, professional }) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]); // A4
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const primary = rgb(0, 0.043, 0.314); // #000b50
  const gray = rgb(0.35, 0.35, 0.35);

  let y = 800;
  const line = (text, { size = 11, f = font, color = rgb(0, 0, 0), x = 50, gap = 20 } = {}) => {
    page.drawText(String(text ?? ''), { x, y, size, font: f, color });
    y -= gap;
  };

  // Encabezado
  page.drawRectangle({ x: 0, y: 812, width: 595, height: 30, color: primary });
  page.drawText('JD&D Consultores en Sistemas de Gestión', { x: 50, y: 820, size: 12, font: bold, color: rgb(1, 1, 1) });

  y = 780;
  line(template?.nombre || 'Formato de Gestión', { size: 16, f: bold, color: primary, gap: 28 });
  line(`ARL: ${order.arl_nombre || ''}    ·    OS: ${order.codigo || order.id}`, { color: gray, gap: 26 });

  const rows = [
    ['Empresa', order.empresa_nombre],
    ['NIT / NIC', order.nit_nic],
    ['Actividad económica', order.actividad_economica],
    ['Cronograma / Secuencia', `${order.codigo_cronograma || ''} / ${order.secuencia || ''}`],
    ['Horas asignadas', order.horas_asignadas],
    ['Contacto SST', order.contacto_sst_nombre],
    ['Teléfono contacto', order.contacto_sst_telefono],
    ['Correo contacto', order.contacto_sst_correo],
    ['Profesional asignado', professional?.nombre || '—'],
    ['Fecha programada', order.fecha_programada ? new Date(order.fecha_programada).toLocaleString('es-CO') : '—'],
  ];
  for (const [label, value] of rows) {
    line(`${label}:`, { f: bold, size: 11, gap: 4 });
    line(value || '—', { size: 11, x: 60, gap: 22 });
  }

  y -= 6;
  line('Descripción de la actividad:', { f: bold, gap: 16 });
  const desc = String(order.descripcion || '—');
  for (let i = 0; i < desc.length; i += 90) line(desc.slice(i, i + 90), { size: 10, x: 60, gap: 14 });

  // Firmas físicas
  y = 140;
  page.drawLine({ start: { x: 60, y }, end: { x: 260, y }, thickness: 1, color: gray });
  page.drawLine({ start: { x: 330, y }, end: { x: 530, y }, thickness: 1, color: gray });
  page.drawText('Firma del profesional', { x: 90, y: y - 15, size: 9, font, color: gray });
  page.drawText('Firma del cliente / contacto SST', { x: 350, y: y - 15, size: 9, font, color: gray });

  const bytes = await doc.save();
  return Buffer.from(bytes);
}
