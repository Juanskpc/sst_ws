import multer from 'multer';
import { badRequest } from '../utils/httpError.js';

// Guardamos en memoria; el servicio de storage decide destino (local/S3).
const storage = multer.memoryStorage();

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
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
  fileFilter: (_req, file, cb) => {
    if (IMPORT_MIMES.has(file.mimetype)) return cb(null, true);
    if (GENERIC_MIMES.has(file.mimetype) && EXT_IMPORT.test(file.originalname || '')) {
      return cb(null, true);
    }
    // badRequest ⇒ 400 con mensaje legible (un Error suelto caería en el 500 genérico).
    cb(badRequest('Formato no soportado. Use Excel (.xlsx/.xls) o PDF.'));
  },
});

export const uploadSupports = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    if (SUPPORT_MIMES.has(file.mimetype)) return cb(null, true);
    cb(badRequest('Soportes permitidos: PDF, JPG, PNG.'));
  },
});
