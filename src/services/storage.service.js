import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Abstracción de almacenamiento. Guardamos SOLO la "key" en BD (nunca el binario).
 * Driver 'local' (default) escribe en disco; 'as3' guarda en la nube (AWS S3 o
 * compatible: DigitalOcean Spaces / Linode) vía el SDK oficial.
 */
const localRoot = path.resolve(process.cwd(), env.storage.localDir);

function makeKey(prefix, filename) {
  const safe = (filename || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
  const stamp = new Date().toISOString().slice(0, 10);
  return `${prefix}/${stamp}/${crypto.randomUUID()}_${safe}`;
}

async function localPut(key, buffer) {
  const full = path.join(localRoot, key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, buffer);
  return key;
}

async function localGet(key) {
  return fs.readFile(path.join(localRoot, key));
}

// --- Driver S3 (nube) ---
// Cliente perezoso: el SDK oficial solo se carga si STORAGE_DRIVER=s3, sin afectar
// la ruta 'local'. Credenciales vía AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
// (leídas por el SDK del entorno).
let _s3 = null;
async function s3Client() {
  if (_s3) return _s3;
  const { S3Client } = await import('@aws-sdk/client-s3');
  _s3 = new S3Client({
    region: env.storage.s3Region,
    // S3-compatible (DigitalOcean Spaces / Linode) cuando se define S3_ENDPOINT.
    ...(env.storage.s3Endpoint ? { endpoint: env.storage.s3Endpoint, forcePathStyle: true } : {}),
  });
  return _s3;
}

async function s3Put(key, buffer) {
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const client = await s3Client();
  await client.send(new PutObjectCommand({ Bucket: env.storage.s3Bucket, Key: key, Body: buffer }));
  return key;
}

async function s3Get(key) {
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const client = await s3Client();
  const res = await client.send(new GetObjectCommand({ Bucket: env.storage.s3Bucket, Key: key }));
  return Buffer.from(await res.Body.transformToByteArray());
}

export const storage = {
  /** Sube un buffer y devuelve la key persistible. */
  async put(prefix, filename, buffer) {
    const key = makeKey(prefix, filename);
    if (env.storage.driver === 's3') return s3Put(key, buffer);
    return localPut(key, buffer);
  },

  /** Recupera el buffer por key (para descarga/visualización inline). */
  async get(key) {
    if (env.storage.driver === 's3') return s3Get(key);
    return localGet(key);
  },
};
