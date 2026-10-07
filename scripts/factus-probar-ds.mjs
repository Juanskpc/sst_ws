// A4-01 · Prueba de emisión de DOCUMENTO SOPORTE contra el SANDBOX del proveedor.
//
// Reproduce la forma de un DS de Siigo (DS-1-1316..1327): un profesional persona
// natural, una línea por orden, honorarios sin IVA. Confirma el payload de
// POST /v2/support-documents/validate y la forma de la respuesta antes de
// construir el servicio. Se niega a correr fuera del sandbox.
//
// Uso: node scripts/factus-probar-ds.mjs [carpeta-salida]
import fs from 'node:fs';
import path from 'node:path';
import { esSandbox, estaConfigurado, request } from '../src/modules/facturacion/adaptadores/factus.cliente.js';

const CARPETA_SALIDA = process.argv[2] || null;

if (!estaConfigurado()) throw new Error('Faltan las variables FACTUS_* en el .env');
if (!esSandbox()) throw new Error('Este script solo corre contra el sandbox.');

const guardar = (nombre, datos) => {
  if (!CARPETA_SALIDA) return;
  fs.mkdirSync(CARPETA_SALIDA, { recursive: true });
  fs.writeFileSync(path.join(CARPETA_SALIDA, nombre), JSON.stringify(datos, null, 2));
};

const rangos = await request('GET', '/v2/numbering-ranges', undefined, { query: { 'filter[document]': '24' } });
const ds = (rangos.data?.data ?? []).filter((r) => r.is_active);
console.log('Rangos DS en sandbox:', ds.map((r) => `${r.id} ${r.prefix} ${r.from}-${r.to} sig ${r.current}`).join(' | '));
if (!ds.length) throw new Error('El sandbox no tiene rango de documento soporte activo.');

const hoy = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
const cuerpo = {
  reference_code: `ORB-DS-PRUEBA-${Date.now()}`,
  numbering_range_id: ds[0].id,
  observation: 'Prueba ORBITA A4-01: cuenta de cobro de honorarios',
  payment_details: [{ payment_form: '1', payment_method_code: '10', amount: '412000.00' }],
  provider: {
    identification_document_code: '31', // NIT: la DIAN exige NIT a todo proveedor residente (la cédula + DV)
    identification: '1193035399',
    dv: '6',
    legal_organization_code: '2', // persona natural
    names: 'PROFESIONAL DE PRUEBA',
    address: 'CR 26 N 19 07',
    country_code: 'CO',
    municipality_code: '52001',
    email: 'escalappsystem@gmail.com',
  },
  items: [
    {
      code_reference: 'HON-SST', name: 'Honorarios OS-2026-0001 · 4 h a 58.000', quantity: '4.00',
      discount_rate: '0.00', price: '58000.00', unit_measure_code: '94', standard_code: '999',
      taxes: [{ code: '01', rate: '0.00', is_excluded: true }],
    },
    {
      code_reference: 'HON-SST', name: 'Honorarios OS-2026-0002 · 3 h a 58.000', quantity: '3.00',
      discount_rate: '0.00', price: '58000.00', unit_measure_code: '94', standard_code: '999',
      taxes: [{ code: '01', rate: '0.00', is_excluded: true }],
    },
    {
      code_reference: 'VIA-SST', name: 'Viáticos del periodo', quantity: '1.00',
      discount_rate: '0.00', price: '6000.00', unit_measure_code: '94', standard_code: '999',
      taxes: [{ code: '01', rate: '0.00', is_excluded: true }],
    },
  ],
};
guardar('ds-peticion.json', cuerpo);
console.log(`Fecha CO ${hoy} · enviando ${cuerpo.reference_code}…`);

try {
  const r = await request('POST', '/v2/support-documents/validate', cuerpo);
  guardar('ds-respuesta.json', r);
  const d = r.data ?? {};
  const doc = d.support_document ?? d.bill ?? d;
  console.log('Claves de data:', Object.keys(d).join(', '));
  console.log('Documento:', JSON.stringify({
    id: doc.id, number: doc.number, cuds: doc.cuds ?? doc.cude ?? doc.cufe, status: doc.status,
    is_validated: doc.is_validated, validated: doc.validated, total: doc.total, qr: doc.qr ?? doc.qr_image ? 'sí' : undefined,
  }, null, 2));
  if (doc.number) {
    const ver = await request('GET', `/v2/support-documents/${doc.number}`);
    guardar('ds-ver.json', ver);
    console.log('GET por número: claves', Object.keys(ver.data ?? {}).join(', '));
  }
} catch (e) {
  console.error('✗', e.status ?? '', e.message);
  if (e.detalle || e.datos) console.error(JSON.stringify(e.detalle ?? e.datos, null, 2));
  guardar('ds-error.json', { status: e.status, message: e.message, detalle: e.detalle ?? e.datos ?? null });
  process.exitCode = 1;
}
