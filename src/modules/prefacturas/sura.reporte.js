import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { badRequest } from '../../utils/httpError.js';

/**
 * ARL SURA · «Reporte de facturas» (24-oct-2026).
 *
 * Es lo que la plataforma de Sura imprime cuando JD&D le registra una factura: el número de
 * la factura (FE-1010), su fecha y, por cada orden, la tarea, la clasificación, las horas
 * pedidas / facturadas / a facturar y una fila por sesión de campo con su fecha, su valor
 * unitario ($ 82.000 la hora) y su valor total. Cierra con el TOTAL de la factura.
 *
 * Se lee SIN inteligencia artificial: el PDF tiene capa de texto y cada dato está en una
 * columna fija, así que se agrupa por posición. Es más rápido, gratis y exacto que el modelo
 * que lee la prefactura de Bolívar (cuyo texto sale desordenado).
 *
 * Una orden puede partirse entre dos páginas (el encabezado al pie de una y sus sesiones al
 * inicio de la siguiente); por eso las páginas se leen como UNA hoja larga.
 */

const SALTO_PAGINA = 10000;

/** «$ 656,000» → 656000. */
const pesos = (t) => {
  const n = Number(String(t ?? '').replace(/[^0-9.-]/g, '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/** «20/10/2026» → «2026-10-20». */
const isoDeCorta = (t) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(t ?? '').trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

async function leerTokens(buffer) {
  const doc = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false }).promise;
  const tokens = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      for (const i of tc.items) {
        const s = ('str' in i ? i.str : '').trim();
        if (!s) continue;
        tokens.push({ s, x: Math.round(i.transform[4]), y: Math.round(vp.height - i.transform[5]) + (p - 1) * SALTO_PAGINA, pagina: p });
      }
    }
  } finally {
    await doc.destroy();
  }
  return tokens;
}

/** ¿El PDF es el reporte de facturas de Sura? */
export async function esReporteSura(buffer) {
  try {
    const t = await leerTokens(buffer);
    const textos = new Set(t.filter((x) => x.pagina === 1).map((x) => x.s));
    return textos.has('REPORTE DE FACTURAS') && textos.has('NÚMERO DE FACTURA') && textos.has('CLASIFICACIÓN');
  } catch {
    return false;
  }
}

/**
 * Lee el reporte y devuelve la MISMA forma que la prefactura de Bolívar, para que la vista previa, el cruce
 * con las órdenes y el «aplicar» sirvan igual: `codigo_cronograma` lleva el número de la ORDEN de Sura y
 * `secuencia` va en '0' (Sura no tiene secuencias). Lo propio de Sura (horas y sesiones) viaja aparte.
 */
export async function leerReporteSura(buffer) {
  const tokens = await leerTokens(buffer);
  if (!tokens.length) throw badRequest('El PDF no tiene texto extraíble (parece escaneado).');

  const valorDe = (rotulo, dx = 120) => {
    const r = tokens.find((t) => t.pagina === 1 && t.s === rotulo);
    if (!r) return null;
    return tokens.find((t) => t.pagina === 1 && Math.abs(t.y - r.y) <= 3 && t.x > r.x && t.x <= r.x + dx + 60)?.s ?? null;
  };
  const numeroFactura = valorDe('NÚMERO DE FACTURA');
  const fecha = isoDeCorta(valorDe('FECHA', 120));
  if (!numeroFactura) throw badRequest('No se pudo leer el número de factura del reporte de Sura.');

  const total = tokens.find((t) => t.s === 'TOTAL:');
  const valorTotal = total ? pesos(tokens.find((t) => Math.abs(t.y - total.y) <= 3 && t.x > total.x)?.s) : 0;

  // Las órdenes empiezan en el número que va pegado al margen (x ≈ 32); su último dígito cae un renglón más abajo (x ≈ 45).
  const anclas = tokens.filter((t) => t.x >= 28 && t.x <= 36 && /^\d{6,8}$/.test(t.s)).sort((a, b) => a.y - b.y);
  const filas = [];
  for (let k = 0; k < anclas.length; k++) {
    const ancla = anclas[k];
    const hasta = anclas[k + 1]?.y ?? Infinity;
    const bloque = tokens.filter((t) => t.y >= ancla.y - 4 && t.y < hasta - 4);
    const resto = bloque.find((t) => t.x >= 40 && t.x <= 50 && /^\d$/.test(t.s) && t.y > ancla.y && t.y <= ancla.y + 14);
    const orden = ancla.s + (resto?.s ?? '');

    // El encabezado de la orden termina donde empieza «Tipo» (la cabecera de las sesiones).
    const tipo = bloque.find((t) => t.s === 'Tipo' && t.x <= 50);
    const yTipo = tipo?.y ?? Infinity;
    const enCab = bloque.filter((t) => t.y < yTipo);
    const tarea = enCab.filter((t) => t.x >= 60 && t.x < 138 && t.y >= ancla.y - 4 && t.y <= ancla.y + 24).map((t) => t.s).join(' ');
    const clasificacion = enCab.find((t) => t.x >= 138 && t.x < 220)?.s ?? '';
    const horas = (x) => {
      const t = enCab.find((c) => Math.abs(c.x - x) <= 6 && /^\d+(\.\d+)?$/.test(c.s));
      return t ? Number(t.s) : null;
    };
    const empresa = enCab.filter((t) => t.x >= 525 && t.x < 575 && t.y >= ancla.y - 4 && !['N/A', 'CLIENTE'].includes(t.s))
      .sort((a, b) => a.y - b.y).map((t) => t.s).join(' ').replace(/\s+/g, ' ');

    // Sesiones: cada fila empieza en «CAMPO» (o «OFICINA» si algún día llega informe).
    const filasTipo = bloque.filter((t) => /^(CAMPO|INFORME|OFICINA)$/.test(t.s) && t.x <= 50 && t.y > yTipo);
    const sesiones = filasTipo.map((f) => {
      const fila = bloque.filter((t) => Math.abs(t.y - f.y) <= 3);
      const f1 = fila.find((t) => /^\d{4}\/\d{2}\/\d{2}$/.test(t.s));
      const unit = fila.find((t) => t.s.startsWith('$') && t.x >= 590 && t.x < 650);
      const tot = fila.find((t) => t.s.startsWith('$') && t.x >= 650);
      const dur = fila.find((t) => /HORAS?$/.test(t.s) && t.x >= 130 && t.x < 180);
      return {
        tipo: f.s,
        fecha: f1 ? f1.s.replace(/\//g, '-') : null,
        horas: dur ? Number(dur.s.split(' ')[0]) : null,
        valor_unitario: unit ? pesos(unit.s) : 0,
        valor_total: tot ? pesos(tot.s) : 0,
      };
    });

    const valorFila = sesiones.reduce((s, x) => s + x.valor_total, 0);
    filas.push({
      codigo_cronograma: orden,
      secuencia: '0',
      nit_empresa: null,
      razon_social: empresa || null,
      actividad_programa: [tarea, clasificacion].filter(Boolean).join(' · ') || null,
      valor_actividad: valorFila,
      alimentacion: 0, alojamiento: 0, transporte: 0, material: 0, tiempo_muerto: 0,
      valor_a_facturar: valorFila,
      horas_facturadas: horas(322),
      horas_a_facturar: horas(429),
      sesiones,
    });
  }
  if (!filas.length) throw badRequest('No se encontró ninguna orden en el reporte de Sura.');

  const sumaFilas = filas.reduce((s, f) => s + f.valor_a_facturar, 0);
  return {
    arl: 'SURA',
    numero_prefactura: numeroFactura,
    plan_codigo: null,
    plan_descripcion: 'Reporte de facturas de ARL SURA',
    fecha_corte: fecha,
    valor_total: valorTotal || sumaFilas,
    nit_proveedor: null,
    filas,
    suma_filas: sumaFilas,
    cuadra: Math.abs(sumaFilas - (valorTotal || sumaFilas)) < 1,
  };
}
