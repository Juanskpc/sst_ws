/**
 * Aplica UN archivo de `db/migraciones/` contra la base a la que apunte el .env
 * (hoy `jdd_dev` por el túnel). No siembra nada: es lo que se quiere cuando
 * `npm run migrate` volvería a crear los profesionales y tipos de orden de demo.
 *
 *   node scripts/aplicar-migracion.mjs db/migraciones/2026-10-24-arl-sura.sql
 */
import fs from 'node:fs';
import { pool } from '../src/config/db.js';

const archivo = process.argv[2];
if (!archivo) {
  console.error('Uso: node scripts/aplicar-migracion.mjs <archivo.sql>');
  process.exit(1);
}
try {
  await pool.query(fs.readFileSync(archivo, 'utf8'));
  console.log(`✔ ${archivo} aplicada`);
} catch (err) {
  console.error('✘', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
