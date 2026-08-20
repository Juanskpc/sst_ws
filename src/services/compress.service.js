/**
 * Compresión de los soportes que sube el profesional (M6).
 *
 * El grueso del almacenamiento en producción son **actas fotografiadas con el
 * móvil y escaneos**: 2-6 MB por archivo, tres archivos por visita y decenas de
 * visitas al mes. Guardarlos tal cual multiplica la factura de S3 sin que nadie
 * gane nada — al administrador le basta con poder leer las firmas y las cédulas.
 *
 * Medido sobre los documentos reales del cliente:
 *
 * | Entrada                                  | Antes   | Después | Vía          |
 * |------------------------------------------|---------|---------|--------------|
 * | Foto 2449×1567 desde el móvil            |  845 KB |   33 KB | imagen (96 %)|
 * | PDF de "escanear a PDF" (foto por página)| 1,63 MB |   77 KB | raster (95 %)|
 * | PDF ya escaneado y optimizado (2 pág.)   |  517 KB |  517 KB | reescritura  |
 * | PDF vectorial (formato de la ARL)        |  169 KB |  169 KB | original     |
 *
 * O sea: **lo que de verdad pesa son las fotos**, sueltas o metidas en un PDF
 * por la app de escanear del móvil. Un PDF que ya venía optimizado no da nada, y
 * eso está bien — la alternativa sería estropearlo.
 *
 * REGLA CENTRAL: **nunca se guarda algo más grande ni peor que el original.**
 * Rasterizar un escaneo ya comprimido lo engorda entre un 4 y un 8 %, y a un PDF
 * vectorial le quita además el texto seleccionable; por eso cada estrategia se
 * mide y solo gana si de verdad recorta. Ante cualquier fallo se guarda el
 * archivo tal como llegó: un soporte es prueba de una visita y perderlo por
 * optimizar sería absurdo.
 *
 * Y una comprobación explícita de que el resultado NO salió en blanco, porque de
 * las dos formas en que esto se rompió las dos daban archivos diminutos y
 * perfectamente válidos, solo que vacíos (ver `comprimirImagen` y el
 * `standardFontDataUrl` de `rasterizarPdf`).
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { PDFDocument } from 'pdf-lib';

/** Lado mayor al que se reduce una foto. Suficiente para leer una firma. */
const LADO_MAXIMO = 2000;
/** Calidad JPEG de las imágenes sueltas y de las páginas rasterizadas. */
const CALIDAD_IMAGEN = 72;
const CALIDAD_PAGINA = 70;
/** DPI al que se rasteriza un PDF (150 es el estándar de escaneo legible). */
const DPI_RASTER = 150;

/**
 * Por debajo de este tamaño no se intenta rasterizar: el proceso cuesta CPU por
 * página y en un archivo ya pequeño no hay nada que rascar.
 */
const MINIMO_PARA_RASTERIZAR = 300 * 1024;

/**
 * Rasterizar solo gana si recorta AL MENOS esto. Un PDF de texto real puede
 * quedar algo más pequeño como imagen y aun así sería un mal cambio: se pierde
 * el texto seleccionable y la nitidez al ampliar. Se exige un ahorro grande
 * para aceptar ese peaje.
 */
const AHORRO_MINIMO_RASTER = 0.25;

/**
 * `@napi-rs/canvas` entra hoy como dependencia **opcional** de `pdfjs-dist`.
 * Se carga tarde y una sola vez: si el despliegue no lo tiene (no hay binario
 * para esa plataforma), la compresión de imágenes se desactiva sola en lugar de
 * tumbar la carga de soportes.
 */
let _canvas;
async function canvasLib() {
  if (_canvas !== undefined) return _canvas;
  try {
    _canvas = await import('@napi-rs/canvas');
  } catch {
    _canvas = null;
    console.warn('[compress] @napi-rs/canvas no disponible: los soportes se guardan sin comprimir.');
  }
  return _canvas;
}

/**
 * Carpeta donde `pdfjs-dist` trae las 14 fuentes estándar del formato PDF.
 * Se resuelve desde el paquete instalado, no por ruta relativa, para que no
 * dependa de dónde arranque el proceso ni de cómo quede el árbol de módulos.
 */
let _fuentes;
function fuentesEstandar() {
  if (_fuentes !== undefined) return _fuentes;
  try {
    const requerir = createRequire(import.meta.url);
    _fuentes = `${path.dirname(requerir.resolve('pdfjs-dist/package.json'))}/standard_fonts/`;
  } catch {
    _fuentes = undefined;
  }
  return _fuentes;
}

const esPdf = (mime) => String(mime || '').includes('pdf');
const esImagen = (mime) => String(mime || '').startsWith('image/');

/**
 * Reduce una foto a `LADO_MAXIMO` y la reescribe como JPEG.
 *
 * Un PNG de cámara pesa varias veces lo que el JPEG equivalente y no aporta
 * nada aquí (no hay transparencia en la foto de un acta), así que también sale
 * como JPEG. Devuelve `null` si no se pudo o si no valió la pena.
 */
async function comprimirImagen(buffer) {
  const lib = await canvasLib();
  if (!lib) return null;
  const { createCanvas, loadImage } = lib;

  // `loadImage`, y NO `new Image(); img.src = buffer`. Con la asignación directa
  // el alto y el ancho quedan disponibles enseguida —parecía funcionar— pero los
  // píxeles todavía no están decodificados cuando llega el `drawImage`, y el
  // resultado era un rectángulo blanco de 15 KB. Un acta firmada convertida en
  // una hoja en blanco es exactamente el fallo que nadie nota hasta que la ARL
  // pide el soporte.
  const img = await loadImage(buffer);
  if (!img?.width || !img?.height) return null;

  const escala = Math.min(1, LADO_MAXIMO / Math.max(img.width, img.height));
  const ancho = Math.max(1, Math.round(img.width * escala));
  const alto = Math.max(1, Math.round(img.height * escala));

  const lienzo = createCanvas(ancho, alto);
  const ctx = lienzo.getContext('2d');
  // Fondo blanco: un PNG con transparencia se vería negro al pasar a JPEG.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, ancho, alto);
  ctx.drawImage(img, 0, 0, ancho, alto);

  const salida = await lienzo.encode('jpeg', CALIDAD_IMAGEN);
  const comprimido = Buffer.from(salida);

  // Red de seguridad contra el fallo de arriba y contra cualquier otro que deje
  // el lienzo vacío: si la imagen resultante no tiene tinta pero la original sí,
  // se descarta y el soporte se guarda tal como llegó.
  if (!tieneTinta(ctx, ancho, alto)) {
    console.warn('[compress] la imagen recomprimida salió en blanco: se conserva el original.');
    return null;
  }
  return { buffer: comprimido, mime: 'image/jpeg' };
}

/**
 * ¿Queda algo dibujado en el lienzo? Se muestrea en rejilla en vez de recorrer
 * los millones de píxeles de una foto: con encontrar un solo punto que no sea
 * blanco basta para saber que la imagen no se perdió.
 */
function tieneTinta(ctx, ancho, alto) {
  const paso = Math.max(1, Math.floor(Math.min(ancho, alto) / 200));
  const datos = ctx.getImageData(0, 0, ancho, alto).data;
  for (let y = 0; y < alto; y += paso) {
    for (let x = 0; x < ancho; x += paso) {
      const i = (y * ancho + x) * 4;
      if ((datos[i] + datos[i + 1] + datos[i + 2]) / 3 < 240) return true;
    }
  }
  return false;
}

/** Reescritura estructural del PDF (object streams). Barata y siempre segura. */
async function reescribirPdf(buffer) {
  const doc = await PDFDocument.load(buffer, { updateMetadata: false });
  const bytes = await doc.save({ useObjectStreams: true });
  return { buffer: Buffer.from(bytes), mime: 'application/pdf' };
}

/**
 * Convierte cada página en un JPEG y arma un PDF nuevo con ellas.
 *
 * Es lo que hace de verdad el trabajo en los escaneos, donde el peso está en
 * las imágenes incrustadas. El precio es perder el texto seleccionable, por eso
 * quien llama solo acepta el resultado si el ahorro es grande.
 */
async function rasterizarPdf(buffer) {
  const lib = await canvasLib();
  if (!lib) return null;
  const { createCanvas } = lib;
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const origen = await getDocument({
    data: new Uint8Array(buffer),
    disableWorker: true,
    isEvalSupported: false,
    // Sin esto, un PDF que use las fuentes estándar del formato (Helvetica,
    // Times…) sin incrustarlas se rasteriza SIN SU TEXTO: fuera del navegador
    // pdf.js no tiene de dónde sacar esas fuentes y se salta los caracteres.
    // Un acta escrita a máquina se convertiría en una hoja de rayas.
    standardFontDataUrl: fuentesEstandar(),
  }).promise;

  const destino = await PDFDocument.create();
  for (let i = 1; i <= origen.numPages; i++) {
    const pagina = await origen.getPage(i);
    // El tamaño en puntos se conserva: la página impresa mide lo mismo.
    const medidas = pagina.getViewport({ scale: 1 });
    const vista = pagina.getViewport({ scale: DPI_RASTER / 72 });
    const lienzo = createCanvas(Math.ceil(vista.width), Math.ceil(vista.height));
    const ctx = lienzo.getContext('2d');
    // Sin fondo, las zonas sin pintar quedan negras al pasar a JPEG.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, lienzo.width, lienzo.height);
    await pagina.render({ canvasContext: ctx, viewport: vista }).promise;

    // Una página que TENÍA contenido y se rasteriza en blanco es señal de que
    // algo no se pudo pintar; se aborta el rasterizado entero. Basta con mirar
    // la primera: los fallos de este tipo —una fuente que no se puede cargar—
    // afectan al documento completo, y leer los píxeles de cada página de un
    // escaneo largo costaría más que la propia conversión.
    if (i === 1 && !tieneTinta(ctx, lienzo.width, lienzo.height)) {
      const contenido = await pagina.getTextContent();
      const operaciones = await pagina.getOperatorList();
      if (contenido.items.length || operaciones.fnArray.length > 8) {
        console.warn(`[compress] la página ${i} se rasterizó en blanco: se descarta el rasterizado.`);
        return null;
      }
    }

    const jpg = await lienzo.encode('jpeg', CALIDAD_PAGINA);
    const incrustada = await destino.embedJpg(jpg);
    destino.addPage([medidas.width, medidas.height])
      .drawImage(incrustada, { x: 0, y: 0, width: medidas.width, height: medidas.height });
  }

  const bytes = await destino.save({ useObjectStreams: true });
  return { buffer: Buffer.from(bytes), mime: 'application/pdf' };
}

/** Ejecuta una estrategia sin dejar que su fallo tumbe la carga del soporte. */
async function intentar(nombre, fn) {
  try {
    return await fn();
  } catch (e) {
    console.warn(`[compress] ${nombre} falló: ${e?.message}`);
    return null;
  }
}

/**
 * Devuelve la mejor versión del archivo para guardar.
 *
 * @returns {{buffer: Buffer, mime: string, original: number, ahorro: number, via: string}}
 *   `via` explica qué ganó ('original' | 'pdf-reescrito' | 'pdf-rasterizado' |
 *   'imagen-recomprimida'), que es lo que hace depurable una queja del tipo
 *   "el acta se ve borrosa".
 */
export async function comprimirSoporte({ buffer, mime }) {
  const original = { buffer, mime, via: 'original' };
  let mejor = original;

  const quedarse = (candidato, via) => {
    if (candidato && candidato.buffer.length < mejor.buffer.length) {
      mejor = { ...candidato, via };
    }
  };

  if (esImagen(mime)) {
    quedarse(await intentar('imagen', () => comprimirImagen(buffer)), 'imagen-recomprimida');
  } else if (esPdf(mime)) {
    quedarse(await intentar('pdf-reescrito', () => reescribirPdf(buffer)), 'pdf-reescrito');

    if (buffer.length >= MINIMO_PARA_RASTERIZAR) {
      const raster = await intentar('pdf-rasterizado', () => rasterizarPdf(buffer));
      // El umbral se mide contra el ORIGINAL, no contra la reescritura: lo que
      // se está decidiendo es si vale la pena perder el texto seleccionable.
      if (raster && raster.buffer.length <= buffer.length * (1 - AHORRO_MINIMO_RASTER)) {
        quedarse(raster, 'pdf-rasterizado');
      }
    }
  }

  return {
    buffer: mejor.buffer,
    mime: mejor.mime,
    original: buffer.length,
    ahorro: buffer.length ? 1 - mejor.buffer.length / buffer.length : 0,
    via: mejor.via,
  };
}
