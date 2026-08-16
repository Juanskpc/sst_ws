/**
 * Prueba end-to-end del flujo Fase 1 contra el servidor en http://localhost:4000.
 * Requiere el server corriendo. No modifica el esquema; sí crea datos de demo.
 */
import ExcelJS from 'exceljs';

const BASE = 'http://localhost:4000/api';
let token = '';

const H = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });
const log = (label, obj) => console.log(`\n▶ ${label}\n`, JSON.stringify(obj, null, 2).slice(0, 900));

async function j(method, path, body, headers = H()) {
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function buildSipabXlsx() {
  const n = Date.now().toString().slice(-6); // único por corrida (evita colisión dedup IMP-09)
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('SIPAB');
  ws.addRow(['Codigo Cronograma', 'Secuencia', 'NIT', 'Empresa', 'Actividad Economica', 'Horas', 'Contacto', 'Telefono', 'Correo', 'Descripcion']);
  ws.addRow([`CRN-2026-${n}`, `SEC-${n}`, '900.900.900-1', 'Demo Bolívar S.A.S', 'Construcción de edificios residenciales (CIIU 4111)', 8, 'Laura Gómez', '+57 310 000 0000', 'laura@demo.co', 'Capacitación en trabajo seguro en alturas para cuadrilla de obra.']);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

async function main() {
  // 1 · Login
  const login = await j('POST', '/auth/login', { documento: '1234567890', password: 'Admin123*' }, { 'Content-Type': 'application/json' });
  token = login.token;
  log('Login', { usuario: login.usuario.correo, documento: login.usuario.documento_identidad, rol: login.usuario.rol });

  // 2 · Catálogos + dashboard
  log('ARLs', (await j('GET', '/arls')).data.map((a) => a.nombre));
  const profs = (await j('GET', '/professionals')).data;
  log('Profesionales', profs.map((p) => `${p.nombre} (${p.estado})`));
  log('Dashboard KPIs (antes)', (await j('GET', '/reports/dashboard')).data.kpis);

  // 3 · Importar Excel SIPAB (M2)
  const fd = new FormData();
  fd.append('file', new Blob([await buildSipabXlsx()], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }), 'SIPAB_demo.xlsx');
  const upRes = await fetch(BASE + '/imports', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  const up = await upRes.json();
  if (!upRes.ok) throw new Error('import falló: ' + JSON.stringify(up));
  const batchId = up.batch.id;
  log('Import encolado', { batchId, status: up.batch.status });

  // 4 · Poll estado del lote
  let estado = 'PROCESANDO';
  for (let i = 0; i < 20 && estado === 'PROCESANDO'; i++) {
    await new Promise((r) => setTimeout(r, 400));
    estado = (await j('GET', `/imports/${batchId}/status`)).data.estado;
  }
  log('Lote procesado', { estado });

  // 5 · Obtener borrador y validarlo (M3)
  const batch = (await j('GET', `/imports/${batchId}`)).data;
  const draft = batch.borradores[0];
  log('Borrador extraído', { arl: draft.arl_nombre, conf: draft.confianza_general, estado: draft.estado });
  const validated = (await j('POST', `/drafts/${draft.id}/validate`)).data;
  log('OS validada', { codigo: validated.codigo, estado: validated.estado });
  const orderId = validated.id;

  // 6 · Asignar profesional (M5) → PROGRAMADA + PDFs + correo
  const activo = profs.find((p) => p.estado === 'Activo');
  const assigned = await j('POST', `/orders/${orderId}/assign`, {
    profesional_id: activo.id,
    fecha_programada: '2026-07-10T09:00:00Z',
  });
  log('OS asignada', { estado: assigned.data.estado, docs: assigned.data.documentos.length, support_url: assigned.data.support_url });

  // 7 · Obtener token público (M6) desde el detalle
  const detail = (await j('GET', `/orders/${orderId}`)).data;
  const token6 = detail.enlace_publico.token;
  log('Enlace público', { token: token6.slice(0, 12) + '…', estado: detail.estado });

  // 8 · Portal público: ver OS + subir soporte (SIN login) → EJECUTADA
  const pub = await (await fetch(`${BASE}/public/support/${token6}`)).json();
  log('Portal público (GET)', { empresa: pub.data.empresa_nombre, estado: pub.data.estado });
  const sfd = new FormData();
  sfd.append('files', new Blob([Buffer.from('%PDF-1.4 soporte firmado demo')], { type: 'application/pdf' }), 'acta_firmada.pdf');
  const supRes = await fetch(`${BASE}/public/support/${token6}/files`, { method: 'POST', body: sfd });
  const sup = await supRes.json();
  if (!supRes.ok) throw new Error('soporte falló: ' + JSON.stringify(sup));
  log('Soporte cargado', sup);

  // 9 · Verificar (M7) → EJECUTADA
  const verified = await j('POST', `/orders/${orderId}/verify`, {});
  log('OS verificada', { estado: verified.data.estado });

  // 10 · Regla de oro EST-06: no se puede retroceder desde EJECUTADA
  try {
    await j('POST', `/orders/${orderId}/status`, { estado: 'PROGRAMADA' });
    console.log('\n✖ ERROR: se permitió retroceder desde EJECUTADA (no debería)');
  } catch (e) {
    log('EST-06 OK (bloqueó retroceso)', { error: e.message.split(':').slice(2).join(':').trim() || e.message });
  }

  // 11 · Dashboard después + historial
  log('Dashboard KPIs (después)', (await j('GET', '/reports/dashboard')).data.kpis);
  log('Historial de estados', (await j('GET', `/orders/${orderId}/history`)).data.map((h) => `${h.estado_anterior || '∅'} → ${h.estado_nuevo}`));

  console.log('\n✅ Smoke test completo.');
}

main().catch((e) => { console.error('\n✖ FALLÓ:', e.message); process.exit(1); });
