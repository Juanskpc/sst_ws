import multer from 'multer';

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

export const uploadImport = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
  fileFilter: (_req, file, cb) => {
    if (IMPORT_MIMES.has(file.mimetype)) return cb(null, true);
    cb(new Error('Formato no soportado. Use Excel (SIPAB) o PDF.'));
  },
});

export const uploadSupports = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    if (SUPPORT_MIMES.has(file.mimetype)) return cb(null, true);
    cb(new Error('Soportes permitidos: PDF, JPG, PNG.'));
  },
});
