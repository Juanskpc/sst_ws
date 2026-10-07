import pg from 'pg';
import { env } from './env.js';

const { Pool } = pg;

// Neon requiere SSL y el connection string trae sslmode=require, así que por
// defecto se refuerza aquí. En el VPS la base es local (127.0.0.1) y el túnel
// TLS no aporta nada: `DB_SSL=false` lo apaga y deja que `pg` y Prisma digan lo
// mismo sobre el mismo sslmode.
const sslDeshabilitado = process.env.DB_SSL === 'false';

export const pool = new Pool({
  connectionString: env.databaseUrl,
  ssl: sslDeshabilitado ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  // 7-oct-2026 · Latido TCP: en desarrollo la base va por un túnel SSH y en
  // producción detrás del cortafuegos; sin latido, una conexión en reposo puede
  // quedar cortada en silencio y la primera consulta que la use falla.
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

// Fija el search_path al esquema del proyecto en cada conexión nueva.
pool.on('connect', (client) => {
  // El fallo de esta consulta no puede quedar sin capturar: tumbaría el proceso.
  client.query(`SET search_path TO ${env.dbSchema}, public`)
    .catch((err) => console.error('[db] No se pudo fijar el search_path:', err.message));
});

pool.on('error', (err) => {
  console.error('[db] Error inesperado en cliente idle:', err.message);
});

/** Helper de consulta simple. */
export function query(text, params) {
  return pool.query(text, params);
}

/** Ejecuta una función con una transacción (BEGIN/COMMIT/ROLLBACK). */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
