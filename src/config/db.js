import pg from 'pg';
import { env } from './env.js';

const { Pool } = pg;

// Neon requiere SSL. El connection string trae sslmode=require; reforzamos aquí.
export const pool = new Pool({
  connectionString: env.databaseUrl,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
});

// Fija el search_path al esquema del proyecto en cada conexión nueva.
pool.on('connect', (client) => {
  client.query(`SET search_path TO ${env.dbSchema}, public`);
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
