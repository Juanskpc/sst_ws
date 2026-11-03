import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * 3-nov-2026 · Lectura DETERMINISTA de los importes de la tabla del "DETALLE
 * PREFACTURA" de Bolívar, por la POSICIÓN de cada texto en la página.
 *
 * Por qué existe: el texto plano que recibe la IA llega con las columnas
 * revueltas (`$0 $0 $197,695 <NIT> <actividad> <razón> $142,914 $0 $54,781 $0`) y,
 * en las filas que traen transporte, el modelo intercambiaba "Vlr Actividad" con
 * "Vlr a Facturar" y perdía el transporte. Con la prefactura 162914 lo hacía
 * SIEMPRE (temperatura 0): las órdenes con transporte salían como "Valor distinto"
 * aunque en Orbita estuvieran bien, y la fila que se guardaba habría facturado
 * sin el transporte.
 *
 * En la página, en cambio, cada fila tiene sus siete importes alineados en la
 * misma línea y en el orden de las columnas impresas: Vlr Actividad,
 * Alimentación, Alojamiento, Transporte, Material, Tiempo M., Vlr a Facturar.
 * Aquí no se adivina nada: si una fila no trae exactamente siete importes o no
 * cumple "a facturar = actividad + gastos", se descarta y manda lo de la IA.
 *
 * @returns {Promise<Map<string, {valor_actividad:number, alimentacion:number,
 *   alojamiento:number, transporte:number, material:number, tiempo_muerto:number,
 *   valor_a_facturar:number}>>} clave `cronograma|secuencia`.
 */
export async function leerImportesPorPosicion(buffer) {
  const filas = new Map();
  let doc;
  try {
    doc = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false }).promise;
  } catch {
    return filas; // si pdf.js no lo abre, la extracción con IA ya habrá fallado con su propio mensaje
  }
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const items = (await (await doc.getPage(n)).getTextContent()).items
        .filter((it) => 'str' in it && it.str.trim())
        .map((it) => ({ s: it.str.trim(), x: it.transform[4], y: it.transform[5] }));
      for (const [clave, fila] of filasDePagina(items)) filas.set(clave, fila);
    }
  } finally {
    await doc.destroy();
  }
  return filas;
}

const ES_IMPORTE = /^\$\s?-?[\d.,]+$/;
const ES_ENTERO = /^\d+$/;
const COLUMNAS = ['valor_actividad', 'alimentacion', 'alojamiento', 'transporte', 'material', 'tiempo_muerto', 'valor_a_facturar'];

/** "$1,531,768" → 1531768 (Bolívar imprime la coma como separador de miles). */
const importe = (s) => Number(s.replace(/[$\s,]/g, '')) || 0;

/** Agrupa por la coordenada de la línea, con medio punto de tolerancia por redondeos del PDF. */
function agrupar(items, eje) {
  const grupos = new Map();
  for (const it of items) {
    const k = Math.round(it[eje] * 2) / 2;
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(it);
  }
  return grupos;
}

/**
 * Las prefacturas llegan en horizontal (página girada), así que la "línea" de
 * una fila puede ser la x o la y según el PDF. Se prueban los dos ejes y se
 * queda el que da filas válidas.
 */
function filasDePagina(items) {
  let mejor = new Map();
  for (const [ejeFila, ejeColumna] of [['x', 'y'], ['y', 'x']]) {
    const encontradas = new Map();
    for (const linea of agrupar(items, ejeFila).values()) {
      const fila = leerLinea(linea, ejeColumna);
      if (fila) encontradas.set(fila.clave, fila.importes);
    }
    if (encontradas.size > mejor.size) mejor = encontradas;
  }
  return mejor;
}

function leerLinea(linea, ejeColumna) {
  const ordenada = [...linea].sort((a, b) => a[ejeColumna] - b[ejeColumna]);
  const montos = ordenada.filter((it) => ES_IMPORTE.test(it.s)).map((it) => importe(it.s));
  if (montos.length !== COLUMNAS.length) return null;
  // Cronograma y secuencia son los dos primeros números enteros de la fila.
  const enteros = ordenada.filter((it) => ES_ENTERO.test(it.s));
  if (enteros.length < 2 || !/^\d{5,9}$/.test(enteros[0].s)) return null;

  // El orden visual puede venir al derecho o al revés según cómo esté girada
  // la página: vale el sentido en el que "a facturar = actividad + gastos".
  for (const valores of [montos, [...montos].reverse()]) {
    const f = Object.fromEntries(COLUMNAS.map((c, i) => [c, valores[i]]));
    const suma = f.valor_actividad + f.alimentacion + f.alojamiento + f.transporte + f.material + f.tiempo_muerto;
    if (Math.abs(suma - f.valor_a_facturar) < 1) {
      return { clave: `${enteros[0].s}|${enteros[1].s}`, importes: f };
    }
  }
  return null;
}
