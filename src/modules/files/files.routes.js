import { Router } from 'express';
import { pool } from '../../config/db.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authRequired } from '../../middleware/auth.js';
import { PDFDocument } from 'pdf-lib';
import { badRequest, notFound } from '../../utils/httpError.js';
import { storage } from '../../services/storage.service.js';

const router = Router();
router.use(authRequired);

/**
 * Lee del almacenamiento distinguiendo "no está el archivo" de un fallo real.
 *
 * La BD guarda solo la key; si el binario no está donde dice (archivo borrado,
 * bucket distinto, datos sembrados sin subir el fichero) el driver lanza ENOENT
 * y el cliente recibía un 500 opaco. Un 404 con el nombre del archivo le dice al
 * administrador exactamente qué pasó.
 */
async function leerArchivo(key, etiqueta) {
  try {
    return await storage.get(key);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.name === 'NoSuchKey') {
      throw notFound(`El archivo "${etiqueta}" ya no está disponible en el almacenamiento.`);
    }
    throw err;
  }
}

/**
 * Tipos de los formatos que se generan. Hoy todos son PDF, pero el tipo se
 * deduce de la key en vez de darlo por hecho: el registro de asistencia de
 * Colmena llegó como documento de Word y servirlo como `application/pdf` lo
 * entregaba roto.
 */
const MIME_POR_EXTENSION = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

// Descargar un formato generado (M4).
router.get('/documents/:id/download', asyncHandler(async (req, res) => {
  const r = await pool.query(`SELECT * FROM sst.documentos_generados WHERE id=$1`, [req.params.id]);
  const doc = r.rows[0];
  if (!doc) throw notFound('Documento no encontrado');
  const buffer = await leerArchivo(doc.url_pdf, doc.tipo);
  // La extensión real está en la key almacenada; `tipo` solo dice qué formato es
  // ('asistencia'), no en qué se generó.
  const ext = (/\.([a-z0-9]+)$/i.exec(doc.url_pdf || '')?.[1] || 'pdf').toLowerCase();
  res.setHeader('Content-Type', MIME_POR_EXTENSION[ext] || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${doc.tipo}.${ext}"`);
  res.send(buffer);
}));

// VER-01 · Visualizar un soporte EN LÍNEA sin descargar (inline).
router.get('/supports/:id/view', asyncHandler(async (req, res) => {
  const r = await pool.query(`SELECT * FROM sst.archivos_soporte WHERE id=$1`, [req.params.id]);
  const file = r.rows[0];
  if (!file) throw notFound('Soporte no encontrado');
  // Se sirve con el nombre CANÓNICO ('acta.pdf'), no con el que traía el móvil
  // del profesional: es el que ve el administrador si guarda el archivo, y el
  // que no mete comillas ni símbolos raros en la cabecera.
  const nombre = file.nombre_archivo || file.nombre_original || 'soporte';
  const buffer = await leerArchivo(file.url_archivo, nombre);
  res.setHeader('Content-Type', file.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${nombre.replace(/"/g, '')}"`);
  res.send(buffer);
}));

/**
 * 30-sep-2026 · Varios soportes de UNA orden unidos en un solo PDF, en el orden
 * que eligió quien los descarga (p. ej. acta + asistencia para radicar ante la
 * ARL, que los pide en un único archivo).
 *
 * Las fotos (JPG/PNG) entran como una página cada una, ajustadas a una hoja
 * carta con margen y giradas a horizontal si son apaisadas. Un PDF protegido se
 * abre con `ignoreEncryption`: el profesional a veces escanea con apps que lo
 * cifran sin contraseña, y rechazarlo dejaría la descarga sin ese documento.
 */
const CARTA = [612, 792];
const MARGEN = 24;

router.post('/supports/unir', asyncHandler(async (req, res) => {
  const ordenId = String(req.body?.orden_id ?? '').trim();
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((x) => String(x ?? '').trim()).filter(Boolean) : [];
  if (!ordenId) throw badRequest('Falta la orden.');
  if (!ids.length) throw badRequest('Elija al menos un documento para descargar.');
  if (new Set(ids).size !== ids.length) throw badRequest('Un documento aparece dos veces en la lista.');

  const r = await pool.query(
    `SELECT s.id, s.url_archivo, s.mime, s.nombre_archivo, s.nombre_original, o.codigo
       FROM sst.archivos_soporte s JOIN sst.ordenes_servicio o ON o.id = s.orden_id
      WHERE s.orden_id = $1 AND s.id = ANY($2::uuid[])`,
    [ordenId, ids],
  );
  // Los ids tienen que ser TODOS de esta orden: mezclar soportes de dos visitas
  // en un mismo PDF es justo el error que no se nota hasta que la ARL lo devuelve.
  if (r.rows.length !== ids.length) throw badRequest('Algún documento no es de esta orden o ya no existe.');
  const porId = new Map(r.rows.map((f) => [f.id, f]));

  const salida = await PDFDocument.create();
  for (const id of ids) {
    const f = porId.get(id);
    const nombre = f.nombre_archivo || f.nombre_original || 'soporte';
    const buffer = await leerArchivo(f.url_archivo, nombre);
    const mime = String(f.mime || '').toLowerCase();
    try {
      if (mime === 'application/pdf') {
        const origen = await PDFDocument.load(buffer, { ignoreEncryption: true });
        const paginas = await salida.copyPages(origen, origen.getPageIndices());
        paginas.forEach((p) => salida.addPage(p));
      } else if (mime === 'image/jpeg' || mime === 'image/png') {
        const img = mime === 'image/png' ? await salida.embedPng(buffer) : await salida.embedJpg(buffer);
        const horizontal = img.width > img.height;
        const [ancho, alto] = horizontal ? [CARTA[1], CARTA[0]] : CARTA;
        const escala = Math.min((ancho - 2 * MARGEN) / img.width, (alto - 2 * MARGEN) / img.height, 1);
        const w = img.width * escala;
        const h = img.height * escala;
        const pagina = salida.addPage([ancho, alto]);
        pagina.drawImage(img, { x: (ancho - w) / 2, y: (alto - h) / 2, width: w, height: h });
      } else {
        throw badRequest(`"${nombre}" no es PDF ni imagen y no se puede unir.`);
      }
    } catch (err) {
      if (err?.statusCode) throw err;
      throw badRequest(`No se pudo leer "${nombre}" para unirlo: el archivo parece dañado.`);
    }
  }

  const bytes = await salida.save();
  const codigo = r.rows[0].codigo || 'orden';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${codigo}-soportes.pdf"`);
  res.send(Buffer.from(bytes));
}));

export default router;
