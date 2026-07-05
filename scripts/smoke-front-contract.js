/**
 * Verifica el contrato EXACTO que usa la pantalla de Validación IA del front:
 * login → upload → poll → importDetail(borradores) → updateDraft(fields) → validate.
 */
import ExcelJS from 'exceljs';
const BASE = 'http://localhost:4000/api';
let token = '';
const H = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });
async function j(m, p, b) {
  const r = await fetch(BASE + p, { method: m, headers: H(), body: b ? JSON.stringify(b) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${m} ${p} → ${r.status}: ${JSON.stringify(d)}`);
  return d;
}

const login = await (await fetch(BASE + '/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ documento: '1234567890', password: 'Admin123*' }),
})).json();
token = login.token;

const n = Date.now().toString().slice(-6);
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('SIPAB');
ws.addRow(['Codigo Cronograma', 'Secuencia', 'NIT', 'Empresa', 'Actividad', 'Horas', 'Contacto', 'Telefono', 'Correo', 'Descripcion']);
ws.addRow([`CRN-F-${n}`, `SEC-F-${n}`, '900.000.111-2', 'Front Contract S.A.S', 'Obras de ingeniería civil', 5, 'Ana Ruiz', '+57 300 000 1111', 'ana@fc.co', 'Descripción demo']);
const buf = Buffer.from(await wb.xlsx.writeBuffer());

const fd = new FormData();
fd.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'fc.xlsx');
const up = await (await fetch(BASE + '/imports', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd })).json();
const batchId = up.batch.id;
console.log('upload → batch.estado:', up.batch.estado);

let estado = 'PROCESANDO';
for (let i = 0; i < 20 && estado === 'PROCESANDO'; i++) {
  await new Promise((r) => setTimeout(r, 400));
  estado = (await j('GET', `/imports/${batchId}/status`)).data.estado;
}
console.log('poll → estado:', estado);

const detail = (await j('GET', `/imports/${batchId}`)).data;
const draft = detail.borradores[0];
console.log('borrador:', draft.id.slice(0, 8), '| conf:', draft.confianza_general);

// Igual que ValidationComponent.validateOrder(): PUT fields (camel del front → snake) + validate
const fields = {
  codigo_cronograma: { value: draft.metadatos_extraccion.codigo_cronograma.value, confidence: 100 },
  secuencia: { value: draft.metadatos_extraccion.secuencia.value, confidence: 100 },
  nit_nic: { value: '900.000.111-2 (corregido)', confidence: 100 },
  empresa_nombre: { value: 'Front Contract S.A.S', confidence: 100 },
  actividad_economica: { value: 'Obras de ingeniería civil', confidence: 100 },
  horas_asignadas: { value: '5', confidence: 100 },
  contacto_sst_nombre: { value: 'Ana Ruiz', confidence: 100 },
  contacto_sst_telefono: { value: '+57 300 000 1111', confidence: 100 },
  contacto_sst_correo: { value: 'ana@fc.co', confidence: 100 },
  descripcion: { value: 'Descripción demo corregida', confidence: 100 },
};
await j('PUT', `/drafts/${draft.id}`, { fields });
console.log('updateDraft(fields) → OK');
const validated = (await j('POST', `/drafts/${draft.id}/validate`, {})).data;
console.log('validate → OS', validated.codigo, validated.estado, '| nit persistido:', validated.nit_nic);
console.log('\n✅ Contrato de la pantalla de Validación verificado.');
