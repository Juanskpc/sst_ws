/**
 * 16-oct-2026 · Carga las tres firmas que envió JD&D (Estefany, José y Dany) en la
 * ficha de cada profesional.
 *
 *   node scripts/cargar-firmas-16-oct.mjs <carpeta> [--confirmar] [estefany=<uuid> …]
 *
 * <carpeta> trae estefany.png, jose.png y dany.png. JD&D no dio apellidos, así que
 * cada nombre se busca entre los profesionales: si sale UNO, se usa; si salen varios
 * o ninguno, NO se carga y se listan los candidatos para elegir a mano con
 * `nombre=<uuid>`. Sin `--confirmar` solo muestra lo que haría. No pisa una firma ya
 * cargada salvo que se pase su `nombre=<uuid>` a propósito.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pool } from '../src/config/db.js';
import { storage } from '../src/services/storage.service.js';
import { limpiarFirma } from '../src/services/firma.service.js';

const args = process.argv.slice(2);
const carpeta = args.find((a) => !a.startsWith('--') && !a.includes('='));
const confirmar = args.includes('--confirmar');
const elegidos = Object.fromEntries(args.filter((a) => a.includes('=')).map((a) => a.split('=')));
if (!carpeta) {
  console.error('Uso: node scripts/cargar-firmas-16-oct.mjs <carpeta> [--confirmar] [nombre=<uuid>]');
  process.exit(1);
}

// Patrón sobre el nombre sin tildes y en mayúsculas (`sst.norm_texto`), palabra entera.
const FIRMAS = [
  { clave: 'estefany', archivo: 'estefany.png', patron: '\\m(ESTEFAN|STEFAN|STEPHAN)' },
  { clave: 'jose', archivo: 'jose.png', patron: '\\mJOSE\\M' },
  { clave: 'dany', archivo: 'dany.png', patron: '\\m(DANY|DANNY|DANI|DANIEL|DANIELA|DANNA)\\M' },
];

let fallos = 0;
for (const f of FIRMAS) {
  const ruta = path.join(carpeta, f.archivo);
  if (!fs.existsSync(ruta)) {
    console.log(`✗ ${f.clave}: no está ${ruta}`);
    fallos++;
    continue;
  }
  let candidatos;
  if (elegidos[f.clave]) {
    candidatos = (await pool.query(
      `SELECT id, nombre, correo, estado, firma_url FROM sst.profesionales WHERE id = $1`, [elegidos[f.clave]],
    )).rows;
  } else {
    candidatos = (await pool.query(
      `SELECT id, nombre, correo, estado, firma_url FROM sst.profesionales
        WHERE upper(sst.norm_texto(nombre)) ~ $1 ORDER BY nombre`, [f.patron],
    )).rows;
  }
  const lista = candidatos.map((c) => `    ${c.id}  ${c.nombre} <${c.correo}> ${c.estado}${c.firma_url ? ' (ya tiene firma)' : ''}`).join('\n');
  if (candidatos.length !== 1) {
    console.log(`✗ ${f.clave}: ${candidatos.length} candidatos; elija con ${f.clave}=<uuid>\n${lista || '    (ninguno)'}`);
    fallos++;
    continue;
  }
  const pro = candidatos[0];
  if (pro.firma_url && !elegidos[f.clave]) {
    console.log(`= ${f.clave}: ${pro.nombre} ya tiene firma; no se toca (para reemplazarla pase ${f.clave}=${pro.id}).`);
    continue;
  }
  if (!confirmar) {
    console.log(`→ ${f.clave}: se cargaría en ${pro.nombre} (${pro.id})`);
    continue;
  }
  // La misma limpieza que la subida desde la pantalla (fondo transparente, sin margen).
  const limpia = await limpiarFirma(fs.readFileSync(ruta), 'image/png');
  const key = await storage.put('firmas-profesionales', `firma-${pro.id}.png`, limpia.buffer);
  await pool.query(
    `UPDATE sst.profesionales
        SET firma_url = $2, firma_mime = $3, firma_actualizada_en = now(), actualizado_en = now()
      WHERE id = $1`, [pro.id, key, limpia.mime],
  );
  if (pro.firma_url) await storage.remove(pro.firma_url).catch(() => {});
  console.log(`✓ ${f.clave}: cargada en ${pro.nombre} (${key})`);
}

await pool.end();
console.log(confirmar ? 'Hecho.' : 'Ensayo: no se cambió nada (agregue --confirmar).');
process.exit(fallos ? 2 : 0);
