import multer from 'multer';
import { badRequest } from '../utils/httpError.js';

// Guardamos en memoria; el servicio de storage decide destino (local/S3).
const storage = multer.memoryStorage();

/**
 * Límites, en un solo sitio y exportados: el manejador de errores los necesita
 * para poder decir "pesa más de 4 MB" en vez del "File too large" que multer
 * trae de fábrica, y un límite escrito dos veces se desincroniza el día que
 * cambie.
 *
 * 4 MB vale para TODO lo que entra: las órdenes que se importan y los soportes
 * del profesional. Ojo con lo segundo — la compresión de imágenes corre DESPUÉS
 * de este filtro, así que una foto de móvil a resolución máxima (5-12 MB en
 * cualquier teléfono reciente) se rechaza sin llegar a comprimirse. Es una
 * decisión del cliente, no un efecto colateral: el mensaje de error explica cómo
 * bajarla de peso.
 */
export const LIMITE_ARCHIVO_MB = 4;
export const MAXIMO_SOPORTES = 10;
const LIMITE_BYTES = LIMITE_ARCHIVO_MB * 1024 * 1024;

const IMPORT_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'application/vnd.ms-excel', // xls
  'application/pdf',
]);

const SUPPORT_MIMES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
]);

// Algunos clientes envían .xlsx como application/octet-stream (o sin tipo); en ese
// caso se acepta por extensión para no rechazar archivos válidos.
const EXT_IMPORT = /\.(xlsx|xls|pdf)$/i;
const GENERIC_MIMES = new Set(['application/octet-stream', 'binary/octet-stream', '']);

export const uploadImport = multer({
  storage,
  limits: { fileSize: LIMITE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (IMPORT_MIMES.has(file.mimetype)) return cb(null, true);
    if (GENERIC_MIMES.has(file.mimetype) && EXT_IMPORT.test(file.originalname || '')) {
      return cb(null, true);
    }
    // badRequest ⇒ 400 con mensaje legible (un Error suelto caería en el 500 genérico).
    cb(badRequest('Formato no soportado. Use Excel (.xlsx/.xls) o PDF.'));
  },
});

const soportes = multer({
  storage,
  limits: { fileSize: LIMITE_BYTES, files: MAXIMO_SOPORTES },
  fileFilter: (_req, file, cb) => {
    if (SUPPORT_MIMES.has(file.mimetype)) return cb(null, true);
    // Decir SOLO "permitidos: PDF, JPG, PNG" deja colgado el caso más común de
    // todos: las fotos de un iPhone se guardan como HEIC y el profesional no
    // tiene por qué saber qué es eso ni dónde se cambia.
    cb(badRequest(
      'Ese archivo no se puede subir: solo se admiten PDF, JPG o PNG. ' +
      'Si es una foto de iPhone (.heic), en Ajustes › Cámara › Formatos elija ' +
      '"Más compatible", o compártala por WhatsApp y suba la copia.',
    ));
  },
});

/**
 * Los soportes llegan en un campo POR CASILLA del portal, no en un montón
 * anónimo: así el servidor sabe qué es cada archivo sin depender del orden en
 * que el navegador los serialice, que no es algo sobre lo que se pueda apostar.
 *
 * `files` se mantiene como cajón de compatibilidad: una pestaña del portal
 * abierta desde antes del cambio sigue enviando por ahí, y esos archivos no se
 * pueden perder — entran como categoría 'otros'.
 */
export const uploadSupports = soportes.fields([
  { name: 'acta', maxCount: 5 },
  { name: 'asistencia', maxCount: 5 },
  { name: 'evidencias', maxCount: 5 },
  // Informe técnico o de gestión: lo piden las asistencias técnicas de Bolívar,
  // las asesorías de AXA y las de Colmena (ver `entrega-arl.service.js`). El
  // campo se declara SIEMPRE aunque la orden no lo pida — multer rechaza con un
  // error críptico ("Unexpected field") cualquier campo que no esté en la lista,
  // y quién puede mandarlo lo decide el servidor más adelante, con un mensaje
  // que se entiende.
  { name: 'informe', maxCount: 5 },
  { name: 'files', maxCount: 10 },
]);
