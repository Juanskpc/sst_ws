/**
 * Datos de DEMOSTRACIÓN para los pantallazos del Centro de ayuda (27-oct-2026). Todo inventado: empresas «… DEMO»,
 * órdenes de ARL SURA 10998001–10998006 y los tres asesores de demostración de la base (Carlos Mendoza, Diana Patiño,
 * Jorge Salazar). Recorre el flujo REAL por la API —importar, confirmar, asignar, subir soportes, aceptarlos— para que
 * cada orden quede en el estado que enseña su tema del manual:
 *   10998001 SIN PROGRAMAR · 10998002 PROGRAMADA · 10998003 programación PARCIAL (8 de 12 h, dos asesores)
 *   10998004 EJECUTADA con soportes · 10998005 FINALIZADA (entra a la cuenta de cobro) · 10998006 EJECUTADA (para devolver)
 *
 * Requiere el backend en marcha CON EL CORREO EN CONSOLA (manda correos de asignación):
 *   PORT=4000 EMAIL_DRIVER=console SMTP_HOST="" node --import tsx src/server.js
 *   node --import tsx scripts/generar-datos-ayuda.mjs
 * Es idempotente: si las órdenes ya existen, no las vuelve a importar y solo completa los estados que falten.
 * SOLO para jdd_dev: se niega a correr si DATABASE_URL no apunta a jdd_dev.
 */
import 'dotenv/config';
import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { pool } from '../src/config/db.js';
import { signToken } from '../src/utils/security.js';

if (!/jdd_dev/.test(process.env.DATABASE_URL ?? '')) {
  console.error('Este script solo corre contra jdd_dev.');
  process.exit(1);
}
const API = process.env.API_AYUDA ?? 'http://localhost:4000/api';
const q = async (sql, p) => (await pool.query(sql, p)).rows;
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const admin = (await q(`SELECT id, nombre, correo FROM sst.usuarios WHERE rol='admin' ORDER BY creado_en LIMIT 1`))[0];
const token = signToken({ id: admin.id, correo: admin.correo, rol: 'admin', nombre: admin.nombre });
const http = async (metodo, ruta, cuerpo, form) => {
  const r = await fetch(API + ruta, {
    method: metodo,
    headers: { Authorization: `Bearer ${token}`, ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
    body: form ?? (cuerpo ? JSON.stringify(cuerpo) : undefined),
  });
  const body = await r.json().catch(() => ({}));
  if (r.status >= 400) throw new Error(`${metodo} ${ruta} → ${r.status} ${body.error ?? body.message ?? ''}`);
  return body;
};

// [orden, empresa, tarea, producto, clasificación, horas, centro]
const P = '170-SISTEMA DE GESTIÓN EN SST';
const FILAS = [
  ['10998001', 'FERRETERÍA EL TORNILLO DEMO S.A.S', 'PRACTICAS SEGURAS', P, 'CAPACITACIÓN', 4, 'BODEGA'],
  ['10998002', 'HOTEL LAS AMÉRICAS DEMO S.A.S', 'PLAN DE PREPARACION Y RESPUESTA ANTE EMERGENCIAS', '112-PLAN DE EMERGENCIAS', 'ASESORÍA', 6, 'RECEPCIÓN'],
  ['10998003', 'COOPERATIVA LÁCTEA DEMO', 'INSPECCIONES DE SEGURIDAD', '115-INSPECCIONES DE SEGURIDAD', 'ASESORÍA', 12, 'PLANTA'],
  ['10998004', 'LABORATORIO SANTA CLARA DEMO S.A.S', 'PRACTICAS SEGURAS', P, 'CAPACITACIÓN', 3, 'LABORATORIO'],
  ['10998005', 'MOLINO EL SOL DEMO S.A.S', 'PRACTICAS SEGURAS', P, 'CAPACITACIÓN', 2, 'PRODUCCIÓN'],
  ['10998006', 'TALLER EL PISTÓN DEMO S.A.S', 'PRACTICAS SEGURAS', P, 'CAPACITACIÓN', 2, 'TALLER'],
];

async function excelSura() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('ESTADO TAREA');
  ws.addRow(['REPORTE ESTADO DE LAS TAREAS']);
  ws.addRow([]);
  ws.addRow(['ORDEN', 'FECHA APROBACION OC ', 'FECHA NTREGA INICIAL DE LA OC', 'FECHA ENTREGA FINAL DE LA OC', 'CONTRATO', 'EMPRESA', 'TAREA', 'PRODUCTO',
    'CLASIFICACION', 'PROFESIONAL', 'PRESTADOR', 'CANTIDAD PEDIDA', 'CANTIDAD SIN PROGRAMAR', 'CANTIDAD PROGRAMADA', 'CANTIDAD CUMPLIDA',
    'CANTIDAD FACTURADA DISTRIBUIDOR', 'CANTIDAD PAGADA ARL SURA', 'ESTADO DE LA TAREA', 'FACTURA PROVEEDOR', 'CENTRO DE TRABAJO', 'OBSERVACIONES DE LA ORDEN']);
  for (const [orden, empresa, tarea, producto, clasif, horas, centro] of FILAS) {
    ws.addRow([orden, '2026/10/20', '2026/11/01', '2026/11/30', '099900001', empresa, tarea, producto, clasif, 'PROFESIONAL DEMO UNO', 'PRESTADOR DEMO',
      String(horas.toFixed(1)), '0.0', String(horas.toFixed(1)), '0.0', '0.0', '0.0', 'PROGRAMADA', '', centro, '']);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Un PDF de una página con un título, para que el visor de soportes muestre algo legible (y claramente de ejemplo). */
async function pdfEjemplo(titulo, empresa) {
  const doc = await PDFDocument.create();
  const pag = doc.addPage([595, 842]);
  const f = await doc.embedFont(StandardFonts.HelveticaBold);
  const g = await doc.embedFont(StandardFonts.Helvetica);
  pag.drawText(titulo, { x: 60, y: 760, size: 22, font: f, color: rgb(0.06, 0.24, 0.4) });
  pag.drawText(empresa, { x: 60, y: 728, size: 13, font: g });
  pag.drawText('DOCUMENTO DE EJEMPLO · DATOS INVENTADOS', { x: 60, y: 700, size: 11, font: g, color: rgb(0.5, 0.5, 0.5) });
  for (let i = 0; i < 12; i++) pag.drawRectangle({ x: 60, y: 640 - i * 36, width: 475, height: 22, borderColor: rgb(0.8, 0.8, 0.8), borderWidth: 1 });
  return Buffer.from(await doc.save());
}

const porNumero = async () => Object.fromEntries((await q(
  `SELECT numero_orden, id, estado::text AS estado, empresa_nombre FROM sst.ordenes_servicio WHERE numero_orden = ANY($1)`,
  [FILAS.map((f) => f[0])],
)).map((o) => [o.numero_orden, o]));

try {
  // ---- 1. Importar y confirmar (solo las que no existan) ----
  let ordenes = await porNumero();
  if (Object.keys(ordenes).length < FILAS.length) {
    const form = new FormData();
    form.append('file', new Blob([await excelSura()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'ayuda-demo-sura.xlsx');
    form.append('forzar', 'true');
    const lote = (await http('POST', '/imports', null, form)).batch;
    for (let i = 0; i < 60; i++) {
      const st = (await http('GET', `/imports/${lote.id}/status`)).data;
      if (st.estado !== 'PROCESANDO') { console.log('lote', st.estado, st.total_ordenes ?? '', st.mensaje_error ?? ''); break; }
      await espera(1000);
    }
    // El tipo de orden es obligatorio para confirmar: capacitación o asesoría según la clasificación de Sura.
    await q(
      `UPDATE sst.borradores_extraccion b
          SET tipo_orden_id = (SELECT id FROM sst.tipos_orden
                                WHERE nombre ILIKE CASE WHEN b.metadatos_extraccion::text ILIKE '%ASESOR%' THEN 'Asesor%' ELSE 'Capacitaci%' END
                                ORDER BY nombre LIMIT 1)
        WHERE lote_importacion_id = $1 AND estado = 'PENDIENTE_REVISION'`, [lote.id]);
    await http('POST', `/imports/${lote.id}/confirm`);
    ordenes = await porNumero();
  }
  console.log('órdenes:', Object.values(ordenes).map((o) => `${o.numero_orden} ${o.estado}`).join(' · '));

  const prof = Object.fromEntries((await q(`SELECT id, nombre FROM sst.profesionales`)).map((p) => [p.nombre.split(' ')[0].toUpperCase(), p.id]));
  const [carlos, diana, jorge] = [prof.CARLOS, prof.DIANA, prof.JORGE];

  /** Asigna si sigue SIN PROGRAMAR. */
  const asignar = async (num, cuerpo) => {
    const o = ordenes[num];
    if (o.estado !== 'SIN PROGRAMAR') return;
    const r = await http('POST', `/orders/${o.id}/assign`, cuerpo);
    console.log(`asignada ${num}: ${r.message}`);
  };
  /** Sube los soportes pedidos por cada enlace de la orden (si sigue PROGRAMADA). */
  const subirSoportes = async (num) => {
    const o = (await porNumero())[num];
    if (o.estado !== 'PROGRAMADA') return;
    const enlaces = await q(`SELECT token FROM sst.enlaces_publicos WHERE orden_id=$1 AND activo`, [o.id]);
    for (const e of enlaces) {
      const portal = await (await fetch(`${API}/public/support/${e.token}`)).json();
      const form = new FormData();
      for (const cas of (portal.data?.casillas ?? [])) {
        const clave = cas.clave ?? cas.id ?? cas.categoria;
        const titulo = cas.opcional ? 'REGISTRO FOTOGRÁFICO' : (cas.etiqueta ?? cas.nombre ?? clave).toUpperCase();
        form.append(clave, new Blob([await pdfEjemplo(titulo, o.empresa_nombre)], { type: 'application/pdf' }), `${clave}.pdf`);
      }
      const r = await fetch(`${API}/public/support/${e.token}/files`, { method: 'POST', body: form });
      console.log(`soportes ${num}: ${r.status}`);
    }
  };
  const franja = (fecha, ini, fin, profesional_id) => ({ fecha, hora_inicio: ini, hora_fin: fin, ...(profesional_id ? { profesional_id } : {}) });

  // ---- 2. Estados ----
  await asignar('10998002', { profesional_id: carlos, franjas: [franja('2026-11-04', '08:00', '12:00'), franja('2026-11-04', '14:00', '16:00')] });
  await asignar('10998003', {
    profesional_id: diana, enviar_parcial: true, coasesores: [{ profesional_id: jorge, horas: 4 }],
    franjas: [franja('2026-11-05', '08:00', '12:00'), franja('2026-11-06', '08:00', '12:00', jorge)],
  });
  await asignar('10998004', { profesional_id: diana, franjas: [franja('2026-10-21', '08:00', '11:00')] });
  await asignar('10998005', { profesional_id: jorge, franjas: [franja('2026-10-22', '14:00', '16:00')] });
  await asignar('10998006', { profesional_id: carlos, franjas: [franja('2026-10-23', '09:00', '11:00')] });
  for (const n of ['10998004', '10998005', '10998006']) await subirSoportes(n);
  const o5 = (await porNumero())['10998005'];
  if (o5.estado === 'EJECUTADA') { await http('POST', `/orders/${o5.id}/verify`); console.log('aceptados 10998005'); }

  console.log('final:', Object.values(await porNumero()).map((o) => `${o.numero_orden} ${o.estado}`).join(' · '));
} finally {
  await pool.end();
}
