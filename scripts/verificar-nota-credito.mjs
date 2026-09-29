// Uso: node --import tsx scripts/verificar-nota-credito.mjs (backend en :4000, SANDBOX de Factus).
// ⚠️ Emite de verdad en el sandbox: factura de la prefactura 170501 y su anulación.
// Prueba de A2-01 contra el SANDBOX de Factus, por la API de ORBITA (como la pantalla).
import { pool } from '../src/config/db.js';
import { signToken } from '../src/utils/security.js';
const admin = (await pool.query("select * from sst.usuarios where correo='admin@jdd.com'")).rows[0];
const H = { Authorization: `Bearer ${signToken(admin)}`, 'Content-Type': 'application/json' };
const api = async (m, u, b) => { const r = await fetch('http://localhost:4000/api' + u, { method: m, headers: H, body: b && JSON.stringify(b) }); const j = await r.json().catch(() => ({})); if (r.status >= 400) throw new Error(`${m} ${u} → ${r.status} ${j.error}`); return [r.status, j]; };
const ordenes = async () => (await pool.query("select codigo, estado_cobro, cobro_numero_factura from sst.ordenes_servicio where codigo in ('OS-2026-0002','OS-2026-0003','OS-2026-0004') order by 1")).rows.map((o) => `${o.codigo}:${o.estado_cobro}${o.cobro_numero_factura ? '(' + o.cobro_numero_factura + ')' : ''}`).join('  ');

const bol = (await pool.query("select id from sst.arls where nombre ilike 'bol%'")).rows[0].id;
const pf = (await pool.query("select id from sst.prefacturas where numero_prefactura='170501'")).rows[0].id;
console.log('0) órdenes:', await ordenes());

let [, j] = await api('POST', '/facturacion/borradores', { arl_id: bol, prefactura_id: pf });
const facturaId = j.data.id;
console.log('1) borrador factura', j.data.reference_code, 'total a pagar', j.data.totales.total_a_pagar);
let [st, e] = await api('POST', `/facturacion/documentos/${facturaId}/emitir`);
console.log('2) emitir factura →', st, e.message);
console.log('   órdenes:', await ordenes());

[, j] = await api('GET', `/facturacion/borradores/${facturaId}`);
const it = j.data.items[0];
[, j] = await api('POST', `/facturacion/documentos/${facturaId}/nota-credito`, { causal: '1', lineas: [{ item_id: it.id, cantidad: 1 }] });
console.log('3) NC parcial (causal 1, 1 ítem):', j.data.reference_code, '| bruto', j.data.totales.total_bruto, '| retenciones', j.data.totales.total_retenciones, '| a pagar', j.data.totales.total_a_pagar, '| advertencia:', j.data.advertencia);
await api('DELETE', `/facturacion/borradores/${j.data.id}`);
console.log('   borrador parcial eliminado');

[, j] = await api('POST', `/facturacion/documentos/${facturaId}/nota-credito`, { causal: '2', observaciones: 'Prueba de anulación en sandbox (A2-01).' });
const notaId = j.data.id;
console.log('4) NC anulación:', j.data.reference_code, 'sobre', j.data.referencia_numero, '| a pagar', j.data.totales.total_a_pagar);
[st, e] = await api('POST', `/facturacion/documentos/${notaId}/emitir`);
console.log('5) emitir NC →', st, e.message);

[, j] = await api('GET', `/facturacion/borradores/${facturaId}`);
console.log('6) factura ahora:', j.data.estado, '| últimos eventos:', j.data.eventos.slice(-2).map((x) => x.codigo).join(', '));
console.log('   órdenes:', await ordenes());
[, j] = await api('GET', `/facturacion/borradores/${notaId}`);
console.log('7) nota:', j.data.estado, j.data.prefijo, j.data.numero, '| CUDE', (j.data.cufe || '').slice(0, 20) + '…', '| pdf:', !!j.data.pdf_path, 'xml:', !!j.data.xml_path);
for (const t of ['pdf', 'xml']) { const r = await fetch(`http://localhost:4000/api/facturacion/documentos/${notaId}/archivo/${t}`, { headers: H }); console.log(`   descarga ${t}:`, r.status, (await r.arrayBuffer()).byteLength, 'bytes'); }
const hist = (await pool.query("select o.codigo, h.estado_anterior, h.estado_nuevo, h.observacion from sst.historial_cobro_orden h join sst.ordenes_servicio o on o.id=h.orden_id where h.cambiado_en > now() - interval '10 minutes' order by h.cambiado_en")).rows;
console.log('8) historial de cobro:', hist.map((h) => `${h.codigo} ${h.estado_anterior}→${h.estado_nuevo}`).join(' | '));
const [, rel] = await api('GET', '/facturacion/por-facturar');
console.log('9) de nuevo por facturar:', rel.data.pagadores.find((p) => p.arl_nombre.startsWith('Bol')).grupos.map((g) => g.n_facturables + '/' + g.lineas.length).join(' '));
await pool.end();
