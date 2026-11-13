import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { CAMPOS_BORRADOR } from './gemini.service.js';
import { normalizarModalidadEjecucion, normalizarTipoActividadBolivar } from '../utils/bolivar.js';

/**
 * ARL SURA · «Carta orden de compra» en PDF (13-nov-2026).
 *
 * Además del Excel «Reporte estado de las tareas» (que trae muchas órdenes), Sura manda cada
 * orden suelta como PDF: `CartaOrdenCompra_FactoresRiesgo_<orden>_<fecha>.pdf`. La página 1 es
 * la orden de compra y la 2 el informe de factores de riesgo de la empresa. Hasta hoy entraba
 * por el camino de AXA y Colmena: el clasificador solo conoce esas dos ARL, así que la orden
 * quedaba como AXA o Colmena y con los campos mal leídos (JD&D: «no lo está detectando bien»).
 *
 * Se lee SIN inteligencia artificial, como el Excel de Sura y su reporte de facturas: el PDF
 * lo genera la plataforma de Sura con capa de texto, y cada dato va a la derecha de su rótulo
 * fijo («EMPRESA:», «LUGAR:», «FECHA DE ENTREGA FINAL:»…), en la misma línea. Se agrupa por
 * posición. Los campos salen con la MISMA forma que el Excel de Sura (`parseExcelSura`), para
 * que una orden leída de cualquiera de los dos documentos quede igual.
 *
 * Ojo: la plataforma de Sura escribe la Ñ y algunas tildes como «¿» (MU¿OZ, ANDR¿S). No se
 * adivinan: esos campos bajan de confianza para que quien revisa los corrija.
 */

/** Rótulos de la página 1. Un valor termina donde empieza el siguiente rótulo de su línea. */
const ROTULOS = new Set([
  'ORDEN DE COMPRA No.', 'Forma de Pago:', 'Fecha de Elaboración:', 'Elaborado por:', 'Distribuidor:', 'NIT:',
  'EMPRESA:', 'AFILIADOS OF:', 'CLASE RIESGO:', 'CENTRO DE TRABAJO:', 'LUGAR:', 'CONTACTO:', 'TELEFONO:',
  'PROFESIONAL RESPONSABLE EMPRESA:', 'PRESTADOR:', 'REQUIERE INFORME:', 'REQUIERE INFORME PARA FACTURACIÓN:',
  'RECURSO PÚBLICO:', 'VALOR VIÁTICOS:', 'VALOR TRANSPORTE:', 'VALOR TRANSPORTE ADICIONAL:', 'MUNICIPIO',
  'LUGAR DESTINO:', 'FECHA DE ENTREGA', 'FECHA DE ENTREGA FINAL:', 'PRIORIDAD:', 'OBSERVACIONES:',
  'Especificaciones:', 'TOTAL:',
]);
const MISMA_LINEA = 3;

async function leerTokens(buffer) {
  const doc = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false }).promise;
  const tokens = [];
  try {
    for (let p = 1; p <= Math.min(doc.numPages, 3); p++) {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      for (const i of (await page.getTextContent()).items) {
        const s = ('str' in i ? i.str : '').replace(/\s+/g, ' ').trim();
        if (s) tokens.push({ s, x: Math.round(i.transform[4]), y: Math.round(vp.height - i.transform[5]), pagina: p });
      }
    }
  } finally {
    await doc.destroy();
  }
  return tokens.sort((a, b) => a.pagina - b.pagina || a.y - b.y || a.x - b.x);
}

/**
 * ¿Es la orden de compra de Sura? Se reconoce por el encabezado de la página 1: la razón
 * social de Sura y el rótulo de la orden de compra, con el bloque «PRESTADOR:» que no tiene
 * ninguna orden de AXA ni de Colmena.
 */
export async function esOrdenCompraSura(buffer) {
  try {
    const textos = new Set((await leerTokens(buffer)).filter((t) => t.pagina === 1).map((t) => t.s));
    return textos.has('SURAMERICANA S.A.') && textos.has('ORDEN DE COMPRA No.') && textos.has('PRESTADOR:');
  } catch {
    return false;
  }
}

/** «82,000.00» → «82000». */
const pesos = (t) => {
  const n = Number(String(t ?? '').replace(/,/g, '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) && String(t ?? '').trim() ? String(Math.round(n * 100) / 100) : '';
};
/** «31/12/2026» → «2026-12-31». */
const iso = (t) => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(t ?? '').trim());
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
};

/**
 * Lee la orden. Devuelve `{ fields, sura }` como una fila de `parseExcelSura`, o null si no
 * encuentra el número de orden (entonces quien llama usa la extracción con IA).
 */
export async function leerOrdenCompraSura(buffer) {
  const tokens = await leerTokens(buffer);
  const p1 = tokens.filter((t) => t.pagina === 1);
  const rotulo = (texto) => p1.find((t) => t.s === texto) ?? null;
  const enLinea = (r) => p1.filter((t) => Math.abs(t.y - r.y) <= MISMA_LINEA);

  /** Lo que hay a la derecha de un rótulo, hasta el siguiente rótulo de la misma línea. */
  const partesDe = (r) => {
    if (!r) return [];
    const linea = enLinea(r).filter((t) => t.x > r.x).sort((a, b) => a.x - b.x);
    const fin = linea.findIndex((t) => ROTULOS.has(t.s));
    return (fin >= 0 ? linea.slice(0, fin) : linea).map((t) => t.s);
  };
  const valor = (texto) => partesDe(rotulo(texto)).join(' ');
  /** Para rótulos repetidos en la línea (MUNICIPIO aparece dos veces): el primero. */
  const debajo = (r, maxDy = 20) => (r ? p1.find((t) => t.y > r.y + MISMA_LINEA && t.y <= r.y + maxDy && Math.abs(t.x - r.x) <= 15)?.s ?? '' : '');

  // ── Número de la orden: va debajo de «ORDEN DE COMPRA No.»; si no, el de la página 2.
  let numero = debajo(rotulo('ORDEN DE COMPRA No.'));
  if (!/^\d{5,}$/.test(numero)) {
    numero = tokens.map((t) => /ORDEN DE COMPRA No\.\s*(\d{5,})/.exec(t.s)?.[1]).find(Boolean) ?? '';
  }
  if (!numero) return null;

  // ── La tabla de productos: entre los títulos de columna y la línea de la EMPRESA.
  const cab = rotulo('DESCRIPCIÓN');
  const empresaR = rotulo('EMPRESA:');
  const columnas = ['CLASIFICACIÓN', 'CANTIDAD', 'UNIDAD', 'PRECIO UNITARIO', 'VALOR TOTAL']
    .map((n) => ({ n, x: cab ? enLinea(cab).find((t) => t.s === n)?.x : undefined }))
    .filter((c) => c.x != null);
  const xDescripcion = columnas[0]?.x ?? 290;
  const items = [];
  if (cab && empresaR) {
    for (const t of p1.filter((t) => t.y > cab.y + MISMA_LINEA && t.y < empresaR.y - MISMA_LINEA)) {
      if (t.x < 70 && /^\d+$/.test(t.s)) {
        // El código (112, 69…) abre una línea de la tabla.
        items.push({ codigo: t.s, y: t.y, desc: [], celdas: {} });
      } else if (items.length && t.x < xDescripcion - 10) {
        items[items.length - 1].desc.push(t.s);
      } else if (items.length) {
        // Cada valor va en la columna cuyo título queda más cerca por la izquierda (los números
        // se alinean a la derecha y se corren unos puntos).
        const col = [...columnas].reverse().find((c) => t.x + 5 >= c.x);
        if (col) items[items.length - 1].celdas[col.n] = t.s;
      }
    }
  }
  // El producto («112-PLAN DE PREVENCION…») no lleva cantidad; la tarea sí.
  const tareas = items.filter((i) => i.celdas.CANTIDAD);
  const producto = items.find((i) => !i.celdas.CANTIDAD);
  const tarea = tareas[0] ?? null;
  const unidad = String(tarea?.celdas.UNIDAD ?? '').toUpperCase();
  const cantidad = Number(String(tarea?.celdas.CANTIDAD ?? '').replace(',', '.'));

  // ── Los datos con rótulo.
  const empresa = partesDe(empresaR);
  const contrato = /^\d{6,}$/.test(empresa[0] ?? '') ? empresa.shift() : '';
  const prestador = partesDe(rotulo('PRESTADOR:'));
  const prestadorDoc = /^[A-Z]?\d{5,}$/.test(prestador[0] ?? '') ? prestador.shift() : '';
  const municipioR = p1.filter((t) => t.s === 'MUNICIPIO').sort((a, b) => a.x - b.x)[0] ?? null;
  const obsR = rotulo('OBSERVACIONES:');
  const finObs = rotulo('Especificaciones:')?.y ?? Infinity;
  const observaciones = obsR
    ? p1.filter((t) => t.y > obsR.y + MISMA_LINEA && t.y < finObs - MISMA_LINEA).map((t) => t.s).join(' ').trim()
    : '';
  const actividadEconomica = (() => {
    const r = tokens.find((t) => t.pagina === 2 && t.s === 'ACTIVIDAD:');
    return r ? tokens.filter((t) => t.pagina === 2 && Math.abs(t.y - r.y) <= MISMA_LINEA && t.x > r.x).map((t) => t.s).join(' ') : '';
  })();

  // ── Campos del borrador, con la misma forma que el Excel de Sura.
  const fields = {};
  // Con «¿» la plataforma de Sura perdió una Ñ o una tilde: que quien revisa lo corrija.
  const poner = (campo, value, confidence = 99) => {
    const v = String(value ?? '').trim();
    fields[campo] = { value: v, confidence: v ? (v.includes('¿') ? Math.min(confidence, 70) : confidence) : 0 };
  };
  for (const campo of CAMPOS_BORRADOR) poner(campo, '');

  poner('numero_orden', numero);
  poner('fecha_orden', iso(valor('Fecha de Elaboración:')));
  // La fecha FINAL es el plazo de Sura para entregar: el vencimiento (igual que en el Excel).
  poner('fecha_vencimiento', iso(valor('FECHA DE ENTREGA FINAL:')));
  poner('nro_afiliacion', contrato);
  poner('empresa_nombre', empresa.join(' '));
  poner('actividad_economica', actividadEconomica, 95);
  poner('tipo_actividad', tarea ? tarea.desc.join(' ') : '', tarea && tareas.length === 1 ? 99 : 70);
  const letra = normalizarTipoActividadBolivar(tarea?.celdas['CLASIFICACIÓN']);
  poner('tipo_servicio_arl', letra ?? '');
  // Sura mide en HORAS; si la unidad fuera otra, las horas las escribe quien revisa.
  if (unidad === 'HORAS' && Number.isFinite(cantidad) && cantidad > 0) {
    const total = tareas.reduce((a, i) => a + (Number(String(i.celdas.CANTIDAD).replace(',', '.')) || 0), 0);
    poner('horas_asignadas', String(tareas.length > 1 ? total : cantidad), tareas.length > 1 ? 70 : 99);
  }
  poner('valor_unitario', pesos(tarea?.celdas['PRECIO UNITARIO']), tareas.length > 1 ? 70 : 99);
  poner('valor_total', pesos(valor('TOTAL:') || tarea?.celdas['VALOR TOTAL']));
  poner('ciudad_ejecucion', partesDe(municipioR).join(' '), 95);
  poner('direccion', valor('LUGAR:'), 95);
  poner('contacto_empresa_nombre', valor('CONTACTO:'), 95);
  poner('contacto_empresa_telefono', valor('TELEFONO:'), 95);
  // Sin observaciones, el detalle es el producto de Sura, como en el Excel.
  poner('descripcion', observaciones || (producto ? `${producto.codigo}-${producto.desc.join(' ').replace(/^\d+-/, '')}` : ''), observaciones ? 99 : 90);
  // «CAPACITACIÓN PRESENCIAL - …»: la modalidad solo si la observación la dice con esa palabra.
  const modalidad = normalizarModalidadEjecucion(/\b(PRESENCIAL|VIRTUAL)\b/i.exec(observaciones)?.[1]);
  if (modalidad) {
    poner('modalidad', modalidad, 90);
    poner('modalidad_ejecucion', modalidad, 90);
  }

  return {
    fields,
    sura: {
      origen: 'pdf',
      contrato: contrato || null,
      producto: producto ? producto.desc.join(' ') : null,
      // En el Excel, «PROFESIONAL» es quien elabora la orden en Sura.
      profesional_arl: debajo(rotulo('Elaborado por:')) || null,
      prestador: prestador.join(' ') || null,
      prestador_documento: prestadorDoc || null,
      centro_trabajo: valor('CENTRO DE TRABAJO:') || null,
      profesional_responsable_empresa: valor('PROFESIONAL RESPONSABLE EMPRESA:') || null,
      afiliados: valor('AFILIADOS OF:') || null,
      clase_riesgo: valor('CLASE RIESGO:') || null,
      fecha_entrega_inicial: iso(valor('FECHA DE ENTREGA')) || null,
      requiere_informe: valor('REQUIERE INFORME:') || null,
      requiere_informe_facturacion: valor('REQUIERE INFORME PARA FACTURACIÓN:') || null,
      recurso_publico: valor('RECURSO PÚBLICO:') || null,
      valores: {
        viaticos: pesos(valor('VALOR VIÁTICOS:')) || null,
        transporte: pesos(valor('VALOR TRANSPORTE:')) || null,
        transporte_adicional: pesos(valor('VALOR TRANSPORTE ADICIONAL:')) || null,
      },
      tareas: tareas.length,
    },
  };
}
