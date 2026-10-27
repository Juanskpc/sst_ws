// Verifica las peticiones del 26-oct-2026 (P1/P2/P3) contra jdd_dev, de punta a punta y POR HTTP,
// contra una instancia del backend con el correo en consola:
//   PORT=4010 EMAIL_DRIVER=console SMTP_HOST="" node --import tsx src/server.js > api4010.log
//   node --import tsx scripts/verificar-26-oct.mjs [ruta-del-log]
// Crea dos asesores y una orden de Bolívar DESECHABLES (21 h, cronograma 9990041 secuencia 26), reparte 16 h entre
// los dos y prueba: sin envío parcial no sale nada; con envío parcial queda PROGRAMADA y se generan formatos para
// cada asesor; el buscador encuentra «9990041_26» y «9990041-26»; los correos (P2) llevan cronograma, secuencia y
// actividad; el aviso de soportes (P1) dice «9990041_26 EMPRESA…» y no el código OS. Al final BORRA todo lo creado.
import 'dotenv/config';
import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { pool } from '../src/config/db.js';
import { signToken } from '../src/utils/security.js';

const API = process.env.API_PRUEBA ?? 'http://localhost:4010/api';
const LOG = process.argv[2];
let fallos = 0;
const ok = (cond, texto, extra = '') => {
  if (!cond) fallos++;
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${texto}${extra ? ` → ${extra}` : ''}`);
};
const q = async (sql, p) => (await pool.query(sql, p)).rows;

const admin = (await q(`SELECT id, nombre, correo FROM sst.usuarios WHERE rol='admin' AND activo IS NOT FALSE ORDER BY creado_en LIMIT 1`))[0];
const token = signToken({ id: admin.id, correo: admin.correo, rol: 'admin', nombre: admin.nombre });
const http = async (metodo, ruta, cuerpo) => {
  const r = await fetch(API + ruta, {
    method: metodo,
    headers: { Authorization: `Bearer ${token}`, ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const bolivar = (await q(`SELECT id FROM sst.arls WHERE nombre ILIKE 'Bol%var'`))[0].id;
const tipo = (await q(`SELECT id FROM sst.tipos_orden WHERE nombre ILIKE 'Capacitaci%' LIMIT 1`))[0].id;
const inicioLog = LOG && fs.existsSync(LOG) ? fs.statSync(LOG).size : 0;
let ordenId; const profIds = [];

try {
  // ---- Escenario desechable ----
  for (const [nombre, correo] of [['ZZ PRUEBA GEOVANNY', 'zz-geovanny@prueba.invalid'], ['ZZ PRUEBA ROMAN', 'zz-roman@prueba.invalid']]) {
    const id = (await q(`INSERT INTO sst.profesionales (nombre, correo, valor_hora) VALUES ($1,$2,50000) RETURNING id`, [nombre, correo]))[0].id;
    await q(`INSERT INTO sst.profesionales_arl (profesional_id, arl_id, registrado, codigo_registro, vigente_hasta)
             VALUES ($1,$2,true,'ZZ-REG','2099-12-31')`, [id, bolivar]);
    profIds.push(id);
  }
  const [geo, roman] = profIds;
  ordenId = (await q(
    `INSERT INTO sst.ordenes_servicio (arl_id, codigo, codigo_cronograma, secuencia, empresa_nombre, tipo_actividad,
       tema_actividad, horas_asignadas, estado, tipo_orden_id, fecha_vencimiento)
     VALUES ($1,'OS-ZZ-2610','9990041','26','ZZ EMPRESA DE PRUEBA 26OCT','AUTOCUIDADO','Prueba 26-oct',21,
             'SIN PROGRAMAR'::sst.estado_orden,$2,'2099-12-23') RETURNING id`, [bolivar, tipo]))[0].id;

  // 16 h de 21: Geovanny 8 h (dos franjas) y Román 8 h (dos franjas), en 2099 para no chocar con agendas reales.
  const franjas = [
    { fecha: '2099-03-02', hora_inicio: '08:00', hora_fin: '12:00' },
    { fecha: '2099-03-02', hora_inicio: '14:00', hora_fin: '18:00' },
    { fecha: '2099-03-03', hora_inicio: '08:00', hora_fin: '12:00', profesional_id: roman },
    { fecha: '2099-03-03', hora_inicio: '14:00', hora_fin: '18:00', profesional_id: roman },
  ];
  const cuerpo = { profesional_id: geo, franjas, coasesores: [{ profesional_id: roman, horas: 8 }] };

  // ---- P3 · sin envío parcial: se guarda el avance y no sale nada ----
  const a1 = await http('POST', `/orders/${ordenId}/assign`, cuerpo);
  ok(a1.status === 200 && a1.body.completa === false && a1.body.correo_enviado === false,
    'P3 sin «enviar_parcial»: guarda avance, sin correo', `${a1.status} completa=${a1.body.completa} correo=${a1.body.correo_enviado}`);
  ok((await q(`SELECT estado FROM sst.ordenes_servicio WHERE id=$1`, [ordenId]))[0].estado === 'SIN PROGRAMAR', 'P3 sigue SIN PROGRAMAR');

  // ---- P3 · vista previa y envío parcial ----
  const pv = await http('POST', `/orders/${ordenId}/assign/preview`, { ...cuerpo, enviar_parcial: true });
  ok(pv.status === 200, 'P3 vista previa con envío parcial responde', `${pv.status} ${pv.body.error ?? ''}`);
  const a2 = await http('POST', `/orders/${ordenId}/assign`, { ...cuerpo, enviar_parcial: true });
  ok(a2.status === 200 && a2.body.parcial === true, 'P3 envío parcial aceptado',
    `${a2.status} parcial=${a2.body.parcial} programados=${a2.body.minutos_programados} faltan=${a2.body.faltan_minutos} ${a2.body.error ?? a2.body.message ?? ''}`);
  ok(a2.body.faltan_minutos === 300, 'P3 faltan 5 h (300 min)', String(a2.body.faltan_minutos));
  const o = (await q(`SELECT estado, minutos_programados FROM sst.vw_ordenes_expandidas WHERE id=$1`, [ordenId]))[0];
  ok(o.estado === 'PROGRAMADA' && o.minutos_programados === 960, 'P3 orden PROGRAMADA con 960 min en la vista', JSON.stringify(o));
  const docs = await q(`SELECT tipo, count(*)::int n FROM sst.documentos_generados WHERE orden_id=$1 GROUP BY 1`, [ordenId]).catch(() => []);
  console.log('     documentos generados:', JSON.stringify(docs));
  ok(docs.length > 0, 'P3 se generaron formatos');
  const hist = await q(`SELECT motivo FROM sst.historial_estados_orden WHERE orden_id=$1 AND motivo ILIKE '%parcial%'`, [ordenId]).catch(() => []);
  ok(hist.length > 0, 'P3 el historial anota la programación parcial', hist[0]?.motivo);

  // ---- P1 · buscador ----
  for (const termino of ['9990041_26', '9990041-26']) {
    const b = await http('GET', `/orders?q=${encodeURIComponent(termino)}`);
    const lista = b.body.data ?? b.body;
    ok(Array.isArray(lista) && lista.some((x) => x.id === ordenId), `P1 GET /orders?q=${termino} la encuentra`, `${b.status} ${Array.isArray(lista) ? lista.length : 'sin lista'}`);
  }

  // ---- P1 · aviso de soportes al subirlos desde el enlace de cada asesor ----
  const enlaces = await q(`SELECT token, profesional_id FROM sst.enlaces_publicos WHERE orden_id=$1 AND activo`, [ordenId]);
  ok(enlaces.length >= 1, `P1 hay enlace(s) de soportes`, String(enlaces.length));
  const pdf = await PDFDocument.create(); pdf.addPage([200, 200]);
  const bytes = await pdf.save();
  const antesAvisos = new Date();
  for (const e of enlaces) {
    const portal = await (await fetch(`${API}/public/support/${e.token}`)).json();
    const casillas = (portal.data?.casillas ?? []).filter((c) => !c.opcional);
    const form = new FormData();
    for (const c of casillas) form.append(c.clave ?? c.id ?? c.categoria, new Blob([bytes], { type: 'application/pdf' }), 'soporte.pdf');
    const r = await fetch(`${API}/public/support/${e.token}/files`, { method: 'POST', body: form });
    ok(r.status === 201, `P1 subida de soportes (${casillas.map((c) => c.clave ?? c.id ?? c.categoria).join('+')})`, String(r.status));
  }
  const avisos = await q(`SELECT DISTINCT titulo, mensaje FROM sst.notificaciones WHERE datos->>'orden_id'=$1 AND creado_en >= $2`, [ordenId, antesAvisos]);
  for (const a of avisos) console.log(`     aviso: ${a.titulo} — ${a.mensaje}`);
  ok(avisos.length > 0 && avisos.every((a) => a.mensaje.includes('9990041_26') && !a.mensaje.includes('OS-ZZ-2610')),
    'P1 los avisos nombran «9990041_26» y no el código OS');

  // ---- P2 · correos (consola del backend) ----
  if (LOG && fs.existsSync(LOG)) {
    const salida = fs.readFileSync(LOG, 'utf8').slice(inicioLog);
    ok(/9990041/.test(salida) && /\b26\b/.test(salida), 'P2 el correo nombra cronograma y secuencia');
    ok(/AUTOCUIDADO/.test(salida), 'P2 el correo lleva la actividad a desarrollar (tipo_actividad)');
    ok(/zz-geovanny@prueba\.invalid/.test(salida) && /zz-roman@prueba\.invalid/.test(salida), 'P2/P3 salió correo a los dos asesores');
    // P3 · Cada asesor lee SUS horas (8 h de franjas), no lo que sobra de la orden (21 − 8 = 13).
    ok(/Horas: 8\b/.test(salida) && !/Horas: 13\b/.test(salida) && !/le corresponden 13/.test(salida),
      'P3 cada asesor lee sus 8 h (no 13)');
    ok(/se programaron 16 h de las 21 h/.test(salida), 'P3 el correo dice que se programaron 16 de 21 h');
  } else {
    console.log('     (sin log del backend: no se revisan los correos)');
  }
} catch (e) {
  fallos++;
  console.log('FAIL excepción:', e.message);
} finally {
  // ---- Limpieza: todo lo creado (las tablas hijas de la orden borran en cascada) ----
  if (ordenId) {
    const archivos = await q(`SELECT url_archivo FROM sst.archivos_soporte WHERE orden_id=$1
                              UNION ALL SELECT url_pdf FROM sst.documentos_generados WHERE orden_id=$1`, [ordenId]).catch(() => []);
    await q(`DELETE FROM sst.notificaciones WHERE datos->>'orden_id'=$1`, [ordenId]);
    await q(`DELETE FROM sst.ordenes_servicio WHERE id=$1`, [ordenId]);
    console.log(`limpieza: orden borrada (${archivos.length} archivo(s) en storage local quedan en storage/; son de prueba)`);
  }
  if (profIds.length) {
    await q(`DELETE FROM sst.profesionales_arl WHERE profesional_id = ANY($1)`, [profIds]);
    await q(`DELETE FROM sst.profesionales WHERE id = ANY($1)`, [profIds]);
  }
  await pool.end();
  console.log(fallos ? `\n✗ ${fallos} comprobación(es) fallida(s)` : '\n✓ todo OK');
  process.exitCode = fallos ? 1 : 0;
}
