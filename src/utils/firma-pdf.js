import { PDFDocument, rgb } from 'pdf-lib';

/**
 * 16-oct-2026 · Estampa la firma digital del profesional en un PDF.
 *
 * Cada formato declara la CAJA donde va la firma, `[página (desde 0), x, y,
 * ancho, alto, opciones?]` en puntos PDF, medida sobre la raya «Firma» del propio formato
 * (`scripts/inspeccionar-formato.mjs --png`). La imagen se encoge para caber
 * entera sin deformarse, se centra a lo ancho y se apoya sobre la raya (abajo de
 * la caja), que es donde se firma a mano.
 *
 * Si la imagen no se puede leer, el formato sale sin firma en vez de no salir:
 * el profesional todavía puede firmarlo a mano.
 */
export async function dibujarFirma(doc, imagen, cajas = []) {
  if (!imagen?.length || !cajas.length) return false;
  let img;
  try {
    // Por la firma del archivo y no por la extensión: el PNG empieza por 0x89 'P'.
    img = imagen[0] === 0x89 && imagen[1] === 0x50 ? await doc.embedPng(imagen) : await doc.embedJpg(imagen);
  } catch (e) {
    console.warn(`[firma] no se pudo leer la imagen de la firma: ${e.message}`);
    return false;
  }
  for (const [indice, x, y, ancho, alto, opciones = {}] of cajas) {
    const pagina = doc.getPages()[indice];
    if (!pagina) continue;
    quitarCamposDeFirma(doc, pagina, [x, y, ancho, alto], opciones);
    const escala = Math.min(ancho / img.width, alto / img.height);
    const w = img.width * escala;
    const h = img.height * escala;
    pagina.drawImage(img, { x: x + (ancho - w) / 2, y, width: w, height: h });
  }
  return true;
}

/**
 * Algunos formatos (el AT-031, la ficha de gestión de AXA) traen un campo de
 * firma digital del propio PDF justo donde va la firma. En la ficha de AXA su
 * recuadro se pinta ENCIMA del contenido y tapaba la imagen. Ya firmado, el campo
 * sobra y se quita. `recuadro: true` vuelve a pintar en la página el recuadro gris
 * que dibujaba el campo (la ficha lo necesita para verse como sus demás casillas;
 * el AT-031 no tenía ninguno).
 */
function quitarCamposDeFirma(doc, pagina, [x, y, ancho, alto], { recuadro = false } = {}) {
  let form;
  try {
    form = doc.getForm();
  } catch {
    return;
  }
  for (const campo of form.getFields()) {
    if (campo.constructor.name !== 'PDFSignature') continue;
    const tapan = campo.acroField.getWidgets().filter((w) => {
      const r = w.getRectangle();
      const enPagina = w.P() ? w.P() === pagina.ref : true;
      return enPagina && r.x < x + ancho && x < r.x + r.width && r.y < y + alto && y < r.y + r.height;
    });
    if (!tapan.length) continue;
    // El recuadro gris claro que pintaba el campo se redibuja en la página, para
    // que el formato se vea igual que los demás recuadros de la ficha.
    for (const w of recuadro ? tapan : []) {
      const r = w.getRectangle();
      pagina.drawRectangle({
        x: r.x, y: r.y, width: r.width, height: r.height,
        color: rgb(0.98, 0.98, 0.98), borderColor: rgb(0.88, 0.88, 0.88), borderWidth: 0.75,
      });
    }
    form.removeField(campo);
  }
}

/** Igual que `dibujarFirma`, sobre un PDF ya guardado: devuelve el PDF nuevo. */
export async function estamparFirma(buffer, imagen, cajas = []) {
  if (!imagen?.length || !cajas.length) return buffer;
  const doc = await PDFDocument.load(buffer);
  if (!(await dibujarFirma(doc, imagen, cajas))) return buffer;
  return Buffer.from(await doc.save());
}
