// Elimina por completo el esquema sst (para recrearlo). Destructivo.
import { pool } from '../src/config/db.js';
await pool.query('DROP SCHEMA IF EXISTS sst CASCADE');
console.log('Esquema sst eliminado.');
await pool.end();
