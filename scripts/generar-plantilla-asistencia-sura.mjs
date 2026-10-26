/**
 * Dibuja en blanco el «Registro de asistencia a eventos de capacitación» de
 * ARL SURA y lo guarda en `assets/formatos-arl/sura/asistencia.pdf`.
 *
 * Por qué se dibuja y no se copia: el único ejemplo que entregó el cliente
 * (`FormatoEntregaServicios_Asistencia_…-CASA ANDINA.pdf`) ya va diligenciado y
 * firmado por una orden real, y no trae formulario. La plataforma de Sura lo
 * genera por orden; aquí se reproduce su distribución (mismos rótulos, mismas 25
 * filas, mismo pie) con el logo que trae el propio PDF, para poder escribirle
 * encima los datos de la orden como al resto de formatos planos.
 *
 * Las coordenadas de abajo son las MISMAS que usa `CASILLAS_ASISTENCIA_SURA` en
 * `src/services/formatos-arl.service.js`: si se mueve algo aquí, hay que moverlo
 * allá. Se regenera con:
 *
 *   node scripts/generar-plantilla-asistencia-sura.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'formatos-arl', 'sura');
const negro = rgb(0, 0, 0);

const doc = await PDFDocument.create();
const pag = doc.addPage([612, 792]);
const normal = await doc.embedFont(StandardFonts.Helvetica);
const negrita = await doc.embedFont(StandardFonts.HelveticaBold);
const logo = await doc.embedPng(await fs.readFile(path.join(RAIZ, 'logo-arl-sura.png')));

const texto = (t, x, y, size = 6.5, font = normal) => pag.drawText(t, { x, y, size, font, color: negro });
const linea = (x1, y1, x2, y2, grosor = 0.6) => pag.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: grosor, color: negro });

// Encabezado
texto('REGISTRO DE ASISTENCIA A EVENTOS DE CAPACITACIÓN', 50, 742, 9.5, negrita);
pag.drawImage(logo, { x: 398, y: 726, width: 164, height: 164 * (51 / 229) });

// Fila 1: fecha, duración, horas · y orden de compra a la derecha
texto('FECHA DEL EVENTO', 50, 700);
linea(128, 696, 192, 696); texto('DD / MM / AAAA', 134, 689, 5.5);
texto('DURACIÓN:', 198, 700); linea(238, 696, 292, 696);
texto('HORA INICIO:', 298, 700); linea(346, 696, 384, 696);
texto('HORA FIN:', 390, 700); linea(424, 696, 462, 696);
texto('ORDEN DE COMPRA', 480, 700);

// Lugar, producto, tarea, clasificación
for (const [rotulo, y] of [['LUGAR', 666], ['PRODUCTO', 649], ['TAREA', 632], ['CLASIFICACION', 615]]) {
  texto(rotulo, 50, y + 3);
  linea(112, y, 462, y);
}

// Forma de entrega del servicio
texto('FORMA ENTREGA SERVICIO', 480, 668, 6);
pag.drawRectangle({ x: 484, y: 650, width: 8, height: 8, borderColor: negro, borderWidth: 0.6 });
texto('Domicilio', 497, 651.5);
pag.drawRectangle({ x: 484, y: 636, width: 8, height: 8, borderColor: negro, borderWidth: 0.6 });
texto('Virtual', 497, 637.5);

// Tabla de asistentes: 25 filas
const COLUMNAS = [
  ['#', 18], ['NOMBRE DEL ASISTENTE', 125], ['CÉDULA', 65], ['CARGO', 85], ['FIRMA', 85], ['NOMBRE DE LA EMPRESA', 82], ['AUTORIZA TRATAMIENTO DE DATOS PERSONALES', 52],
];
const X0 = 50;
const TOPE = 596;
const ALTO_CAB = 22;
const ALTO_FILA = 17.4;
const FILAS = 25;
const FONDO = TOPE - ALTO_CAB - FILAS * ALTO_FILA;
const ANCHO = COLUMNAS.reduce((s, [, w]) => s + w, 0);

linea(X0, TOPE, X0 + ANCHO, TOPE, 0.9);
linea(X0, TOPE - ALTO_CAB, X0 + ANCHO, TOPE - ALTO_CAB, 0.9);
for (let i = 1; i <= FILAS; i++) {
  const y = TOPE - ALTO_CAB - i * ALTO_FILA;
  linea(X0, y, X0 + ANCHO, y, i === FILAS ? 0.9 : 0.5);
  texto(`${i}.`, X0 + 3, y + 5.5, 6, negrita);
}
let x = X0;
linea(x, TOPE, x, FONDO, 0.9);
for (const [rotulo, ancho] of COLUMNAS) {
  if (rotulo === 'AUTORIZA TRATAMIENTO DE DATOS PERSONALES') {
    texto('AUTORIZA', x + 3, TOPE - 7, 4.6, negrita);
    texto('TRATAMIENTO DE', x + 3, TOPE - 13, 4.6, negrita);
    texto('DATOS PERSONALES', x + 3, TOPE - 19, 4.6, negrita);
  } else if (rotulo === 'NOMBRE DE LA EMPRESA') {
    texto('NOMBRE DE LA EMPRESA', x + 3, TOPE - 13, 5.6, negrita);
  } else if (rotulo !== '#') {
    texto(rotulo, x + (ancho - negrita.widthOfTextAtSize(rotulo, 6.5)) / 2, TOPE - 13, 6.5, negrita);
  }
  x += ancho;
  linea(x, TOPE, x, FONDO, 0.9);
}

// Pie: asesor y firma
const Y_PIE = 100;
pag.drawRectangle({ x: X0, y: Y_PIE - 4, width: ANCHO, height: 34, borderColor: negro, borderWidth: 0.9 });
linea(X0 + 365, Y_PIE - 4, X0 + 365, Y_PIE + 30, 0.9);
linea(X0, Y_PIE + 13, X0 + 365, Y_PIE + 13, 0.9);
texto('NOMBRE ASESOR:', X0 + 40, Y_PIE + 19, 6, negrita);
texto('CÉDULA DEL ASESOR:', X0 + 30, Y_PIE + 3, 6, negrita);
texto('FIRMA:', X0 + 369, Y_PIE + 19, 6, negrita);

// Habeas data
const LEGAL = [
  'Autorizo a Suramericana SA, el tratamiento de mis datos personales con la finalidad de recibir información académica o capacitación, para ser contactado para el ofrecimiento de productos y',
  'servicios y para las demás finalidades contenidas en la política de privacidad que puede ser consultada en www.arlsura.com, donde se encuentran los canales de contacto, y la forma de',
  'ejercer mis derechos a revocar la autorización, conocer, actualizar, rectificar y suprimir mi información',
];
LEGAL.forEach((l, i) => texto(l, X0 + (ANCHO - negrita.widthOfTextAtSize(l, 5)) / 2, 74 - i * 7, 5, negrita));

await fs.writeFile(path.join(RAIZ, 'asistencia.pdf'), await doc.save());
console.log('asistencia.pdf escrito en', RAIZ, '· fondo de la tabla en y =', FONDO.toFixed(1));
