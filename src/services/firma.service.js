/**
 * 16-oct-2026 · Limpieza de la firma digital del profesional antes de guardarla.
 *
 * Las firmas llegan como recortes de pantalla o fotos: fondo blanco opaco y un
 * margen de sobra alrededor del trazo. Estampadas así en un formato, el margen
 * hace que la firma salga diminuta y «flotando» sobre la raya, y el fondo blanco
 * tapa las líneas del formato que tiene debajo (se vio en el PSP-F-006 de Colmena).
 *
 * Por eso se guarda ya limpia, como PNG:
 *   1. el blanco (y el casi blanco del papel fotografiado) pasa a transparente,
 *      con una rampa suave para no dejar el trazo dentado;
 *   2. se recorta al rectángulo que ocupa el trazo, con un pequeño margen.
 *
 * Si `@napi-rs/canvas` no está disponible (ver `compress.service.js`), se guarda
 * la imagen tal como llegó: firma con margen, pero firma.
 */
import { badRequest } from '../utils/httpError.js';

/** Por encima de este brillo (0-255) el píxel es fondo: transparente del todo. */
const BLANCO = 225;
/** Por debajo, tinta opaca; entre los dos, transparencia gradual. */
const TINTA = 170;
/** Margen (px) que se deja alrededor del trazo al recortar. */
const MARGEN = 4;
/** Lado mayor con el que se guarda: de sobra para imprimirla a tamaño de firma. */
const LADO_MAXIMO = 1200;

let _canvas;
async function canvasLib() {
  if (_canvas !== undefined) return _canvas;
  try {
    _canvas = await import('@napi-rs/canvas');
  } catch {
    _canvas = null;
    console.warn('[firma] @napi-rs/canvas no disponible: la firma se guarda sin limpiar.');
  }
  return _canvas;
}

/**
 * Devuelve `{ buffer, mime }` con la firma limpia en PNG, o la original si no se
 * pudo procesar. Lanza 400 si la imagen no tiene ningún trazo (está en blanco).
 */
export async function limpiarFirma(buffer, mime) {
  const lib = await canvasLib();
  if (!lib) return { buffer, mime };
  let img;
  try {
    img = await lib.loadImage(buffer);
  } catch (e) {
    console.warn(`[firma] no se pudo leer la imagen: ${e.message}`);
    return { buffer, mime };
  }

  const escala = Math.min(1, LADO_MAXIMO / Math.max(img.width, img.height));
  const ancho = Math.max(1, Math.round(img.width * escala));
  const alto = Math.max(1, Math.round(img.height * escala));
  const lienzo = lib.createCanvas(ancho, alto);
  const ctx = lienzo.getContext('2d');
  ctx.drawImage(img, 0, 0, ancho, alto);
  const datos = ctx.getImageData(0, 0, ancho, alto);
  const px = datos.data;

  let x0 = ancho, y0 = alto, x1 = -1, y1 = -1;
  for (let y = 0; y < alto; y++) {
    for (let x = 0; x < ancho; x++) {
      const i = (y * ancho + x) * 4;
      const brillo = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      const factor = brillo >= BLANCO ? 0 : brillo <= TINTA ? 1 : (BLANCO - brillo) / (BLANCO - TINTA);
      px[i + 3] = Math.round(px[i + 3] * factor);
      if (px[i + 3] > 40) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw badRequest('La imagen de la firma parece estar en blanco: no se encontró ningún trazo.');

  ctx.putImageData(datos, 0, 0);
  x0 = Math.max(0, x0 - MARGEN);
  y0 = Math.max(0, y0 - MARGEN);
  x1 = Math.min(ancho - 1, x1 + MARGEN);
  y1 = Math.min(alto - 1, y1 + MARGEN);
  const recorte = lib.createCanvas(x1 - x0 + 1, y1 - y0 + 1);
  recorte.getContext('2d').drawImage(lienzo, x0, y0, x1 - x0 + 1, y1 - y0 + 1, 0, 0, x1 - x0 + 1, y1 - y0 + 1);
  return { buffer: await recorte.encode('png'), mime: 'image/png' };
}
