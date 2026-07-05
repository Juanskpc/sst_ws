/**
 * Runner de migración: aplica db/schema.sql + db/seed.sql contra la BD (Neon),
 * y luego siembra el usuario admin inicial. Idempotente.
 *
 *   npm run migrate
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { pool } from '../src/config/db.js';
import { env } from '../src/config/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runSqlFile(client, file) {
  const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');
  process.stdout.write(`  → aplicando ${file} ... `);
  await client.query(sql);
  console.log('ok');
}

async function seedAdmin(client) {
  const { nombre, email, documento, password } = env.admin;
  const hash = await bcrypt.hash(password, 10);
  const res = await client.query(
    `INSERT INTO sst.usuarios (nombre, correo, documento_identidad, contrasena_hash, rol)
     VALUES ($1, $2, $3, $4, 'admin')
     ON CONFLICT (correo) DO NOTHING
     RETURNING id`,
    [nombre, email, documento, hash]
  );
  if (res.rowCount > 0) {
    console.log(`  → admin creado: ${email} · documento ${documento}`);
  } else {
    // Asegura el documento en admins ya existentes que no lo tengan.
    await client.query(
      `UPDATE sst.usuarios SET documento_identidad = $2
       WHERE correo = $1 AND documento_identidad IS NULL`,
      [email, documento]
    );
    console.log(`  → admin ya existía: ${email} · documento asegurado (${documento})`);
  }
}

async function seedSampleProfessionals(client) {
  const rows = [
    ['Carlos Mendoza',   'cmendoza@jdd.com', '+57 300 111 2233', 'Tareas de Alto Riesgo', 55000],
    ['Diana Patiño',     'dpatino@jdd.com',  '+57 301 222 3344', 'Higiene Industrial',    50000],
    ['Jorge Salazar',    'jsalazar@jdd.com', '+57 302 333 4455', 'Ergonomía',             48000],
  ];
  for (const [n, e, t, esp, vh] of rows) {
    await client.query(
      `INSERT INTO sst.profesionales (nombre, correo, telefono, especialidad, valor_hora, estado)
       SELECT $1,$2,$3,$4,$5,'Activo'
       WHERE NOT EXISTS (SELECT 1 FROM sst.profesionales WHERE correo = $2)`,
      [n, e, t, esp, vh]
    );
  }
  console.log('  → profesionales de ejemplo asegurados');
}

async function main() {
  console.log('== Migración JD&D IA-Core ==');
  const client = await pool.connect();
  try {
    await runSqlFile(client, 'schema.sql');
    await runSqlFile(client, 'seed.sql');
    await seedAdmin(client);
    await seedSampleProfessionals(client);
    console.log('== Migración completa ✔ ==');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('✖ Error de migración:', err);
  process.exit(1);
});
