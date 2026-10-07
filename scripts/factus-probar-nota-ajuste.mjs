// A4-03 · Prueba de NOTA DE AJUSTE a un documento soporte contra el SANDBOX.
// Confirma el payload de POST /v2/adjustment-notes/validate y la forma de la
// respuesta antes de construir el servicio. Se niega a correr fuera del sandbox.
//
// Uso: node scripts/factus-probar-nota-ajuste.mjs <numero-del-DS> [carpeta-salida]
//   p. ej. node scripts/factus-probar-nota-ajuste.mjs SEDS984000927
import fs from 'node:fs';
import path from 'node:path';
import { esSandbox, estaConfigurado, request } from '../src/modules/facturacion/adaptadores/factus.cliente.js';

const [numeroDs, CARPETA_SALIDA] = process.argv.slice(2);
if (!numeroDs) throw new Error('Indique el número del documento soporte a ajustar.');
if (!estaConfigurado()) throw new Error('Faltan las variables FACTUS_* en el .env');
if (!esSandbox()) throw new Error('Este script solo corre contra el sandbox.');
const guardar = (nombre, datos) => {
  if (!CARPETA_SALIDA) return;
  fs.mkdirSync(CARPETA_SALIDA, { recursive: true });
  fs.writeFileSync(path.join(CARPETA_SALIDA, nombre), JSON.stringify(datos, null, 2));
};

const rangos = await request('GET', '/v2/numbering-ranges', undefined, { query: { 'filter[document]': '25' } });
const na = (rangos.data?.data ?? []).filter((r) => r.is_active);
console.log('Rangos de nota de ajuste:', na.map((r) => `${r.id} ${r.prefix} sig ${r.current}`).join(' | '));

const ds = (await request('GET', `/v2/support-documents/${numeroDs}`)).data;
console.log(`DS ${ds.number}: total ${ds.totals?.total}, proveedor ${ds.provider?.identification}`);
const cuerpo = {
  reference_code: `ORB-NA-PRUEBA-${Date.now()}`,
  numbering_range_id: na[0]?.id,
  support_document_number: ds.number,
  correction_concept_code: '2', // anulación
  observation: 'Prueba ORBITA A4-03: anulación del documento soporte',
  payment_details: [{ payment_form: '1', payment_method_code: '10', amount: String(ds.totals?.total) }],
  provider: {
    identification_document_code: '31',
    identification: ds.provider.identification,
    dv: ds.provider.dv,
    legal_organization_code: ds.provider.legal_organization?.code ?? '2',
    names: ds.provider.names,
    address: ds.provider.address,
    country_code: 'CO',
    municipality_code: ds.provider.municipality?.code,
  },
  items: ds.items.map((it) => ({
    code_reference: it.code_reference, name: it.name, quantity: it.quantity, discount_rate: '0.00',
    price: it.price, unit_measure_code: '94', standard_code: '999',
    taxes: [{ code: '01', rate: '0.00', is_excluded: true }],
  })),
};
guardar('na-peticion.json', cuerpo);
try {
  const r = await request('POST', '/v2/adjustment-notes/validate', cuerpo);
  guardar('na-respuesta.json', r);
  const d = r.data ?? {};
  console.log('Claves de data:', Object.keys(d).join(', '));
  const nota = d.adjustment_note ?? d;
  console.log(JSON.stringify({ number: nota.number, cude: nota.cude ?? nota.cuds ?? nota.cufe, is_validated: nota.is_validated, total: nota.totals?.total, errors: nota.errors }, null, 2));
  if (nota.number) {
    const pdf = await request('GET', `/v2/adjustment-notes/${nota.number}/download-pdf`);
    console.log('PDF:', Boolean(pdf.data?.pdf_base_64_encoded));
    const xml = await request('GET', `/v2/adjustment-notes/${nota.number}/download-xml`).catch((e) => ({ error: e.message }));
    console.log('XML:', Boolean(xml.data?.xml_base_64_encoded), xml.error ?? '');
    const ver = await request('GET', `/v2/adjustment-notes/${nota.number}`).catch((e) => ({ error: e.message }));
    console.log('GET por número:', ver.error ?? Object.keys(ver.data ?? {}).join(', '));
  }
} catch (e) {
  console.error('✗', e.status ?? '', e.message);
  if (e.detalle) console.error(JSON.stringify(e.detalle, null, 2));
  process.exitCode = 1;
}
