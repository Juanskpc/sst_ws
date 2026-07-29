/**
 * Contenido de archivos de demostración para el seed.
 *
 * Los soportes reales los sube el profesional por el enlace público (M6); estos
 * binarios existen solo para que las pantallas que muestran documentos —en
 * particular el visor de "Verificación de soportes" (VER-01)— tengan algo real
 * que abrir cuando se trabaja con datos sembrados.
 */
import zlib from 'node:zlib';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/** PNG de color sólido, sin dependencias de imagen. */
export function pngSolido(width, height, [r, g, b]) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const fila = y * stride;
    raw[fila] = 0; // filtro "None"
    for (let x = 0; x < width; x++) {
      const p = fila + 1 + x * 3;
      raw[p] = r; raw[p + 1] = g; raw[p + 2] = b;
    }
  }

  const chunk = (tipo, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const cuerpo = Buffer.concat([Buffer.from(tipo, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(cuerpo) >>> 0);
    return Buffer.concat([len, cuerpo, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8 bits por canal
  ihdr[9] = 2; // color verdadero (RGB)

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Soporte firmado de demostración: PDF con espacios de firma, o imagen. */
export async function placeholderSoporte(nombre, mime, codigoOs) {
  if (mime !== 'application/pdf') return pngSolido(720, 440, [206, 219, 238]);

  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  page.drawText('SOPORTE DE DEMOSTRACIÓN', {
    x: 50, y: 780, size: 16, font: bold, color: rgb(0, 0.043, 0.314),
  });
  page.drawText(`${codigoOs} · ${nombre}`, { x: 50, y: 752, size: 11, font });
  page.drawText('Documento generado por el seed de demo (npm run seed:demo).', {
    x: 50, y: 730, size: 10, font, color: rgb(0.35, 0.35, 0.35),
  });
  page.drawText('Firma del profesional: ______________________', { x: 50, y: 200, size: 11, font });
  page.drawText('Firma del cliente:      ______________________', { x: 50, y: 160, size: 11, font });

  return Buffer.from(await doc.save());
}
