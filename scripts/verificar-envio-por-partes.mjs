// Verifica la petición del 26-nov-2026 (OS-2026-0324, SURA, 15 h por partes: «al enviar los formatos
// vuelve y se envía el del 11») contra jdd_dev y por HTTP, contra una instancia con el correo en consola:
//   PORT=4010 EMAIL_DRIVER=console SMTP_HOST="" node --import tsx src/server.js > api4010.log
//   node --import tsx scripts/verificar-envio-por-partes.mjs
// Crea dos asesores y una orden de ARL SURA DESECHABLES (2099) de 15 h y comprueba que:
//   · el primer envío parcial manda la sesión 1 y la marca como enviada;
//   · la vista previa del segundo envío enseña solo la sesión nueva («2 de 2») y lista la 1 como ya enviada;
//   · el segundo envío manda solo lo nuevo; repetirlo sin cambios no le escribe a nadie;
//   · mover una sesión enviada la cancela (por su UID) y manda la nueva;
//   · «reenviar todo» vuelve a mandar todas;
//   · al sumar un asesor adicional, solo a él le llega correo.
// Al final BORRA todo lo creado.
import 'dotenv/config';
import { pool } from '../src/config/db.js';
import { signToken } from '../src/utils/security.js';

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

const sura = (await q(`SELECT id FROM sst.arls WHERE nombre ILIKE '%sura%' LIMIT 1`))[0].id;
const s1 = { fecha: '2099-03-11', hora_inicio: '08:00', hora_fin: '14:00' };
const s2 = { fecha: '2099-03-25', hora_inicio: '08:00', hora_fin: '12:00' };
const s2b = { fecha: '2099-03-26', hora_inicio: '08:00', hora_fin: '12:00' };
let prof; let co; let orden;
try {
  prof = (await q(`INSERT INTO sst.profesionales (nombre, correo, valor_hora) VALUES ('ZZ PARTES PRINCIPAL','zzpartes1@example.com',28000) RETURNING id`))[0].id;
  co = (await q(`INSERT INTO sst.profesionales (nombre, correo, valor_hora) VALUES ('ZZ PARTES COASESOR','zzpartes2@example.com',28000) RETURNING id`))[0].id;
  orden = (await q(
    `INSERT INTO sst.ordenes_servicio (arl_id, codigo, empresa_nombre, tipo_actividad, horas_asignadas, estado, fecha_vencimiento, modalidad_ejecucion)
     VALUES ($1,'OS-ZZ-2611','ZZ EMPRESA POR PARTES','CAPACITACION',15,'SIN PROGRAMAR'::sst.estado_orden,'2099-12-31','PRESENCIAL') RETURNING id`,
    [sura]))[0].id;
  const asignar = (franjas, extra = {}) => http('POST', `/orders/${orden}/assign`, { profesional_id: prof, franjas, enviar_parcial: true, ...extra });
  const previa = (franjas, extra = {}) => http('POST', `/orders/${orden}/assign/preview`, { profesional_id: prof, franjas, enviar_parcial: true, ...extra });
  const marcas = async () => q(`SELECT to_char(fecha,'YYYY-MM-DD') fecha, enviada_en IS NOT NULL AS enviada, ics_uid FROM sst.franjas_visita WHERE orden_id=$1 ORDER BY fecha`, [orden]);

  console.log('— 1. Primer envío: sesión del 11 —');
  let r = await asignar([s1]);
  ok(r.status === 200 && r.body.formatos_generados >= 1, 'primer envío con formatos', `${r.status} ${r.body?.message} · ${r.body?.formatos_generados}`);
  let m = await marcas();
  ok(m.length === 1 && m[0].enviada && m[0].ics_uid, 'la sesión 1 queda marcada como enviada y con UID', JSON.stringify(m));
  const uid1 = m[0].ics_uid;

  console.log('— 2. Vista previa del segundo envío —');
  r = await previa([s1, s2]);
  const nombres = (r.body?.data?.formatos ?? []).map((f) => f.nombre);
  ok(r.status === 200 && nombres.length >= 1 && nombres.every((n) => !/11-03-2099/.test(n)), 'la vista previa no trae la sesión del 11', JSON.stringify(nombres));
  ok(nombres.some((n) => /sesion 2 de 2 \(25-03-2099\)/.test(n)), 'trae la sesión nueva como «2 de 2»');
  ok(r.body?.data?.ya_enviadas?.length === 1 && r.body.data.ya_enviadas[0].fecha === s1.fecha, 'lista la sesión 1 como ya enviada');

  console.log('— 3. Segundo envío —');
  r = await asignar([s1, s2]);
  ok(r.status === 200 && r.body.data.documentos.length === nombres.length, 'manda solo lo nuevo', `${r.body?.message} · ${r.body?.data?.documentos?.length}`);
  m = await marcas();
  ok(m.every((f) => f.enviada) && m[0].ics_uid === uid1, 'las dos marcadas; la 1 conserva su UID');

  console.log('— 4. Repetir sin cambios —');
  r = await asignar([s1, s2]);
  ok(r.status === 200 && r.body.sin_cambios === true && r.body.correo_enviado === false, 'no le escribe a nadie', r.body?.message);

  console.log('— 5. Mover la sesión 2 al 26 —');
  r = await previa([s1, s2b]);
  ok(r.body?.data?.canceladas?.length === 1 && r.body.data.canceladas[0].fecha === s2.fecha, 'la vista previa anuncia la cancelación del 25');
  r = await asignar([s1, s2b]);
  ok(r.status === 200 && r.body.data.documentos.length >= 1 && r.body.data.documentos.every((d) => !/11-03-2099/.test(d.url_pdf ?? '')), 'manda la sesión movida', r.body?.message);

  console.log('— 6. Reenviar todo —');
  r = await previa([s1, s2b], { reenviar_todo: true });
  ok((r.body?.data?.formatos ?? []).length >= 2 && r.body.data.ya_enviadas.length === 0, 'la vista previa trae las dos sesiones', `${r.body?.data?.formatos?.length}`);

  console.log('— 7. Sumar un asesor adicional —');
  const s3 = { fecha: '2099-03-27', hora_inicio: '08:00', hora_fin: '11:00', profesional_id: co };
  r = await asignar([s1, s2b, s3], { coasesores: [{ profesional_id: co, horas: 3 }] });
  ok(r.status === 200 && /ZZ PARTES COASESOR/.test(r.body?.message ?? '') && !/ZZ PARTES PRINCIPAL/.test(r.body?.message ?? ''),
    'solo le escribe al asesor adicional', r.body?.message);
} finally {
  if (orden) {
    for (const t of ['franjas_visita', 'documentos_generados', 'enlaces_publicos', 'historial_estados_orden', 'orden_coasesores']) {
      await pool.query(`DELETE FROM sst.${t} WHERE orden_id=$1`, [orden]).catch((e) => console.warn(t, e.message));
    }
    await pool.query(`DELETE FROM sst.ordenes_servicio WHERE id=$1`, [orden]).catch((e) => console.warn('orden', e.message));
  }
  for (const id of [prof, co].filter(Boolean)) {
    await pool.query(`DELETE FROM sst.profesionales WHERE id=$1`, [id]).catch((e) => console.warn('prof', e.message));
  }
  await pool.end();
}
console.log(fallos ? `\n${fallos} comprobación(es) FALLARON` : '\nTodo OK');
process.exit(fallos ? 1 : 0);
