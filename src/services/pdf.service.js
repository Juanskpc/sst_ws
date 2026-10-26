import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { fechaHoraCO, horasTexto } from '../utils/formato.js';
import { dibujarFirma } from '../utils/firma-pdf.js';

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
  // 16-oct-2026 · La firma digital del profesional, si la tiene, sobre su raya.
  await dibujarFirma(doc, professional?.firma_imagen, [[0, 70, y + 1, 180, 45]]);

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
 * órdenes (fecha, orden, actividad, empresa, ARL, horas, valor hora, viáticos y
 * valor) y totales.
 *
 * 24-oct-2026 · JD&D lo pidió ver completo: las columnas cortaban el nombre de la
 * empresa y no estaban la actividad ni los viáticos de cada línea. Ahora la hoja es
 * horizontal y el texto largo se PARTE en renglones en vez de recortarse con la fila
 * creciendo a su alto. Se pagina sola: un mes cargado puede pasar de 25 órdenes.
 * Devuelve un Buffer.
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

  // Hoja horizontal (A4): 842 × 595. Margen de 40 → 762 útiles.
  const ANCHO = 842;
  const ALTO = 595;
  const IZQ = 40;
  const DER = ANCHO - 40;
  const SIZE = 8.2;
  const INTERLINEA = 10;
  // x de inicio y ancho útil de cada columna (las cifras van alineadas a la derecha).
  const COLS = [
    { titulo: 'Fecha', x: 44, ancho: 50 },
    { titulo: 'Orden', x: 98, ancho: 62 },
    { titulo: 'Actividad', x: 164, ancho: 118 },
    { titulo: 'Empresa', x: 286, ancho: 190 },
    { titulo: 'ARL', x: 480, ancho: 74 },
    { titulo: 'Horas', x: 558, ancho: 34, der: true },
    { titulo: 'Valor hora', x: 596, ancho: 64, der: true },
    { titulo: 'Viáticos', x: 664, ancho: 62, der: true },
    { titulo: 'Valor', x: 730, ancho: 68, der: true },
  ];

  let page, y;

  /** Parte el texto en renglones que quepan en `ancho` (por palabras; una palabra más larga se corta). */
  const partir = (texto, ancho) => {
    const palabras = String(texto ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    const lineas = [];
    let actual = '';
    for (let w of palabras) {
      while (font.widthOfTextAtSize(w, SIZE) > ancho) {
        let corte = w.length - 1;
        while (corte > 1 && font.widthOfTextAtSize(w.slice(0, corte), SIZE) > ancho) corte--;
        if (actual) { lineas.push(actual); actual = ''; }
        lineas.push(w.slice(0, corte));
        w = w.slice(corte);
      }
      const prueba = actual ? `${actual} ${w}` : w;
      if (actual && font.widthOfTextAtSize(prueba, SIZE) > ancho) { lineas.push(actual); actual = w; } else { actual = prueba; }
    }
    if (actual) lineas.push(actual);
    return lineas.length ? lineas : ['—'];
  };

  const nuevaPagina = () => {
    page = doc.addPage([ANCHO, ALTO]);
    page.drawRectangle({ x: 0, y: ALTO - 30, width: ANCHO, height: 30, color: primary });
    page.drawText('JD&D Consultores en Sistemas de Gestión', {
      x: IZQ + 4, y: ALTO - 21, size: 12, font: bold, color: rgb(1, 1, 1),
    });
    y = ALTO - 64;
  };

  const cabeceraTabla = () => {
    page.drawRectangle({ x: IZQ, y: y - 5, width: DER - IZQ, height: 18, color: primary });
    for (const c of COLS) {
      const x = c.der ? c.x + c.ancho - bold.widthOfTextAtSize(c.titulo, SIZE) : c.x;
      page.drawText(c.titulo, { x, y, size: SIZE, font: bold, color: rgb(1, 1, 1) });
    }
    y -= 22;
  };

  nuevaPagina();

  page.drawText('Cuenta de cobro', { x: 44, y, size: 17, font: bold, color: primary });
  y -= 22;
  page.drawText(`Periodo: ${periodoLargo}`, { x: 44, y, size: 11, font, color: gray });
  page.drawText(`Profesional: ${precuenta.profesional_nombre || ''}`, { x: 300, y, size: 11, font: bold });
  y -= 15;
  page.drawText(`Generada el ${new Date(precuenta.creado_en || Date.now()).toLocaleDateString('es-CO')}`, {
    x: 44, y, size: 9.5, font, color: gray,
  });
  if (precuenta.profesional_correo) {
    page.drawText(precuenta.profesional_correo, { x: 300, y, size: 9.5, font, color: gray });
  }
  y -= 26;

  cabeceraTabla();

  const items = precuenta.items || [];
  let fila = 0;
  for (const it of items) {
    // La fecha del día de ejecución es DATE: se arma con sus componentes, sin pasar por la zona horaria
    // (un servidor en UTC la correría un día y la visita del 1.º saldría del mes que se cobra).
    const f = it.fecha_ejecucion;
    const m = typeof f === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(f) : null;
    const d = f instanceof Date ? f : null;
    const fecha = m ? `${m[3]}/${m[2]}/${m[1]}`
      : d ? `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}` : '—';
    const celdas = [
      fecha, it.orden_codigo || '—', it.actividad || '—', it.empresa_nombre || '—', it.arl_nombre || '—',
      String(Number(it.horas) || 0), pesos(it.valor_hora_snapshot),
      Number(it.viaticos) > 0 ? pesos(it.viaticos) : '—', pesos(it.monto),
    ];
    const partidas = celdas.map((t, i) => (COLS[i].der ? [t] : partir(t, COLS[i].ancho)));
    const alto = Math.max(...partidas.map((l) => l.length)) * INTERLINEA + 6;
    // Espacio reservado abajo para los totales y la firma de la última página.
    if (y - alto < 70) {
      nuevaPagina();
      cabeceraTabla();
      fila = 0;
    }
    if (fila % 2 === 1) {
      page.drawRectangle({ x: IZQ, y: y - alto + 8, width: DER - IZQ, height: alto, color: suave });
    }
    partidas.forEach((lineas, i) => {
      const c = COLS[i];
      lineas.forEach((l, k) => {
        const x = c.der ? c.x + c.ancho - font.widthOfTextAtSize(l, SIZE) : c.x;
        page.drawText(l, { x, y: y - k * INTERLINEA, size: SIZE, font });
      });
    });
    // Un valor hora ajustado a mano se marca: quien lee la cuenta ve que no es la tarifa de siempre.
    if (it.ajuste_manual) {
      page.drawText('ajustado', { x: COLS[6].x + COLS[6].ancho - font.widthOfTextAtSize('ajustado', 6.2), y: y - INTERLINEA, size: 6.2, font, color: gray });
    }
    y -= alto;
    fila++;
  }

  if (!items.length) {
    page.drawText('Sin órdenes ejecutadas en el periodo.', { x: 44, y, size: 10, font, color: gray });
    y -= 16;
  }

  // Totales. Si no caben en lo que queda de la hoja, van a una nueva.
  if (y < 110) nuevaPagina();
  y -= 8;
  const xEt = 560;
  const xVal = DER - 4;
  page.drawLine({ start: { x: xEt - 10, y: y + 10 }, end: { x: DER, y: y + 10 }, thickness: 1, color: primary });
  const linea = (etiqueta, valor, negrita = false, color = rgb(0, 0, 0)) => {
    const f = negrita ? bold : font;
    page.drawText(etiqueta, { x: xEt, y, size: negrita ? 11 : 10, font: f, color });
    const t = String(valor);
    page.drawText(t, { x: xVal - f.widthOfTextAtSize(t, negrita ? 11 : 10), y, size: negrita ? 11 : 10, font: f, color });
    y -= 16;
  };
  y -= 6;
  linea('Total de horas', String(Number(precuenta.total_horas) || 0), true);

  // Con viáticos, el total deja de ser horas × tarifa: hay que desglosarlo o la
  // cifra no cuadra con las cuentas del profesional. Van en su propia línea
  // porque no son honorarios — la contadora los trata distinto.
  const viaticos = Number(precuenta.total_viaticos) || 0;
  if (viaticos > 0) {
    linea('Honorarios', pesos((Number(precuenta.total_monto) || 0) - viaticos));
    linea('Viáticos', pesos(viaticos));
  }
  y -= 2;
  linea('Total a pagar', pesos(precuenta.total_monto), true, primary);

  // Estado de la cuenta (PRE-06). Las observaciones NO se imprimen: son notas
  // internas del seguimiento —lo que anotó quien revisó un rechazo— y este
  // documento es el que se le manda al profesional y el que acompaña el pago.
  if (precuenta.estado) {
    page.drawText(`Estado: ${etiquetaEstado(precuenta.estado)}`, { x: 44, y: y + 16, size: 10, font: bold });
  }

  const bytes = await doc.save();
  return Buffer.from(bytes);
}
