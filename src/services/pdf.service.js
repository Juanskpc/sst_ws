import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { fechaHoraCO, horasTexto } from '../utils/formato.js';

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

  // CFG-03 · Encabezado editable desde Configuración → Formatos. Se corta a mano
  // porque pdf-lib no ajusta texto solo; 95 caracteres es lo que entra a 10 pt.
  const parrafo = (texto, { size = 10, ancho = 95, color = gray, gap = 13 } = {}) => {
    for (const trozo of String(texto).split('\n')) {
      if (!trozo.trim()) { y -= gap; continue; }
      for (let i = 0; i < trozo.length; i += ancho) {
        line(trozo.slice(i, i + ancho), { size, x: 50, color, gap });
      }
    }
  };
  if (template?.encabezado) {
    parrafo(template.encabezado);
    y -= 10;
  }

  const rows = [
    ['Empresa', order.empresa_nombre],
    ['NIT / NIC', order.nit_nic],
    ['Actividad económica', order.actividad_economica],
    ['Cronograma / Secuencia', `${order.codigo_cronograma || ''} / ${order.secuencia || ''}`],
    ['Horas asignadas', horasTexto(order.horas_asignadas)],
    ['Contacto SST', order.contacto_sst_nombre],
    ['Teléfono contacto', order.contacto_sst_telefono],
    ['Correo contacto', order.contacto_sst_correo],
    ['Profesional asignado', professional?.nombre || '—'],
    // Con la zona explícita: `toLocaleString` a secas usa la del proceso, así
    // que un servidor en UTC imprimía en el acta una hora corrida cinco horas.
    ['Fecha programada', order.fecha_programada ? fechaHoraCO(order.fecha_programada) : '—'],
  ];
  for (const [label, value] of rows) {
    line(`${label}:`, { f: bold, size: 11, gap: 4 });
    line(value || '—', { size: 11, x: 60, gap: 22 });
  }

  y -= 6;
  line('Descripción de la actividad:', { f: bold, gap: 16 });
  const desc = String(order.descripcion || '—');
  for (let i = 0; i < desc.length; i += 90) line(desc.slice(i, i + 90), { size: 10, x: 60, gap: 14 });

  // CFG-03 · Nota al pie editable (compromisos, aviso legal…), justo encima de
  // las firmas, que es donde el cliente la lee antes de firmar.
  if (template?.nota_pie) {
    y = 190;
    parrafo(template.nota_pie, { size: 9, ancho: 105, gap: 11 });
  }

  // Firmas físicas
  y = 140;
  page.drawLine({ start: { x: 60, y }, end: { x: 260, y }, thickness: 1, color: gray });
  page.drawLine({ start: { x: 330, y }, end: { x: 530, y }, thickness: 1, color: gray });
  page.drawText('Firma del profesional', { x: 90, y: y - 15, size: 9, font, color: gray });
  page.drawText('Firma del cliente / contacto SST', { x: 350, y: y - 15, size: 9, font, color: gray });

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

/**
 * Estado de una cuenta de cobro tal como se escribe de cara a una persona.
 * En la BD son minúsculas ('aceptada'); imprimirlas así deja el documento con
 * un "Estado: aceptada" que parece a medio escribir.
 */
function etiquetaEstado(estado) {
  const t = String(estado ?? '').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : '—';
}

/**
 * PRE-03 · Documento de la cuenta de cobro: profesional, mes, detalle de
 * órdenes (fecha, empresa, ARL, horas, valor) y totales.
 *
 * Se pagina sola: un mes cargado puede pasar de 25 órdenes y en una sola página
 * el detalle se saldría del pie. Devuelve un Buffer.
 */
export async function generatePrecuentaPdf(precuenta) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const primary = rgb(0, 0.043, 0.314); // #000b50
  const gray = rgb(0.35, 0.35, 0.35);
  const suave = rgb(0.97, 0.98, 0.99);

  const pesos = (v) =>
    '$ ' + new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(Number(v) || 0);
  const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const [anio, mes] = String(precuenta.periodo || '').split('-').map(Number);
  // De la segunda cuenta del mes en adelante se dice en el propio documento:
  // el profesional recibe dos PDF del mismo mes y sin esto parecerían el mismo.
  const complemento = Number(precuenta.numero) > 1 ? ' · complementaria' : '';
  const periodoLargo = `${meses[(mes || 1) - 1]} de ${anio}${complemento}`;

  // Columnas del detalle: x de inicio y ancho útil para recortar el texto.
  const COLS = [
    { titulo: 'Fecha', x: 45, ancho: 55 },
    { titulo: 'Orden', x: 100, ancho: 72 },
    { titulo: 'Empresa', x: 172, ancho: 150 },
    { titulo: 'ARL', x: 322, ancho: 70 },
    { titulo: 'Horas', x: 400, ancho: 35 },
    { titulo: 'Valor hora', x: 440, ancho: 60 },
    { titulo: 'Subtotal', x: 505, ancho: 60 },
  ];

  let page, y;
  const recortar = (texto, ancho, size) => {
    let s = String(texto ?? '');
    while (s.length && font.widthOfTextAtSize(s, size) > ancho) s = s.slice(0, -1);
    return s;
  };

  const nuevaPagina = () => {
    page = doc.addPage([595, 842]);
    page.drawRectangle({ x: 0, y: 812, width: 595, height: 30, color: primary });
    page.drawText('JD&D Consultores en Sistemas de Gestión', {
      x: 45, y: 820, size: 12, font: bold, color: rgb(1, 1, 1),
    });
    y = 780;
  };

  const cabeceraTabla = () => {
    page.drawRectangle({ x: 40, y: y - 4, width: 515, height: 18, color: primary });
    for (const c of COLS) {
      page.drawText(c.titulo, { x: c.x, y, size: 8.5, font: bold, color: rgb(1, 1, 1) });
    }
    y -= 22;
  };

  nuevaPagina();

  page.drawText('Cuenta de cobro', { x: 45, y, size: 17, font: bold, color: primary });
  y -= 24;
  page.drawText(`Periodo: ${periodoLargo}`, { x: 45, y, size: 11, font, color: gray });
  y -= 16;
  page.drawText(`Profesional: ${precuenta.profesional_nombre || ''}`, { x: 45, y, size: 11, font: bold });
  y -= 14;
  if (precuenta.profesional_correo) {
    page.drawText(precuenta.profesional_correo, { x: 45, y, size: 9.5, font, color: gray });
    y -= 14;
  }
  page.drawText(`Generada el ${new Date(precuenta.creado_en || Date.now()).toLocaleDateString('es-CO')}`, {
    x: 45, y, size: 9.5, font, color: gray,
  });
  y -= 26;

  cabeceraTabla();

  const items = precuenta.items || [];
  let fila = 0;
  for (const it of items) {
    // Espacio reservado abajo para los totales y la firma de la última página.
    if (y < 120) {
      nuevaPagina();
      cabeceraTabla();
      fila = 0;
    }
    if (fila % 2 === 1) {
      page.drawRectangle({ x: 40, y: y - 4, width: 515, height: 16, color: suave });
    }
    const fecha = it.fecha_ejecucion ? new Date(it.fecha_ejecucion).toLocaleDateString('es-CO') : '—';
    const valores = [
      fecha, it.orden_codigo || '—', it.empresa_nombre || '—', it.arl_nombre || '—',
      String(Number(it.horas) || 0), pesos(it.valor_hora_snapshot), pesos(it.monto),
    ];
    COLS.forEach((c, i) => {
      page.drawText(recortar(valores[i], c.ancho, 8.5), { x: c.x, y, size: 8.5, font });
    });
    y -= 16;
    fila++;
  }

  if (!items.length) {
    page.drawText('Sin órdenes ejecutadas en el periodo.', { x: 45, y, size: 10, font, color: gray });
    y -= 16;
  }

  // Totales
  y -= 10;
  page.drawLine({ start: { x: 380, y: y + 8 }, end: { x: 565, y: y + 8 }, thickness: 1, color: primary });
  y -= 6;
  page.drawText('Total de horas:', { x: 380, y, size: 10, font: bold });
  page.drawText(String(Number(precuenta.total_horas) || 0), { x: 505, y, size: 10, font });

  // Con viáticos, el total deja de ser horas × tarifa: hay que desglosarlo o la
  // cifra no cuadra con las cuentas del profesional. Van en su propia línea
  // porque no son honorarios — la contadora los trata distinto.
  const viaticos = Number(precuenta.total_viaticos) || 0;
  if (viaticos > 0) {
    y -= 16;
    page.drawText('Honorarios:', { x: 380, y, size: 10, font: bold });
    page.drawText(pesos((Number(precuenta.total_monto) || 0) - viaticos), { x: 480, y, size: 10, font });
    y -= 16;
    // "Viáticos" a secas, como en el correo y en las dos pantallas: el cliente
    // retiró la coletilla "(reembolso)" el 24-ago-2026. Aquí además no cabía —
    // la etiqueta larga pasaba de los 100 pt que hay hasta la columna de cifras.
    page.drawText('Viáticos:', { x: 380, y, size: 10, font: bold });
    page.drawText(pesos(viaticos), { x: 480, y, size: 10, font });
  }

  y -= 18;
  page.drawText('Total a pagar:', { x: 380, y, size: 11, font: bold, color: primary });
  page.drawText(pesos(precuenta.total_monto), { x: 480, y, size: 11, font: bold, color: primary });

  // Estado de la cuenta (PRE-06). Las observaciones NO se imprimen: son notas
  // internas del seguimiento —lo que anotó quien revisó un rechazo— y este
  // documento es el que se le manda al profesional y el que acompaña el pago.
  y -= 34;
  if (precuenta.estado) {
    page.drawText(`Estado: ${etiquetaEstado(precuenta.estado)}`, { x: 45, y, size: 10, font: bold });
    y -= 14;
  }

  const bytes = await doc.save();
  return Buffer.from(bytes);
}
