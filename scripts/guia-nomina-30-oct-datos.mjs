// 30-oct-2026 · Datos INVENTADOS en jdd_dev para las capturas de la guía de nómina (días, auxilio, salud y pensión).
//   node --import tsx scripts/guia-nomina-30-oct-datos.mjs [--borrar]
// Crea dos terceros y sus fichas de empleado: uno de mes completo (2.200.000) y otra que entra el 19-oct.
// Además renueva el token de herramientas/ayuda-capturas/sesion.json (mismo usuario, firmado de nuevo).
import fs from 'node:fs';
import path from 'node:path';
import { pool } from '../src/config/db.js';
import { signToken } from '../src/utils/security.js';
import { crearEmpleado } from '../src/modules/nomina/empleados.service.js';

const DEMO = [
  { doc: '1000000101', nombres: 'CAROLINA', apellidos: 'RUIZ DEMO', salario: 2_200_000, ingreso: '2025-03-01', cargo: 'Auxiliar contable' },
  { doc: '1000000102', nombres: 'VALENTINA', apellidos: 'ORTIZ DEMO', salario: 1_750_905, ingreso: '2026-10-19', cargo: 'Auxiliar administrativa' },
];

async function borrar() {
  for (const d of DEMO) {
    await pool.query(`DELETE FROM sst.nomina_liquidaciones WHERE empleado_id IN (SELECT e.id FROM sst.empleados e JOIN sst.terceros t ON t.id = e.tercero_id WHERE t.numero_documento = $1)`, [d.doc]);
    await pool.query(`DELETE FROM sst.empleados WHERE tercero_id IN (SELECT id FROM sst.terceros WHERE numero_documento = $1)`, [d.doc]);
    await pool.query(`DELETE FROM sst.terceros WHERE numero_documento = $1`, [d.doc]);
  }
}

try {
  await borrar();
  if (!process.argv.includes('--borrar')) {
    const usuario = (await pool.query(`SELECT id, correo, rol, nombre, es_maestro FROM sst.usuarios WHERE es_maestro ORDER BY creado_en LIMIT 1`)).rows[0];
    const td = (await pool.query(`SELECT id FROM sst.tipos_documento_identidad WHERE codigo_dian = '13'`)).rows[0].id;
    const mun = (await pool.query(`SELECT id FROM sst.municipios WHERE codigo_dian = '52001'`)).rows[0].id;
    for (const d of DEMO) {
      const t = (await pool.query(
        `INSERT INTO sst.terceros (tipo_persona, tipo_documento_id, numero_documento, nombres, apellidos, direccion, municipio_id, es_proveedor)
         VALUES ('NATURAL', $1, $2, $3, $4, 'CALLE 18 25-40', $5, true) RETURNING id`, [td, d.doc, d.nombres, d.apellidos, mun],
      )).rows[0].id;
      await crearEmpleado({ tercero_id: t, cargo: d.cargo, salario: d.salario, fecha_ingreso: d.ingreso, metodo_pago: '10', correo: 'empleado@ejemplo.com' }, usuario.id);
      console.log(`✓ ${d.nombres} ${d.apellidos}`);
    }
    const ses = path.resolve('..', 'jdd_consultores_app', 'herramientas', 'ayuda-capturas', 'sesion.json');
    const s = JSON.parse(fs.readFileSync(ses, 'utf8'));
    s.token = signToken(usuario);
    fs.writeFileSync(ses, JSON.stringify(s));
    console.log('✓ sesión renovada');
  } else console.log('✓ borrados');
} finally {
  await pool.end();
}
