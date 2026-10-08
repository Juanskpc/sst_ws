// 8-oct-2026 · Verifica la FACTURA MANUAL (sin órdenes) y el cambio de forma de pago del
// borrador. Todo dentro de una transacción que termina en ROLLBACK: no deja nada en la base.
//   node --import tsx scripts/verificar-factura-manual.mjs
import { pool } from '../src/config/db.js';
import { cambiarPagoBorrador, crearBorradorManual } from '../src/modules/facturacion/borrador.service.js';

const client = await pool.connect();
let fallos = 0;
const comprobar = (ok, texto) => { console.log(`${ok ? '✓' : '✗'} ${texto}`); if (!ok) fallos += 1; };
const falla = async (fn, texto) => {
  await client.query('SAVEPOINT s');
  try { await fn(); comprobar(false, `${texto} (no falló)`); } catch (e) { comprobar((e.status ?? e.statusCode) < 500, `${texto} → «${e.message}»`); }
  await client.query('ROLLBACK TO SAVEPOINT s');
};

try {
  await client.query('BEGIN');
  const usuario = (await client.query(`SELECT id FROM sst.usuarios ORDER BY creado_en LIMIT 1`)).rows[0].id;
  const cliente = (await client.query(
    `SELECT t.id, COALESCE(t.razon_social, t.nombres) AS nombre, t.es_arl FROM sst.terceros t
      WHERE t.activo AND t.es_cliente AND NOT t.es_arl ORDER BY t.creado_en LIMIT 1`,
  )).rows[0];
  if (!cliente) throw new Error('No hay un tercero cliente (no ARL) para probar.');
  const formas = (await client.query(`SELECT id, codigo_dian FROM sst.formas_pago WHERE activo`)).rows;
  const contado = formas.find((f) => f.codigo_dian === '1');
  const credito = formas.find((f) => f.codigo_dian === '2');
  const medio = (await client.query(`SELECT id, nombre FROM sst.medios_pago WHERE activo AND codigo_dian <> 'ZZZ' ORDER BY codigo_dian LIMIT 1`)).rows[0];
  const ordenesAntes = (await client.query(`SELECT count(*)::int AS n FROM sst.documento_ordenes`)).rows[0].n;

  // 1. Factura manual de contado, con las cifras escritas como las teclea alguien.
  const f = await crearBorradorManual({
    tercero_id: cliente.id,
    items: [
      { descripcion: 'Asesoría en SG-SST (sin orden de servicio)', cantidad: '2', valor_unitario: '1.200.000,50' },
      { descripcion: 'Capacitación en alturas', cantidad: 1, valor_unitario: 350000 },
    ],
    observaciones: 'Factura manual de prueba',
    descuento_comercial_pct: 0, retenciones_ids: [],
    forma_pago_id: contado.id, medio_pago_id: medio.id,
  }, usuario, client);
  const bruto = 2 * 1200000.5 + 350000;
  comprobar(f.estado === 'BORRADOR' && f.tipo === 'FACTURA', `borrador creado para ${cliente.nombre}`);
  comprobar(f.items.length === 2 && f.items.every((it) => it.orden_id === null), 'dos líneas, ninguna atada a una orden');
  comprobar(Number(f.totales.total_bruto) === bruto, `total bruto ${f.totales.total_bruto} = ${bruto}`);
  comprobar(f.items.every((it) => it.producto_id && it.codigo), 'cada línea tomó el producto por defecto del cliente');
  comprobar(f.forma_pago_id === contado.id && f.fecha_vencimiento === f.fecha_emision, 'contado: vence el día de la emisión');
  comprobar(f.medio_pago_id === medio.id, `medio de pago elegido: ${f.medio_pago_nombre}`);
  comprobar(f.eventos.some((e) => /manual/i.test(e.descripcion)), 'el historial dice que es una factura manual');
  comprobar((await client.query(`SELECT count(*)::int AS n FROM sst.documento_ordenes`)).rows[0].n === ordenesAntes, 'no se enlazó ninguna orden');

  // 2. Cambiar la forma de pago del borrador a crédito a 30 días.
  const g = await cambiarPagoBorrador(f.id, { forma_pago_id: credito.id, plazo_dias: 30 }, usuario, client);
  const dias = (new Date(g.fecha_vencimiento) - new Date(g.fecha_emision)) / 86400000;
  comprobar(g.forma_pago_id === credito.id && dias === 30, `crédito a 30 días: vence ${String(g.fecha_vencimiento).slice(0, 10)}`);
  comprobar(g.medio_pago_id === medio.id, 'el medio de pago se conserva si no se manda');
  comprobar(g.totales.total_a_pagar === f.totales.total_a_pagar, 'cambiar el pago no toca el cálculo');
  const h = await cambiarPagoBorrador(f.id, { forma_pago_id: contado.id, plazo_dias: 30 }, usuario, client);
  comprobar(h.fecha_vencimiento === h.fecha_emision, 'de vuelta a contado: el plazo se ignora');

  // 3. Lo que debe rechazar.
  await falla(() => cambiarPagoBorrador(f.id, { forma_pago_id: credito.id }, usuario, client), 'crédito sin plazo');
  await falla(() => crearBorradorManual({ tercero_id: cliente.id, items: [] }, usuario, client), 'sin líneas');
  await falla(() => crearBorradorManual({ tercero_id: cliente.id, items: [{ descripcion: '', cantidad: 1, valor_unitario: 10 }] }, usuario, client), 'línea sin descripción');
  await falla(() => crearBorradorManual({ tercero_id: cliente.id, items: [{ descripcion: 'x', cantidad: 0, valor_unitario: 10 }] }, usuario, client), 'cantidad en cero');
  await falla(() => crearBorradorManual({ tercero_id: '00000000-0000-4000-8000-000000000000', items: [{ descripcion: 'x', cantidad: 1, valor_unitario: 10 }] }, usuario, client), 'cliente que no existe');
  const noCliente = (await client.query(`SELECT id FROM sst.terceros WHERE activo AND NOT es_cliente AND NOT es_arl LIMIT 1`)).rows[0];
  if (noCliente) await falla(() => crearBorradorManual({ tercero_id: noCliente.id, items: [{ descripcion: 'x', cantidad: 1, valor_unitario: 10 }] }, usuario, client), 'tercero que no es cliente');

  // 4. Sin elegir nada: las condiciones del cliente.
  const d = await crearBorradorManual({ tercero_id: cliente.id, items: [{ descripcion: 'Servicio', cantidad: 1, valor_unitario: 100000 }] }, usuario, client);
  comprobar(Boolean(d.forma_pago_id && d.medio_pago_id), `sin elegir: ${d.forma_pago_nombre} · ${d.medio_pago_nombre}`);
} catch (err) {
  console.error(`✗ ${err.stack ?? err.message}`);
  fallos += 1;
} finally {
  await client.query('ROLLBACK');
  client.release();
  await pool.end();
}
console.log(fallos ? `\n${fallos} fallo(s)` : '\nTodo bien (ROLLBACK: no quedó nada en la base).');
process.exit(fallos ? 1 : 0);
