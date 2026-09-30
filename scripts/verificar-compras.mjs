// Verifica B5-01 (compras y gastos) y B4-01 (cuentas por pagar, anticipos y
// egresos) contra jdd_dev DENTRO de una transacción con ROLLBACK. Reproduce
// FC-1-10 y RP-1-2 de Siigo (auxiliar de septiembre) y comprueba IVA descontable,
// retención practicada, cruce de anticipos, anulaciones y la conciliación CxP = libro.
// Uso: node --import tsx scripts/verificar-compras.mjs   (requiere el túnel)
import { pool } from '../src/config/db.js';
import { sembrarReglasSiigo } from '../src/modules/contabilidad/reglas.service.js';
import { obtenerComprobante } from '../src/modules/contabilidad/comprobantes.service.js';
import { anularCompra, crearCompra } from '../src/modules/compras/compras.service.js';
import { anularEgreso, crearAnticipo, crearEgreso, propuestaEgreso } from '../src/modules/cartera/pagos.service.js';
import { conciliacion } from '../src/modules/cartera/cartera.service.js';

let fallos = 0;
const igual = (obtenido, esperado, texto) => {
  const ok = JSON.stringify(obtenido) === JSON.stringify(esperado);
  if (!ok) fallos++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${texto}${ok ? '' : `\n     obtenido ${JSON.stringify(obtenido)}\n     esperado ${JSON.stringify(esperado)}`}`);
};
const ordenar = (ls) => [...ls].sort((a, b) => (a[0] + a[1] + a[2]).localeCompare(b[0] + b[1] + b[2]));

const client = await pool.connect();
let n = 0;
const rechaza = async (fn, fragmento, texto) => {
  const sp = `sp_${++n}`;
  await client.query(`SAVEPOINT ${sp}`);
  try { await fn(); fallos++; console.log(`FAIL ${texto} → no lanzó error`); }
  catch (e) {
    const ok = e.message.includes(fragmento);
    if (!ok) fallos++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${texto} → ${e.message.slice(0, 120)}`);
  } finally { await client.query(`ROLLBACK TO SAVEPOINT ${sp}`); }
};

try {
  await client.query('BEGIN');
  await sembrarReglasSiigo(null, client);
  const q1 = async (sql, p = []) => (await client.query(sql, p)).rows[0];
  const cuenta = async (codigo) => (await q1(`SELECT id FROM sst.cuentas_contables WHERE codigo = $1`, [codigo])).id;
  const op = { client };
  const asiento = async (comprobanteId) => {
    const c = await obtenerComprobante(comprobanteId, client);
    return ordenar(c.movimientos.map((m) => [m.cuenta_codigo, Number(m.debito) ? 'D' : 'C', Number(m.debito) ? m.debito : m.credito]));
  };
  const saldoCxp = async (compraId) => (await q1(`SELECT saldo FROM sst.cartera_documentos WHERE compra_id = $1`, [compraId]))?.saldo ?? null;

  // Proveedor inventado (NIT 9009992xx) y una retención de COMPRA con su cuenta por pagar.
  const nit = (await q1(`SELECT id FROM sst.tipos_documento_identidad WHERE codigo_dian = '31'`)).id;
  const proveedor = (await q1(
    `INSERT INTO sst.terceros (tipo_persona, tipo_documento_id, numero_documento, dv, razon_social, responsabilidades_fiscales, regimen, es_proveedor, activo)
     VALUES ('JURIDICA', $1, '900999201', 1, 'INVERSIONES ANDINA DEL SUR SAS (PRUEBA)', '{}', 'RESPONSABLE_IVA', true, true) RETURNING id`, [nit])).id;
  const p2365 = await cuenta('2365');
  const sub = (await q1(`INSERT INTO sst.cuentas_contables (codigo, nombre, naturaleza, padre_id) VALUES ('236525', 'Servicios', 'CREDITO', $1) RETURNING id`, [p2365])).id;
  const cRet = (await q1(`INSERT INTO sst.cuentas_contables (codigo, nombre, naturaleza, padre_id, acepta_movimiento, exige_tercero) VALUES ('23652501', 'Retención servicios 4 %', 'CREDITO', $1, true, true) RETURNING id`, [sub])).id;
  const rf4 = (await q1(
    `INSERT INTO sst.retenciones (codigo, nombre, tipo, tarifa, aplica_a, cuenta_id) VALUES ('RF-SERV-ZZ', 'RETEFUENTE SERVICIOS 4 %', 'RETEFUENTE', 4, 'COMPRA', $1) RETURNING id`, [cRet])).id;
  const banco = await cuenta('11100501');

  console.log('\n— Asientos reales de Siigo —');
  const fc10 = await crearCompra({ tipo: 'COMPRA', tercero_id: proveedor, numero_proveedor: 'fe-4411', fecha: '2026-09-12', forma_pago: 'CREDITO',
    vencimiento: '2026-10-12', items: [{ cuenta_id: await cuenta('51953501'), descripcion: 'Combustible', valor: '10024' }] }, null, op);
  igual(await asiento(fc10.comprobante_id), ordenar([['51953501', 'D', '10024.00'], ['23359501', 'C', '10024.00']]), 'FC-1-10: gasto 51953501 contra cuenta por pagar 23359501, como Siigo');
  igual([fc10.comprobante_numero?.startsWith('FC-'), fc10.cxp_saldo, fc10.numero_proveedor], [true, '10024.00', 'FE-4411'], 'queda FC, abre su cuenta por pagar y guarda el número en mayúsculas');
  const rp2 = await crearAnticipo({ tercero_id: proveedor, fecha: '2026-09-10', cuenta_banco_id: banco, valor: '80000' }, null, op);
  const rpComp = (await q1(`SELECT comprobante_id FROM sst.anticipos_proveedor WHERE id = $1`, [rp2.id])).comprobante_id;
  igual(await asiento(rpComp), ordenar([['13300501', 'D', '80000.00'], ['11100501', 'C', '80000.00']]), 'RP-1-2: anticipo 13300501 contra banco, como Siigo');

  console.log('\n— Compra con IVA y retención —');
  const serv = await crearCompra({ tipo: 'SERVICIO', tercero_id: proveedor, numero_proveedor: 'FE-4412', fecha: '2026-09-15', forma_pago: 'CREDITO',
    vencimiento: '2026-10-15', items: [{ cuenta_id: await cuenta('51352001'), descripcion: 'Soporte de sistemas', valor: '1000000', iva_pct: 19 }],
    retenciones: [{ retencion_id: rf4 }] }, null, op);
  igual(await asiento(serv.comprobante_id), ordenar([
    ['51352001', 'D', '1000000.00'], ['24081001', 'D', '190000.00'], ['23652501', 'C', '40000.00'], ['23359501', 'C', '1150000.00'],
  ]), 'IVA descontable a 24081001, retefuente 4 % a su cuenta y la CxP por el neto');
  igual([serv.total_iva, serv.total_retenciones, serv.total_a_pagar], ['190000.00', '40000.00', '1150000.00'], 'totales de la compra');
  const hon = await crearCompra({ tipo: 'SERVICIO_PROFESIONAL', tercero_id: proveedor, numero_proveedor: 'CC-77', fecha: '2026-09-16', forma_pago: 'CREDITO',
    vencimiento: '2026-09-30', items: [{ cuenta_id: await cuenta('51101001'), descripcion: 'Honorarios contabilidad', valor: '500000' }] }, null, op);
  igual((await asiento(hon.comprobante_id)).find((l) => l[1] === 'C')[0], '23352501', 'un servicio profesional va a honorarios por pagar (23352501)');
  const gasto = await crearCompra({ tipo: 'GASTO_INTERNO', tercero_id: proveedor, fecha: '2026-09-17', forma_pago: 'CONTADO',
    cuenta_pago_id: await cuenta('11050501'), items: [{ cuenta_id: await cuenta('51954501'), descripcion: 'Taxi', valor: '15000' }] }, null, op);
  igual([gasto.comprobante_numero?.startsWith('CG-'), gasto.cxp_id, (await asiento(gasto.comprobante_id)).map((l) => l[0])], [true, null, ['11050501', '51954501']],
    'un gasto interno de contado es CG, sale de caja y no abre cuenta por pagar');

  const c5195 = await cuenta('5195');
  await rechaza(() => crearCompra({ tipo: 'COMPRA', tercero_id: proveedor, numero_proveedor: 'FE-4411', fecha: '2026-09-12', forma_pago: 'CREDITO',
    vencimiento: '2026-10-12', items: [{ cuenta_id: banco, valor: '1' }] }, null, op), 'ya está registrada', 'la misma factura del proveedor no entra dos veces');
  await rechaza(() => crearCompra({ tipo: 'COMPRA', tercero_id: proveedor, numero_proveedor: 'FE-9', fecha: '2026-09-12', forma_pago: 'CREDITO',
    vencimiento: '2026-10-12', items: [{ cuenta_id: c5195, valor: '1' }] }, null, op), 'no recibe movimiento', 'un ítem no va a una cuenta que agrupa');
  const icaVenta = (await q1(`SELECT id FROM sst.retenciones WHERE codigo = 'ICA-BOL'`)).id;
  await rechaza(() => crearCompra({ tipo: 'COMPRA', tercero_id: proveedor, numero_proveedor: 'FE-10', fecha: '2026-09-12', forma_pago: 'CREDITO',
    vencimiento: '2026-10-12', items: [{ cuenta_id: banco, valor: '100' }], retenciones: [{ retencion_id: icaVenta }] }, null, op), 'retención de venta', 'en una compra no va una retención de venta');

  console.log('\n— Egreso —');
  const prop = await propuestaEgreso(proveedor, client);
  igual([prop.obligaciones.length, prop.anticipo_disponible], [3, '80000.00'], 'la propuesta trae las 3 obligaciones abiertas y el anticipo disponible');
  const cxpServ = (await q1(`SELECT id FROM sst.cartera_documentos WHERE compra_id = $1`, [serv.id])).id;
  const ce = await crearEgreso({ tercero_id: proveedor, fecha: '2026-09-25', cuenta_banco_id: banco,
    aplicaciones: [{ cartera_documento_id: cxpServ, valor_pagado: '500000', valor_anticipo: '80000' }] }, null, op);
  igual(await asiento(ce.comprobante_id), ordenar([['23359501', 'D', '580000.00'], ['11100501', 'C', '500000.00'], ['13300501', 'C', '80000.00']]),
    'CE: D cuenta por pagar, C banco lo pagado y C anticipos lo cruzado');
  igual([await saldoCxp(serv.id), (await q1(`SELECT saldo FROM sst.anticipos_proveedor WHERE id = $1`, [rp2.id])).saldo], ['570000.00', '0.00'],
    'la obligación queda en 570.000 y el anticipo, cruzado del todo');
  await rechaza(() => crearEgreso({ tercero_id: proveedor, fecha: '2026-09-25', cuenta_banco_id: banco,
    aplicaciones: [{ cartera_documento_id: cxpServ, valor_pagado: '1', valor_anticipo: '1' }] }, null, op), 'anticipos para cruzar', 'no se cruza más anticipo del que hay');
  await rechaza(() => crearEgreso({ tercero_id: proveedor, fecha: '2026-09-25', cuenta_banco_id: banco,
    aplicaciones: [{ cartera_documento_id: cxpServ, valor_pagado: '570000.01' }] }, null, op), 'supera su saldo', 'no se paga más que el saldo');
  await rechaza(() => anularCompra(serv.id, 'Registrada mal', null, op), 'anule primero el egreso', 'una compra con pagos no se anula');

  const an = await anularEgreso(ce.id, 'Pago devuelto por el banco', null, op);
  igual([an.estado, await saldoCxp(serv.id), (await q1(`SELECT saldo FROM sst.anticipos_proveedor WHERE id = $1`, [rp2.id])).saldo], ['ANULADO', '1150000.00', '80000.00'],
    'anular el egreso devuelve el saldo de la obligación y el anticipo');
  const anc = await anularCompra(serv.id, 'Registrada mal', null, op);
  igual([anc.estado, anc.cxp_id], ['ANULADO', null], 'ya sin pagos, la compra se anula y su cuenta por pagar desaparece');

  const conc = await conciliacion(client, 'CXP');
  igual([conc.cuadra, conc.diferencia], [true, '0.00'], `las cuentas por pagar cuadran con el libro (${conc.saldo_cartera})`);
  const concCxc = await conciliacion(client, 'CXC');
  igual(concCxc.cuadra, true, 'y la cartera por cobrar sigue cuadrando');
} finally {
  await client.query('ROLLBACK');
  client.release();
  const restos = (await pool.query(`SELECT (SELECT count(*) FROM sst.compras)::int + (SELECT count(*) FROM sst.egresos)::int
                                          + (SELECT count(*) FROM sst.terceros WHERE numero_documento = '900999201')::int AS n`)).rows[0].n;
  console.log(`\nResiduos tras el ROLLBACK: ${restos}`);
  if (restos) fallos++;
  await pool.end();
}
console.log(fallos ? `\n${fallos} FALLO(S)` : '\nTodo OK');
process.exit(fallos ? 1 : 0);
