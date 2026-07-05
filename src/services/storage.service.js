import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Abstracción de almacenamiento. Guardamos SOLO la "key" en BD (nunca el binario).
 * Driver 'local' (default) escribe en disco; 'as3' se puede enchufar luego.
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

export const storage = {
  /** Sube un buffer y devuelve la key persistible. */
  async put(prefix, filename, buffer) {
    const key = makeKey(prefix, filename);
    if (env.storage.driver === 's3') {
      // Punto de extensión: implementar cliente S3 aquí (aws-sdk).
      throw new Error('STORAGE_DRIVER=s3 no configurado en esta entrega. Use local.');
    }
    return localPut(key, buffer);
  },

  /** Recupera el buffer por key (para descarga/visualización inline). */
  async get(key) {
    if (env.storage.driver === 's3') {
      throw new Error('STORAGE_DRIVER=s3 no configurado en esta entrega.');
    }
    return localGet(key);
  },
};
