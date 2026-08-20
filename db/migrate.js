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

/**
 * Separa el antiguo admin único en dos cuentas:
 *  1. CLIENTE  — conserva el documento con el que ya inicia sesión (y su
 *     contraseña actual); se actualizan correo y celular. Rol 'admin' intacto.
 *  2. MAESTRO  — Administrador Maestro (es_maestro=TRUE), exclusivo del equipo
 *     de desarrollo; único que administra usuarios internos.
 * Idempotente: re-ejecutar no duplica ni pisa contraseñas existentes.
 */
async function seedCuentas(client) {
  const { cliente, maestro } = env;

  // --- 1 · Cuenta del cliente (por documento; el correo puede haber cambiado) --
  const upd = await client.query(
    `UPDATE sst.usuarios
        SET correo = $2, telefono = $3, es_maestro = FALSE, rol = 'admin',
            actualizado_en = now()
      WHERE documento_identidad = $1
      RETURNING id`,
    [cliente.documento, cliente.email, cliente.celular]
  );
  if (upd.rowCount > 0) {
    console.log(`  → cliente actualizado: documento ${cliente.documento} · ${cliente.email} · cel ${cliente.celular}`);
  } else {
    const hash = await bcrypt.hash(cliente.password, 10);
    await client.query(
      `INSERT INTO sst.usuarios (nombre, correo, documento_identidad, contrasena_hash, rol, telefono)
       VALUES ($1, $2, $3, $4, 'admin', $5)
       ON CONFLICT (correo) DO NOTHING`,
      [cliente.nombre, cliente.email, cliente.documento, hash, cliente.celular]
    );
    console.log(`  → cliente creado: documento ${cliente.documento} · ${cliente.email}`);
  }

  // --- 2 · Administrador Maestro (correo liberado por el paso anterior) -------
  const hashMaestro = await bcrypt.hash(maestro.password, 10);
  const ins = await client.query(
    `INSERT INTO sst.usuarios (nombre, correo, documento_identidad, contrasena_hash, rol, es_maestro)
     VALUES ($1, $2, $3, $4, 'admin', TRUE)
     ON CONFLICT (correo) DO NOTHING
     RETURNING id`,
    [maestro.nombre, maestro.email, maestro.documento, hashMaestro]
  );
  if (ins.rowCount > 0) {
    console.log(`  → Administrador Maestro creado: ${maestro.email} · documento ${maestro.documento}`);
  } else {
    // Ya existía: asegura el flag sin tocar su contraseña.
    await client.query(
      `UPDATE sst.usuarios SET es_maestro = TRUE, rol = 'admin', actualizado_en = now()
       WHERE correo = $1 AND NOT es_maestro`,
      [maestro.email]
    );
    console.log(`  → Administrador Maestro ya existía: ${maestro.email} · flag asegurado`);
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

/**
 * EST-01 · Valores de enum que hay que añadir ANTES de `schema.sql`.
 *
 * Postgres no deja usar un valor de enum en la misma transacción en la que se
 * agrega, y `schema.sql` va en una sola sentencia múltiple —es decir, una sola
 * transacción— con vistas que ya nombran 'FINALIZADA'. Así que el ALTER se hace
 * aparte y antes. En una base nueva no hace nada: el tipo todavía no existe y
 * el CREATE TYPE de `schema.sql` ya trae el valor.
 */
async function asegurarEstados(client) {
  const existe = await client.query(
    `SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'sst' AND t.typname = 'estado_orden'`
  );
  if (!existe.rowCount) return;
  await client.query(`ALTER TYPE sst.estado_orden ADD VALUE IF NOT EXISTS 'FINALIZADA' AFTER 'EJECUTADA'`);
  console.log("  → estado 'FINALIZADA' asegurado en sst.estado_orden");
}

async function main() {
  console.log('== Migración JD&D IA-Core ==');
  const client = await pool.connect();
  try {
    await asegurarEstados(client);
    await runSqlFile(client, 'schema.sql');
    await runSqlFile(client, 'seed.sql');
    await seedCuentas(client);
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
