/**
 * Relleno de una sola vez: `lotes_importacion.hash_archivo` (IMP-09).
 *
 *   node --import tsx db/backfill-hash-lotes.js
 *
 * La huella se calcula al subir, así que sin este paso la comprobación previa
 * de Importar solo reconocería los archivos cargados DESPUÉS del cambio — y los
 * que hoy están repetidos en la bandeja son justamente los de antes. Lee cada
 * archivo original del almacenamiento y guarda su sha256.
 *
 * Es idempotente y no destructivo: solo toca filas con `hash_archivo IS NULL` y
 * salta las que ya no conservan el binario (lotes sembrados o borrados a mano).
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import { pool } from '../src/config/db.js';
import { storage } from '../src/services/storage.service.js';

const pendientes = await pool.query(
  `SELECT id, nombre_archivo, url_archivo FROM sst.lotes_importacion
    WHERE hash_archivo IS NULL AND url_archivo IS NOT NULL
    ORDER BY creado_en`
);
console.log(`Lotes por firmar: ${pendientes.rowCount}`);

let hechos = 0;
let sinArchivo = 0;
for (const lote of pendientes.rows) {
  try {
    const buffer = await storage.get(lote.url_archivo);
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    await pool.query(`UPDATE sst.lotes_importacion SET hash_archivo=$2 WHERE id=$1`, [lote.id, hash]);
    hechos++;
  } catch (err) {
    sinArchivo++;
    console.warn(`  · ${lote.nombre_archivo}: ${err?.message || 'no se pudo leer'}`);
  }
}
console.log(`Firmados ${hechos}; sin archivo ${sinArchivo}.`);
await pool.end();
