import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs/promises';
import { pool } from './src/config/db.js';
import { storage } from './src/services/storage.service.js';
import { placeholderSoporte } from './db/placeholders.js';

// 1 · Archivo real para un soporte YA sembrado (solo escribe en storage local).
const s = await pool.query("SELECT id, url_archivo, nombre_original, mime FROM sst.archivos_soporte WHERE id='cf47bd5b-5ea2-424d-b334-70662c307b9c'");
if (s.rows[0]) {
  const buf = await placeholderSoporte(s.rows[0].nombre_original, s.rows[0].mime, 'OS-DEMO');
  const full = path.join(process.cwd(), 'storage', s.rows[0].url_archivo);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, buf);
  console.log('archivo escrito para soporte sembrado:', s.rows[0].url_archivo, buf.length, 'bytes');
}

// 2 · OS desechable para ejercitar verificar/rechazar de punta a punta.
const arl = await pool.query('SELECT id FROM sst.arls LIMIT 1');
const admin = await pool.query("SELECT id FROM sst.usuarios WHERE rol='admin' LIMIT 1");
const prof = await pool.query("SELECT id FROM sst.profesionales WHERE estado='Activo' LIMIT 1");
const ord = await pool.query(
  "INSERT INTO sst.ordenes_servicio (codigo, arl_id, numero_orden, empresa_nombre, horas_asignadas, estado, profesional_asignado_id, metadatos_extraccion) VALUES ('OS-TEST-M7', $1, 'TEST-M7-'||floor(random()*100000)::text, 'Empresa de prueba M7', 4, 'EN VERIFICACIÓN', $2, '{}'::jsonb) RETURNING id",
  [arl.rows[0].id, prof.rows[0].id]);
const id = ord.rows[0].id;
await pool.query('INSERT INTO sst.historial_estados_orden (orden_id, estado_nuevo, cambiado_por) VALUES ($1,$2,$3)', [id, 'EN VERIFICACIÓN', admin.rows[0].id]);
const buf = await placeholderSoporte('acta_prueba.pdf', 'application/pdf', 'OS-TEST-M7');
const key = await storage.put('supports', 'acta_prueba.pdf', buf);
const sup = await pool.query(
  "INSERT INTO sst.archivos_soporte (orden_id, url_archivo, nombre_original, mime, tamano_bytes) VALUES ($1,$2,'acta_prueba.pdf','application/pdf',$3) RETURNING id",
  [id, key, buf.length]);
console.log(JSON.stringify({ ordenPrueba: id, soporte: sup.rows[0].id }));
await pool.end();
