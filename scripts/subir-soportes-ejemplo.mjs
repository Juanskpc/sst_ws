/**
 * Sube soportes de EJEMPLO a órdenes PROGRAMADAS, por el portal público —el
 * mismo camino que usa el profesional—, para recorrer el flujo completo sin
 * tener que fabricar PDF a mano.
 *
 *   node --import tsx scripts/subir-soportes-ejemplo.mjs OS-2026-0001 OS-2026-0002
 *   node --import tsx scripts/subir-soportes-ejemplo.mjs --sin-foto OS-2026-0003
 *
 * Cada soporte es el formato que Orbita generó para esa orden al asignarla (el
 * acta, la asistencia) con una franja "SOPORTE DE EJEMPLO" cruzada; las casillas
 * sin formato (evidencias, informe) van en una hoja simple. `--sin-foto` omite el
 * registro fotográfico, que desde el 30-sep-2026 es opcional: sirve para probar
 * esa regla. Necesita el backend en :4000 (o `API=...`).
 *
 * Nació el 29-sep-2026 como script desechable de una sesión; se guarda aquí
 * porque es la forma rápida de llevar una orden de PROGRAMADA a EJECUTADA en las
 * pruebas de punta a punta (ver `2-pruebas/LEEME.md` en la raíz del monorepo).
 */
import 'dotenv/config';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import { pool } from '../src/config/db.js';
import { storage } from '../src/services/storage.service.js';

const API = process.env.API || 'http://localhost:4000/api';
const args = process.argv.slice(2);
const sinFoto = args.includes('--sin-foto');
const codigos = args.filter((a) => !a.startsWith('--'));
if (!codigos.length) {
  console.error('Uso: node --import tsx scripts/subir-soportes-ejemplo.mjs [--sin-foto] OS-2026-0001 [...]');
  process.exit(1);
}

const hoy = new Date().toISOString().slice(0, 10);

async function soporteEjemplo(ordenId, codigo, casilla) {
  const tipoDoc = { acta: 'seguimiento', asistencia: 'asistencia' }[casilla];
  const gen = tipoDoc && (await pool.query(
    'select url_pdf from sst.documentos_generados where orden_id=$1 and tipo=$2 order by generado_en desc limit 1',
    [ordenId, tipoDoc],
  )).rows[0];
  let doc;
  if (gen && gen.url_pdf.endsWith('.pdf')) {
    doc = await PDFDocument.load(await storage.get(gen.url_pdf));
    try { doc.getForm().flatten(); } catch { /* sin formulario: se usa tal cual */ }
  } else {
    doc = await PDFDocument.create();
    doc.addPage([612, 792]);
  }
  const f = await doc.embedFont(StandardFonts.HelveticaBold);
  const p = doc.getPage(0);
  p.drawText('SOPORTE DE EJEMPLO', { x: 110, y: 330, size: 48, font: f, color: rgb(0.85, 0.1, 0.1), opacity: 0.35, rotate: degrees(35) });
  p.drawText(`${codigo} · ${casilla} · prueba generada el ${hoy} (no es un documento real)`,
    { x: 30, y: 16, size: 8, font: f, color: rgb(0.85, 0.1, 0.1) });
  return Buffer.from(await doc.save());
}

try {
  for (const codigo of codigos) {
    const o = (await pool.query(
      `select o.id, o.estado, o.soportes_requeridos, pl.token
         from sst.ordenes_servicio o
         left join sst.enlaces_publicos pl on pl.orden_id = o.id and pl.activo
        where o.codigo = $1 order by pl.creado_en desc limit 1`,
      [codigo],
    )).rows[0];
    if (!o) { console.error(`${codigo}: no existe`); continue; }
    if (!o.token) { console.error(`${codigo}: no tiene enlace activo (¿está asignada?)`); continue; }
    const casillas = (Array.isArray(o.soportes_requeridos) && o.soportes_requeridos.length
      ? o.soportes_requeridos : ['acta', 'asistencia', 'evidencias'])
      .filter((c) => !(sinFoto && c === 'evidencias'));
    const form = new FormData();
    for (const c of casillas) {
      form.append(c, new Blob([await soporteEjemplo(o.id, codigo, c)], { type: 'application/pdf' }), `${c}-ejemplo.pdf`);
    }
    const r = await fetch(`${API}/public/support/${o.token}/files`, { method: 'POST', body: form });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { console.error(`${codigo}: ${r.status} ${j.error || ''}`); continue; }
    console.log(`${codigo}: soportes subidos (${casillas.join(', ')}) → EJECUTADA`);
  }
} finally {
  await pool.end();
}
