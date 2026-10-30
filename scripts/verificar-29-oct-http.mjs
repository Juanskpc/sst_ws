// Verifica las peticiones del 29-oct-2026 (cuentas de cobro) contra jdd_dev, de punta a punta y POR HTTP,
// contra una instancia del backend con el correo en consola:
//   PORT=4010 EMAIL_DRIVER=console SMTP_HOST="" node --import tsx src/server.js > api4010.log
//   node --import tsx scripts/verificar-29-oct-http.mjs
// Crea un asesor y tres órdenes de Bolívar DESECHABLES (marzo de 2099), genera su cuenta y prueba: referencia
// «9134803-67» y tema del registro de asistencia; horas editables; línea manual; quitar una orden (queda apartada);
// y que «Generar» otra vez conserva horas editadas y manuales y NO vuelve a meter la apartada; al devolverla, sí.
// Al final BORRA todo lo creado.
import 'dotenv/config';
import { pool } from '../src/config/db.js';
import { signToken } from '../src/utils/security.js';

const API = process.env.API_PRUEBA ?? 'http://localhost:4010/api';
const PERIODO = '2099-03';
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
  return { status: r.status, body: tipo.includes('json') ? await r.json() : await r.arrayBuffer() };
};

const bolivar = (await q(`SELECT id FROM sst.arls WHERE nombre ILIKE 'Bol%var'`))[0].id;
let prof; const ordenes = [];

try {
  prof = (await q(`INSERT INTO sst.profesionales (nombre, correo, valor_hora) VALUES ('ZZ PRUEBA 29OCT','zz29oct@example.com',28000) RETURNING id`))[0].id;
  const crear = async (codigo, sec, tema, horas) => (await q(
    `INSERT INTO sst.ordenes_servicio (arl_id, codigo, codigo_cronograma, secuencia, empresa_nombre, tipo_actividad,
       tema_actividad, horas_asignadas, estado, profesional_asignado_id, valor_hora_cobro, fecha_ejecucion,
       soportes_aceptados_en, fecha_vencimiento)
     VALUES ($1,$2,'9134803',$3,'ZZ EMPRESA 29OCT','CAP SEGURIDAD VIAL',$4,$5,'FINALIZADA'::sst.estado_orden,$6,28000,'2099-03-10',now(),'2099-12-31')
     RETURNING id`, [bolivar, codigo, sec, tema, horas, prof]))[0].id;
  ordenes.push(await crear('OS-ZZ-2901', '67', 'Plan estratégico de seguridad vial', 19));
  ordenes.push(await crear('OS-ZZ-2902', '68', null, 2));
  ordenes.push(await crear('OS-ZZ-2903', '69', 'Pausas activas', 3));
  const [o1, o2] = ordenes;

  console.log('— Generar —');
  let r = await http('POST', '/precuentas/generate', { periodo: PERIODO, profesional_id: prof });
  ok(r.status === 201 && r.body.data?.generadas?.length === 1, 'genera la cuenta', r.status + ' ' + r.body.message);
  const pcId = r.body.data.generadas[0].id;
  r = await http('GET', `/precuentas/${pcId}`);
  let d = r.body.data;
  const l1 = d.items.find((i) => i.orden_id === o1);
  const l2 = d.items.find((i) => i.orden_id === o2);
  ok(l1.orden_referencia === '9134803-67', 'referencia «9134803-67»', l1.orden_referencia);
  ok(l1.actividad === 'Plan estratégico de seguridad vial', 'actividad = tema del registro de asistencia', l1.actividad);
  ok(l2.actividad === 'CAP SEGURIDAD VIAL', 'sin tema, el título de la ARL', l2.actividad);

  console.log('— Horas, manual y quitar —');
  r = await http('PATCH', `/precuentas/${pcId}/items`, { items: [{ id: l1.id, horas: 9 }] });
  ok(r.status === 200 && Number(r.body.data.items.find((i) => i.orden_id === o1).horas) === 9, 'horas 19 → 9', r.status);
  r = await http('POST', `/precuentas/${pcId}/items`, { actividad: 'Gestión SG-SST en Comtexaco', empresa_nombre: 'COMTEXACO', horas: 4, valor_hora: 30000 });
  ok(r.status === 201 && r.body.data.items.some((i) => i.manual), 'línea manual agregada', r.status + ' ' + (r.body.message ?? ''));
  r = await http('DELETE', `/precuentas/${pcId}/items/${l2.id}`, { motivo: 'Pagada en septiembre por fuera' });
  ok(r.status === 200 && !r.body.data.items.some((i) => i.orden_id === o2), 'orden quitada', r.status);
  ok(r.body.data.excluidas?.[0]?.motivo === 'Pagada en septiembre por fuera', 'aparece apartada con su motivo');
  const totalAntes = Number(r.body.data.total_monto);
  ok(totalAntes === 9 * 28000 + 3 * 28000 + 4 * 30000, 'total = 9 h + 3 h de orden + manual', String(totalAntes));

  console.log('— Generar otra vez —');
  r = await http('POST', '/precuentas/generate', { periodo: PERIODO, profesional_id: prof });
  ok(r.status === 201, 'regenera', r.status + ' ' + r.body.message);
  d = (await http('GET', `/precuentas/${pcId}`)).body.data;
  ok(Number(d.items.find((i) => i.orden_id === o1)?.horas) === 9, 'conserva las 9 h editadas');
  ok(d.items.some((i) => i.manual && i.actividad === 'Gestión SG-SST en Comtexaco'), 'conserva la línea manual');
  ok(!d.items.some((i) => i.orden_id === o2), 'la apartada NO vuelve');
  ok(Number(d.total_monto) === totalAntes, 'mismo total', String(d.total_monto));
  const resumen = (await http('GET', '/precuentas/resumen?anio=2099')).body.data;
  ok(!resumen.some((f) => f.profesional_id === prof && !f.precuenta_id), 'no queda trabajo pendiente suelto');

  console.log('— Devolver al cobro —');
  r = await http('DELETE', `/precuentas/exclusiones/${o2}/${prof}`);
  ok(r.status === 200, 'la orden vuelve al cobro', r.status);
  await http('POST', '/precuentas/generate', { periodo: PERIODO, profesional_id: prof });
  d = (await http('GET', `/precuentas/${pcId}`)).body.data;
  ok(d.items.some((i) => i.orden_id === o2) && (d.excluidas ?? []).length === 0, 'al generar entra de nuevo');

  r = await http('GET', `/precuentas/${pcId}/pdf`);
  ok(r.status === 200 && r.body.byteLength > 1000, 'PDF', `${r.status} ${r.body.byteLength} bytes`);
} finally {
  if (prof) {
    await q(`DELETE FROM sst.precuentas WHERE profesional_id=$1`, [prof]);
    await q(`DELETE FROM sst.cobro_exclusiones WHERE profesional_id=$1`, [prof]);
    await q(`DELETE FROM sst.notificaciones WHERE datos->>'orden_id' = ANY($1)`, [ordenes.map(String)]);
    await q(`DELETE FROM sst.ordenes_servicio WHERE id = ANY($1)`, [ordenes]);
    await q(`DELETE FROM sst.profesionales WHERE id=$1`, [prof]);
    const resto = await q(`SELECT count(*)::int AS n FROM sst.profesionales WHERE nombre='ZZ PRUEBA 29OCT'`);
    console.log(`\nLimpieza: ${resto[0].n === 0 ? 'todo borrado' : 'QUEDÓ ALGO'}`);
  }
  await pool.end();
}
console.log(fallos ? `${fallos} FALLO(S)` : 'Todo OK');
process.exit(fallos ? 1 : 0);
