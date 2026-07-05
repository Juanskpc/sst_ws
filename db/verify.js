import { pool } from '../src/config/db.js';
const q = async (label, sql) => {
  const r = await pool.query(sql);
  console.log('\n== ' + label + ' ==');
  console.table(r.rows);
};
await q('Tablas', `SELECT table_name FROM information_schema.tables WHERE table_schema='sst' AND table_type='BASE TABLE' ORDER BY 1`);
await q('Vistas', `SELECT table_name FROM information_schema.views WHERE table_schema='sst' ORDER BY 1`);
await q('Funciones', `SELECT routine_name FROM information_schema.routines WHERE routine_schema='sst' ORDER BY 1`);
await q('ARLs', `SELECT nombre, formato_origen FROM sst.arls ORDER BY nombre`);
await q('Usuarios', `SELECT nombre, correo, rol::text FROM sst.usuarios`);
await pool.end();
