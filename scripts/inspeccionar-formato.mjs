/**
 * Radiografía de un formato de ARL, para poder prediligenciarlo.
 *
 * `formatos-arl.service.js` rellena cada formato de una de dos maneras, y cuál
 * toca depende de si el PDF trae formulario:
 *
 *   * CON AcroForm  → se escribe por NOMBRE de campo (`rellenarAcroForm`). Los
 *     nombres los puso quien diseñó el formato y no significan nada ("Text2",
 *     "13", "nombre 7"), así que hay que verlos junto a su rectángulo para
 *     saber qué etiqueta impresa les corresponde.
 *   * SIN AcroForm  → se dibuja el texto encima de la raya impresa por
 *     COORDENADAS (`rellenarPdfPlano` + los mapas `CASILLAS_*`). Para medirlas
 *     hace falta saber dónde termina cada etiqueta y dónde empieza la siguiente
 *     división de la tabla.
 *
 * Este script imprime las dos cosas, que es lo que hay que mirar cada vez que
 * una ARL publica una versión nueva de un formato: los nombres de campo NO
 * tienen por qué mantenerse entre versiones, ni las coordenadas.
 *
 * Uso:
 *   node scripts/inspeccionar-formato.mjs <archivo.pdf>              (campos + texto de la pág. 1)
 *   node scripts/inspeccionar-formato.mjs <archivo.pdf> --paginas 3  (texto de las 3 primeras)
 *   node scripts/inspeccionar-formato.mjs <archivo.pdf> --y 700 840  (solo esa franja vertical,
 *                                                                     item a item con su x)
 *   node scripts/inspeccionar-formato.mjs <archivo.pdf> --png sal.png [--pag 1] [--escala 4]
 *                                          [--zona x0 y0 x1 y1]      (VERLO, que es lo único que
 *                                                                     distingue una casilla de otra)
 *
 * El `--png` no es un adorno: en un formato sin AcroForm las etiquetas por sí
 * solas no dicen dónde empieza y termina cada casilla —un rótulo puede estar
 * encima, a la izquierda o dentro de su celda—, y adivinarlo produce un PDF
 * bien formado con los datos en la columna equivocada. La `--zona` va en
 * coordenadas PDF (las mismas que imprime el listado de texto), así que se
 * recorta justo lo que se está midiendo.
 *
 * OJO con los grupos de opción de Bolívar (Tipo de Actividad, Tipo de
 * Servicio): sus seis botones comparten el mismo valor de exportación, así que
 * `select()` los enciende TODOS. Este script lo enseña en la línea del
 * PDFRadioGroup; la marca hay que dibujarla sobre el rectángulo del widget.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PDFDocument } from 'pdf-lib';

const args = process.argv.slice(2);
const ruta = args[0];
if (!ruta) {
  console.error('Uso: node scripts/inspeccionar-formato.mjs <archivo.pdf> [--paginas N] [--y min max]');
  process.exit(1);
}
const paginas = Number(args[args.indexOf('--paginas') + 1]) || 1;
const iy = args.indexOf('--y');
const franja = iy >= 0 ? [Number(args[iy + 1]), Number(args[iy + 2])] : null;
const png = args.includes('--png') ? args[args.indexOf('--png') + 1] : null;
const pagPng = Number(args[args.indexOf('--pag') + 1]) || 1;
const escalaPng = Number(args[args.indexOf('--escala') + 1]) || 2;
const iz = args.indexOf('--zona');
const zona = iz >= 0 ? args.slice(iz + 1, iz + 5).map(Number) : null;

const bytes = await fs.readFile(ruta);

// ---------------------------------------------------------------------------
// 1) Campos de formulario
// ---------------------------------------------------------------------------
console.log(`\n=== ${path.basename(ruta)} · campos de formulario ===`);
const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
const campos = doc.getForm().getFields();
if (!campos.length) {
  console.log('(sin AcroForm: es un PDF plano, se rellena por coordenadas)');
}
for (const campo of campos) {
  const tipo = campo.constructor.name;
  let extra = '';
  if (tipo === 'PDFRadioGroup') {
    const op = campo.getOptions();
    const repetidas = new Set(op).size !== op.length;
    extra = ` opciones=${JSON.stringify(op)}` +
      (repetidas ? '  ⚠️ valores de exportación REPETIDOS: select() encendería todos' : '');
  }
  if (tipo === 'PDFCheckBox') extra = ` marcado=${campo.isChecked()}`;
  // El valor que arrastra el formato en blanco importa: los de Bolívar no venían
  // vacíos del todo (traían el plan y el código de aliado ya escritos).
  if (tipo === 'PDFTextField') extra = ` valor=${JSON.stringify((campo.getText() || '').slice(0, 40))}`;
  // La PÁGINA de cada widget importa: los formatos de varias hojas repiten
  // nombres de campo por posición ("nombre 9" está en la 2, no en la 1), y
  // escribir en la hoja equivocada no da ningún error.
  const cajas = campo.acroField.getWidgets()
    .map((w) => {
      const r = w.getRectangle();
      return `[pág ${paginaDeWidget(doc, w)} x=${Math.round(r.x)} y=${Math.round(r.y)} ` +
             `${Math.round(r.width)}x${Math.round(r.height)}]`;
    })
    .join(' ');
  console.log(`${tipo.padEnd(14)} ${JSON.stringify(campo.getName()).padEnd(24)}${extra}  ${cajas}`);
}

/** En qué página (1-based) vive un widget; 0 si no se pudo resolver. */
function paginaDeWidget(documento, widget) {
  const hojas = documento.getPages();
  const ref = widget.P();
  let i = hojas.findIndex((p) => p.ref === ref);
  if (i < 0) {
    const refWidget = widget.dict.context.getObjectRef(widget.dict);
    i = hojas.findIndex((p) => (p.node.Annots()?.asArray() ?? []).includes(refWidget));
  }
  return i + 1;
}

// ---------------------------------------------------------------------------
// 2) Texto impreso con su posición
// ---------------------------------------------------------------------------
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
// `standardFontDataUrl` NO es opcional fuera del navegador. Sin él, pdfjs no
// encuentra las Helvetica/Times de los "standard 14" y **dibuja la página sin
// ese texto, y sin dar un solo error**: un formato recién rellenado sale en
// blanco en la imagen aunque el texto SÍ esté guardado en el PDF. Es la misma
// trampa que ya documenta `services/compress.service.js`, y aquí es peor —
// engaña a quien está comprobando si el formato quedó bien.
//
// Tiene que ser una RUTA DE FICHERO acabada en separador (en Node pdfjs hace
// `readFile(url + nombre)`), no un `file://`, y se resuelve desde el paquete
// instalado para no depender de dónde arranque el proceso.
//
// Y `useSystemFonts` va en FALSE. Con `true` —que es lo que trae medio ejemplo
// de internet— pdfjs prefiere una fuente del sistema, en Node no hay ninguna, y
// **se salta el texto sin decir nada**. Es el mismo síntoma exacto que no tener
// las fuentes: página en blanco donde debería ir lo que se acaba de rellenar.
const requerir = createRequire(import.meta.url);
const FUENTES = path.join(
  path.dirname(requerir.resolve('pdfjs-dist/package.json')), 'standard_fonts',
) + path.sep;
const lector = await pdfjs.getDocument({
  data: new Uint8Array(bytes),
  useSystemFonts: false,
  standardFontDataUrl: FUENTES,
}).promise;

for (let p = 1; p <= Math.min(lector.numPages, paginas); p++) {
  const pagina = await lector.getPage(p);
  const items = (await pagina.getTextContent()).items.filter((i) => i.str.trim());
  console.log(`\n=== texto · página ${p} de ${lector.numPages} · caja ${JSON.stringify(pagina.view)} ===`);

  if (franja) {
    // Item a item: es la vista que hace falta para medir una casilla concreta.
    for (const it of items) {
      const y = it.transform[5];
      if (y < franja[0] || y > franja[1]) continue;
      console.log(`x=${String(Math.round(it.transform[4])).padStart(4)} ` +
                  `y=${String(Math.round(y)).padStart(4)} ` +
                  `ancho=${String(Math.round(it.width)).padStart(3)}  ${JSON.stringify(it.str)}`);
    }
    continue;
  }

  // Vista de lectura: los items agrupados en renglones, de arriba abajo. Es la
  // que sirve para reconocer el formato y localizar la etiqueta que se busca.
  const renglones = new Map();
  for (const it of items) {
    const clave = Math.round(it.transform[5] / 4) * 4;   // tolerancia de 4 pt
    if (!renglones.has(clave)) renglones.set(clave, []);
    renglones.get(clave).push([it.transform[4], it.str]);
  }
  for (const y of [...renglones.keys()].sort((a, b) => b - a)) {
    const linea = renglones.get(y).sort((a, b) => a[0] - b[0]).map(([, s]) => s).join('');
    console.log(String(y).padStart(4), linea.replace(/\s+/g, ' ').trim());
  }
}

// ---------------------------------------------------------------------------
// 3) Verlo (--png)
// ---------------------------------------------------------------------------
if (png) {
  const { createCanvas } = await import('@napi-rs/canvas');
  const hoja = await lector.getPage(pagPng);
  const vp = hoja.getViewport({ scale: escalaPng });
  const lienzo = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const ctx = lienzo.getContext('2d');
  // Fondo blanco: el PDF no lo pinta y un canvas nace transparente, así que sin
  // esto las líneas finas del formato quedan invisibles sobre negro.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, lienzo.width, lienzo.height);
  await hoja.render({ canvasContext: ctx, viewport: vp, canvas: lienzo }).promise;

  let salida = lienzo;
  if (zona && zona.length === 4 && zona.every(Number.isFinite)) {
    const [x0, y0, x1, y1] = zona;
    const alto = hoja.view[3];
    const px = (v) => Math.round(v * escalaPng);
    // La `y` del PDF crece hacia arriba y la del lienzo hacia abajo.
    const rx = px(x0);
    const ry = Math.round((alto - y1) * escalaPng);
    const rw = px(x1) - rx;
    const rh = Math.round((y1 - y0) * escalaPng);
    salida = createCanvas(rw, rh);
    salida.getContext('2d').drawImage(lienzo, rx, ry, rw, rh, 0, 0, rw, rh);
  }
  await fs.writeFile(png, salida.toBuffer('image/png'));
  console.log(`
=== imagen · ${png} · ${salida.width}x${salida.height} px · escala ${escalaPng}` +
              `${zona ? ` · zona PDF x ${zona[0]}-${zona[2]}, y ${zona[1]}-${zona[3]}` : ''} ===`);
}
