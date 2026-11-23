// Verifica la petición del 20-nov-2026 («ampliar el horario, mínimo hasta las 12:00am») contra jdd_dev y por HTTP,
// contra una instancia con el correo en consola:
//   PORT=4010 EMAIL_DRIVER=console SMTP_HOST="" node --import tsx src/server.js > api4010.log
//   node --import tsx scripts/verificar-horario-medianoche.mjs
// Crea un asesor y una orden de Bolívar DESECHABLES (marzo de 2099) de 4 h, la programa de 20:00 a 24:00 y comprueba
// que queda PROGRAMADA, que la franja se lee como 24:00 (no 00:00), que la duración es 4 h y no negativa, que la
// fecha programada es 20:00 -05:00 y que se rechazan una franja que cruza la medianoche y una hora fuera de rango.
// Al final BORRA todo lo creado.
import 'dotenv/config';
import { pool } from '../src/config/db.js';
import { signToken } from '../src/utils/security.js';
import { horaAmPm } from '../src/utils/formato.js';

const API = process.env.API_PRUEBA ?? 'http://localhost:4010/api';
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
  const tipo = r.headers.get('content-type') || '';
  return { status: r.status, body: tipo.includes('json') ? await r.json() : null };
};

ok(horaAmPm('24:00') === '12:00 AM', 'horaAmPm(24:00) = 12:00 AM', horaAmPm('24:00'));
ok(horaAmPm('24:00:00') === '12:00 AM', 'horaAmPm(24:00:00) = 12:00 AM');
ok(horaAmPm('20:00') === '08:00 PM', 'horaAmPm(20:00) = 08:00 PM');
ok(horaAmPm('24:30') === '—', 'horaAmPm(24:30) no es una hora');

const bolivar = (await q(`SELECT id FROM sst.arls WHERE nombre ILIKE 'Bol%var'`))[0].id;
let prof; let orden;
try {
  prof = (await q(`INSERT INTO sst.profesionales (nombre, correo, valor_hora) VALUES ('ZZ PRUEBA MEDIANOCHE','zzmedianoche@example.com',28000) RETURNING id`))[0].id;
  orden = (await q(
    `INSERT INTO sst.ordenes_servicio (arl_id, codigo, empresa_nombre, tipo_actividad, horas_asignadas, estado, fecha_vencimiento)
     VALUES ($1,'OS-ZZ-2411','ZZ EMPRESA MEDIANOCHE','CAPACITACION',4,'SIN PROGRAMAR'::sst.estado_orden,'2099-12-31') RETURNING id`,
    [bolivar]))[0].id;

  console.log('— Rechazos —');
  let r = await http('POST', `/orders/${orden}/assign`, { profesional_id: prof, franjas: [{ fecha: '2099-03-02', hora_inicio: '22:00', hora_fin: '02:00' }] });
  ok(r.status === 400 && /medianoche/.test(r.body?.message ?? r.body?.error ?? ''), 'cruzar la medianoche se bloquea', `${r.status} ${r.body?.message ?? r.body?.error}`);
  r = await http('POST', `/orders/${orden}/assign`, { profesional_id: prof, franjas: [{ fecha: '2099-03-02', hora_inicio: '20:30', hora_fin: '24:30' }] });
  ok(r.status === 400, 'fin 24:30 se rechaza', `${r.status} ${r.body?.message ?? r.body?.error}`);
  r = await http('POST', `/orders/${orden}/assign`, { profesional_id: prof, franjas: [{ fecha: '2099-03-02', hora_inicio: '24:00', hora_fin: '24:00' }] });
  ok(r.status === 400, 'inicio 24:00 se rechaza', `${r.status}`);

  console.log('— 20:00 a 24:00 —');
  r = await http('POST', `/orders/${orden}/assign`, { profesional_id: prof, franjas: [{ fecha: '2099-03-02', hora_inicio: '20:00', hora_fin: '24:00' }] });
  ok(r.status === 200, 'programa 20:00–24:00', `${r.status} ${r.body?.message ?? r.body?.error ?? ''}`);
  const fila = (await q(`SELECT estado::text, fecha_programada FROM sst.ordenes_servicio WHERE id=$1`, [orden]))[0];
  ok(fila.estado === 'PROGRAMADA', 'queda PROGRAMADA (4 h de 4 h)', fila.estado);
  ok(new Date(fila.fecha_programada).toISOString() === '2099-03-03T01:00:00.000Z', 'fecha programada = 2099-03-02 20:00 -05:00', new Date(fila.fecha_programada).toISOString());
  const fr = (await http('GET', `/orders/${orden}/franjas`)).body?.data ?? [];
  ok(fr.length === 1 && fr[0].hora_inicio === '20:00' && fr[0].hora_fin === '24:00' && fr[0].fecha === '2099-03-02', 'la franja se lee 2099-03-02 20:00–24:00', JSON.stringify(fr.map(({ fecha, hora_inicio, hora_fin }) => ({ fecha, hora_inicio, hora_fin }))));
  const det = (await http('GET', `/orders/${orden}`)).body?.data;
  ok(det && Number(det.minutos_programados) === 240, 'detalle: minutos programados = 240', String(det?.minutos_programados));
  ok(det && (det.franjas ?? []).some((f) => f.hora_fin === '24:00'), 'detalle: franja con fin 24:00', JSON.stringify(det?.franjas));
  const mins = (await q(`SELECT SUM(EXTRACT(EPOCH FROM (hora_fin - hora_inicio)) / 60)::int AS m, MAX(fecha + hora_fin)::text AS fin FROM sst.franjas_visita WHERE orden_id=$1`, [orden]))[0];
  ok(mins.m === 240 && mins.fin === '2099-03-03 00:00:00', 'BD: 240 min y termina a la medianoche del día siguiente', JSON.stringify(mins));

  console.log('— Dos franjas que acaban a medianoche —');
  r = await http('POST', `/orders/${orden}/assign`, { profesional_id: prof, franjas: [
    { fecha: '2099-03-02', hora_inicio: '18:00', hora_fin: '20:00' },
    { fecha: '2099-03-02', hora_inicio: '22:00', hora_fin: '24:00' },
  ] });
  ok(r.status === 200, 'reprograma 18–20 + 22–24', `${r.status} ${r.body?.message ?? r.body?.error ?? ''}`);
  ok((await q(`SELECT estado::text FROM sst.ordenes_servicio WHERE id=$1`, [orden]))[0].estado === 'PROGRAMADA', 'sigue PROGRAMADA');
} finally {
  if (orden) {
    for (const t of ['franjas_visita', 'historial_estados', 'notificaciones', 'tokens_soporte', 'coasesores_orden']) {
      await pool.query(`DELETE FROM sst.${t} WHERE orden_id=$1`, [orden]).catch(() => {});
    }
    await pool.query(`DELETE FROM sst.ordenes_servicio WHERE id=$1`, [orden]).catch((e) => console.log('No se pudo borrar la orden:', e.message));
  }
  if (prof) await pool.query(`DELETE FROM sst.profesionales WHERE id=$1`, [prof]).catch((e) => console.log('No se pudo borrar el asesor:', e.message));
  await pool.end();
  console.log(fallos ? `\n${fallos} FALLO(S)` : '\nTodo OK');
}
