// 13-nov-2026 · Verifica «Modificar recibo de caja» contra jdd_dev DENTRO de una transacción
// con ROLLBACK: no deja nada escrito. Si la base todavía no tiene la migración
// 2026-11-13-modificar-recibo-caja.sql, la aplica dentro de la misma transacción (y se deshace).
// Las validaciones diferidas (cuadre al commit) se fuerzan con SET CONSTRAINTS ALL IMMEDIATE.
//
// Uso: node --import tsx scripts/verificar-modificar-recibo.mjs   (requiere el túnel)
import { readFileSync } from 'node:fs';
import { pool } from '../src/config/db.js';
import { contabilizarEn } from '../src/modules/contabilidad/contabilizacion.service.js';
import { sembrarReglasSiigo } from '../src/modules/contabilidad/reglas.service.js';
import { obtenerComprobante } from '../src/modules/contabilidad/comprobantes.service.js';
import {
  anularRecibo, conciliacion, crearReciboCaja, modificarRecibo, obtenerRecibo, propuestaRecibo, sincronizarCartera,
} from '../src/modules/cartera/cartera.service.js';

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
  try { await fn(); await client.query('SET CONSTRAINTS ALL IMMEDIATE'); fallos++; console.log(`FAIL ${texto} → no lanzó error`); }
  catch (e) {
    const ok = e.message.includes(fragmento);
    if (!ok) fallos++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${texto} → ${e.message.slice(0, 120)}`);
  } finally { await client.query(`ROLLBACK TO SAVEPOINT ${sp}`); await client.query('SET CONSTRAINTS ALL DEFERRED'); }
};

try {
  await client.query('BEGIN');
  const yaMigrada = (await client.query(`SELECT to_regclass('sst.recibos_caja_cambios') IS NOT NULL AS si`)).rows[0].si;
  if (!yaMigrada) {
    const sql = readFileSync(new URL('../db/migraciones/2026-11-13-modificar-recibo-caja.sql', import.meta.url), 'utf8')
      .replace(/^\s*BEGIN;\s*$/m, '').replace(/^\s*COMMIT;\s*$/m, '');
    await client.query(sql);
    console.log('  (migración aplicada dentro de la transacción; se deshace al final)');
  }
  await sincronizarCartera(client);
  await sembrarReglasSiigo(null, client);

  const q1 = async (sql, p = []) => (await client.query(sql, p)).rows[0];
  const axa = (await q1(`SELECT id FROM sst.terceros WHERE razon_social = 'AXA COLPATRIA SEGUROS DE VIDA SA'`)).id;
  const bolivar = (await q1(`SELECT id FROM sst.terceros WHERE razon_social = 'COMPAÑIA DE SEGUROS BOLIVAR S A'`)).id;
  const icaAxa = (await q1(`SELECT id FROM sst.retenciones WHERE codigo = 'ICA-AXA'`)).id;
  const cuenta = async (codigo) => (await q1(`SELECT id FROM sst.cuentas_contables WHERE codigo = $1`, [codigo]))?.id;
  const banco = await cuenta('11100501');
  // Otra cuenta del disponible que NO está marcada como banco (caja general, si existe en jdd_dev).
  const caja = (await q1(`SELECT id, codigo FROM sst.cuentas_contables WHERE codigo LIKE '11%' AND acepta_movimiento AND activa AND NOT es_banco ORDER BY codigo LIMIT 1`));
  const noDisponible = (await q1(`SELECT id FROM sst.cuentas_contables WHERE codigo LIKE '4%' AND acepta_movimiento AND activa LIMIT 1`)).id;

  const factura = async (terceroId, total) => {
    const d = (await client.query(
      `INSERT INTO sst.documentos_electronicos (tipo, reference_code, estado, tercero_id, prefijo, numero, fecha_emision, fecha_vencimiento,
                                                total_bruto, subtotal, total_a_pagar)
       VALUES ('FACTURA', $1, 'VALIDADO', $2, 'ZZ', $3, '2026-10-20', '2026-11-19', $4, $4, $4) RETURNING id`,
      [`ORB-ZZ-M${++n}`, terceroId, String(9500 + n), total],
    )).rows[0].id;
    await client.query(`INSERT INTO sst.documento_items (documento_id, descripcion, base, total_linea) VALUES ($1, 'Servicio', $2, $2)`, [d, total]);
    await contabilizarEn(client, d, null);
    return (await q1(`SELECT id FROM sst.cartera_documentos WHERE documento_id = $1`, [d])).id;
  };
  const saldo = async (id) => (await q1(`SELECT saldo FROM sst.cartera_documentos WHERE id = $1`, [id])).saldo;
  const asiento = async (compId) => {
    const c = await obtenerComprobante(compId, client);
    return { numero: c.numero_completo, fecha: c.fecha, estado: c.estado,
      lineas: ordenar(c.movimientos.map((m) => [m.cuenta_codigo, Number(m.debito) ? 'D' : 'C', Number(m.debito) ? m.debito : m.credito])) };
  };

  // ── El recibo de AXA (RC-1-97 de Siigo): dos facturas con ReteICA ──
  const f1 = await factura(axa, '1437357.69');
  const f2 = await factura(axa, '1129352.47');
  const f3 = await factura(axa, '500000.00');
  const rc = await crearReciboCaja({ tercero_id: axa, fecha: '2026-11-13', cuenta_banco_id: banco, aplicaciones: [
    { cartera_documento_id: f1, valor_pagado: '1427667.69', retenciones: [{ retencion_id: icaAxa, valor: '9690' }] },
    { cartera_documento_id: f2, valor_pagado: '1121738.47', retenciones: [{ retencion_id: icaAxa, valor: '7614' }] },
  ] }, null, { client });
  await client.query('SET CONSTRAINTS ALL IMMEDIATE'); await client.query('SET CONSTRAINTS ALL DEFERRED');
  const antes = await asiento(rc.comprobante_id);
  igual([await saldo(f1), await saldo(f2)], ['0.00', '0.00'], 'el recibo original salda las dos facturas');

  console.log('\n— Propuesta para modificar —');
  const sinRecibo = await propuestaRecibo(axa, client);
  igual(sinRecibo.facturas.some((f) => f.id === f1), false, 'sin recibo_id, la factura saldada no aparece');
  const prop = await propuestaRecibo(axa, client, { reciboId: rc.id });
  igual(prop.facturas.find((f) => f.id === f1)?.saldo, '1437357.69', 'con recibo_id, la factura entra con el saldo que tendría sin el recibo');
  igual(prop.actual.map((a) => [a.cartera_documento_id === f1 || a.cartera_documento_id === f2, a.retencion_ids.length]).sort(),
    [[true, 1], [true, 1]], '`actual` trae lo aplicado por el recibo, con su retención');

  console.log('\n— Modificar: otra cuenta (caja), otra fecha, quitar una factura y sumar otra —');
  if (!caja) console.log('  (jdd_dev no tiene otra cuenta del grupo 11 sin marcar como banco: se usa la misma)');
  const mod = await modificarRecibo(rc.id, {
    tercero_id: axa, fecha: '2026-11-12', cuenta_banco_id: caja?.id ?? banco, observaciones: 'Transferencia 123', motivo: 'Era la caja, no el banco',
    aplicaciones: [
      { cartera_documento_id: f1, valor_pagado: '1427667.69', retenciones: [{ retencion_id: icaAxa, valor: '9690' }] },
      { cartera_documento_id: f3, valor_pagado: '300000.00' },
    ],
  }, null, { client });
  await client.query('SET CONSTRAINTS ALL IMMEDIATE'); await client.query('SET CONSTRAINTS ALL DEFERRED');
  const despues = await asiento(rc.comprobante_id);
  igual(mod.numero, rc.numero, `conserva su número (${rc.numero})`);
  igual([despues.numero, despues.estado], [antes.numero, 'CONTABILIZADO'], 'el comprobante RC sigue con su número y contabilizado');
  igual(despues.fecha, '2026-11-12', 'el asiento toma la fecha nueva');
  igual(despues.lineas, ordenar([[caja?.codigo ?? '11100501', 'D', '1727667.69'], ['13050501', 'C', '1437357.69'], ['13050501', 'C', '300000.00'], ['13551820', 'D', '9690.00']]),
    'el asiento se reescribe: cuenta nueva, F1 con ReteICA y abono a F3');
  igual([await saldo(f1), await saldo(f2), await saldo(f3)], ['0.00', '1129352.47', '200000.00'], 'saldos: F1 saldada, F2 recupera todo, F3 queda con 200.000');
  igual([mod.valor_consignado, mod.observaciones, mod.cuenta_banco_id === (caja?.id ?? banco)], ['1727667.69', 'Transferencia 123', true], 'el recibo guarda lo nuevo');
  igual([mod.cambios.length, mod.cambios[0]?.motivo], [1, 'Era la caja, no el banco'], 'queda el rastro del cambio con su motivo');
  const rastro = await q1(`SELECT antes->>'valor_consignado' AS a, despues->>'valor_consignado' AS d FROM sst.recibos_caja_cambios WHERE recibo_id = $1`, [rc.id]);
  igual([rastro.a, rastro.d], ['2549406.16', '1727667.69'], 'el rastro guarda el antes y el después');
  igual((await conciliacion(client)).cuadra, true, 'la cartera sigue cuadrando con el libro');

  console.log('\n— Reglas —');
  await rechaza(() => modificarRecibo(rc.id, { tercero_id: axa, fecha: '2026-11-12', cuenta_banco_id: banco,
    aplicaciones: [{ cartera_documento_id: f2, valor_pagado: '1129352.48' }] }, null, { client }), 'supera su saldo', 'no se paga más que el saldo recuperado');
  await rechaza(() => modificarRecibo(rc.id, { tercero_id: bolivar, fecha: '2026-11-12', cuenta_banco_id: banco,
    aplicaciones: [{ cartera_documento_id: f1, valor_pagado: '1' }] }, null, { client }), 'otro cliente', 'no se aplica a facturas de otro cliente');
  await rechaza(() => modificarRecibo(rc.id, { tercero_id: axa, fecha: '2026-11-12', cuenta_banco_id: noDisponible,
    aplicaciones: [{ cartera_documento_id: f1, valor_pagado: '1' }] }, null, { client }), 'donde entró la plata', 'la cuenta tiene que ser del disponible (grupo 11)');
  // Mes cerrado: el de la fecha nueva.
  await rechaza(async () => {
    await client.query(`INSERT INTO sst.periodos_contables (anio, mes, estado) VALUES (2026, 10, 'CERRADO') ON CONFLICT (anio, mes) DO UPDATE SET estado = 'CERRADO'`);
    await modificarRecibo(rc.id, { tercero_id: axa, fecha: '2026-10-30', cuenta_banco_id: banco,
      aplicaciones: [{ cartera_documento_id: f2, valor_pagado: '1' }] }, null, { client });
  }, 'cerrado', 'no se mueve a un mes cerrado');
  // La base no deja tocar otro comprobante contabilizado aunque alguien lo intente directo.
  await rechaza(() => client.query(`UPDATE sst.comprobantes SET fecha = fecha + 1 WHERE id = (SELECT comprobante_id FROM sst.documentos_electronicos WHERE id =
    (SELECT documento_id FROM sst.cartera_documentos WHERE id = $1))`, [f1]), 'no se edita', 'el asiento de una factura sigue sin poder editarse');
  await rechaza(async () => {
    await client.query(`SELECT set_config('sst.reescribir_comprobante', (SELECT comprobante_id::text FROM sst.documentos_electronicos WHERE id =
      (SELECT documento_id FROM sst.cartera_documentos WHERE id = $1)), true)`, [f1]);
    await client.query(`DELETE FROM sst.movimientos WHERE comprobante_id = (SELECT comprobante_id FROM sst.documentos_electronicos WHERE id =
      (SELECT documento_id FROM sst.cartera_documentos WHERE id = $1))`, [f1]);
  }, 'no se modifican', 'ni marcándolo: la excepción es solo para recibos de caja');

  console.log('\n— Anular después de modificar —');
  const an = await anularRecibo(rc.id, 'Prueba de anulación', null, { client });
  igual([an.estado, await saldo(f1), await saldo(f3)], ['ANULADO', '1437357.69', '500000.00'], 'anular devuelve los saldos de lo modificado');
  await rechaza(() => modificarRecibo(rc.id, { tercero_id: axa, fecha: '2026-11-12', cuenta_banco_id: banco,
    aplicaciones: [{ cartera_documento_id: f1, valor_pagado: '1' }] }, null, { client }), 'anulado', 'un recibo anulado no se modifica');
  igual((await obtenerRecibo(rc.id, client)).numero, rc.numero, 'y sigue con su número');
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  console.log('OK   las validaciones diferidas (cuadre al commit) pasan');
} catch (e) {
  fallos++;
  console.error('✗', e);
} finally {
  await client.query('ROLLBACK');
  client.release();
  await pool.end();
}
console.log(fallos ? `\n${fallos} fallo(s)` : '\nTodo OK (nada quedó escrito: ROLLBACK)');
process.exit(fallos ? 1 : 0);
