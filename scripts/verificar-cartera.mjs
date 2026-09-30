// Verifica B3-01 (cartera y recibos de caja) contra jdd_dev DENTRO de una
// transacción con ROLLBACK. Reproduce tres recibos reales de septiembre y compara
// su asiento con el de Siigo (auxiliar, §3.5 del plan):
//   RC-1-101 Bolívar · ReteICA 5 ‰ a 13551819
//   RC-1-97  AXA · dos facturas en un recibo, ReteICA 6 ‰ a 13551820 por cada una
//   RC-1-105 Sandoná · el cliente retuvo RETEFUENTE al pagar (13551509)
// y comprueba saldos, notas crédito, anulación y la conciliación cartera = libro.
// Uso: node --import tsx scripts/verificar-cartera.mjs   (requiere el túnel)
import { pool } from '../src/config/db.js';
import { contabilizarEn } from '../src/modules/contabilidad/contabilizacion.service.js';
import { sembrarReglasSiigo } from '../src/modules/contabilidad/reglas.service.js';
import { obtenerComprobante } from '../src/modules/contabilidad/comprobantes.service.js';
import {
  anularRecibo, antiguedad, conciliacion, crearReciboCaja, estadoCuenta, propuestaRecibo, sincronizarCartera,
} from '../src/modules/cartera/cartera.service.js';

let fallos = 0;
const igual = (obtenido, esperado, texto) => {
  const ok = JSON.stringify(obtenido) === JSON.stringify(esperado);
  if (!ok) fallos++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${texto}${ok ? '' : `\n     obtenido ${JSON.stringify(obtenido)}\n     esperado ${JSON.stringify(esperado)}`}`);
};
const ordenar = (ls) => [...ls].sort((a, b) => (a[0] + a[1] + a[2]).localeCompare(b[0] + b[1] + b[2]));

// Lo que dice el auxiliar de Siigo.
const SIIGO = {
  'RC-1-101': [['11100501', 'D', '6322457.80'], ['13050501', 'C', '6358177.80'], ['13551819', 'D', '35720.00']],
  'RC-1-97': [['11100501', 'D', '2549406.16'], ['13050501', 'C', '1437357.69'], ['13050501', 'C', '1129352.47'],
    ['13551820', 'D', '9690.00'], ['13551820', 'D', '7614.00']],
  'RC-1-105': [['11100501', 'D', '1883937.55'], ['13050501', 'C', '2075820.01'], ['13551509', 'D', '191882.46']],
};

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
  // Lo que ya hay en jdd_dev (asientos de la Fase A) también abre su cartera.
  await sincronizarCartera(client);
  const sem = await sembrarReglasSiigo(null, client);
  console.log(`  (retenciones con cuenta: ${sem.retenciones.join(', ') || 'ya la tenían'})`);

  const q1 = async (sql, p = []) => (await client.query(sql, p)).rows[0];
  const tercero = async (nombre) => (await q1(`SELECT id FROM sst.terceros WHERE razon_social = $1`, [nombre])).id;
  const bolivar = await tercero('COMPAÑIA DE SEGUROS BOLIVAR S A');
  const axa = await tercero('AXA COLPATRIA SEGUROS DE VIDA SA');
  const sandona = await tercero('TRANSPORTE DE SANDONA SA');
  const ret = async (codigo) => (await q1(`SELECT id FROM sst.retenciones WHERE codigo = $1`, [codigo])).id;
  const icaBol = await ret('ICA-BOL');
  const icaAxa = await ret('ICA-AXA');
  const rfHon = await ret('RF-HON');
  const banco = (await q1(`SELECT id FROM sst.cuentas_contables WHERE codigo = '11100501'`)).id;
  const codigoDe = new Map((await client.query(`SELECT id, codigo FROM sst.cuentas_contables`)).rows.map((c) => [c.id, c.codigo]));

  /** Una factura VALIDADA ya contabilizada (con su cartera abierta). */
  const factura = async (terceroId, total, subtotal = total) => {
    const d = (await client.query(
      `INSERT INTO sst.documentos_electronicos (tipo, reference_code, estado, tercero_id, prefijo, numero, fecha_emision, fecha_vencimiento,
                                                total_bruto, subtotal, total_a_pagar)
       VALUES ('FACTURA', $1, 'VALIDADO', $2, 'ZZ', $3, '2026-08-20', '2026-09-19', $4, $4, $5) RETURNING id`,
      [`ORB-ZZ-${++n}`, terceroId, String(9000 + n), subtotal, total],
    )).rows[0].id;
    // Un ítem que cuadra el asiento: ingreso = total a pagar (sin impuestos, para la prueba).
    await client.query(`INSERT INTO sst.documento_items (documento_id, descripcion, base, total_linea) VALUES ($1, 'Servicio', $2, $2)`, [d, total]);
    await contabilizarEn(client, d, null);
    return (await q1(`SELECT id FROM sst.cartera_documentos WHERE documento_id = $1`, [d])).id;
  };
  const asiento = async (recibo) => {
    const c = await obtenerComprobante(recibo.comprobante_id, client);
    return ordenar(c.movimientos.map((m) => [m.cuenta_codigo, Number(m.debito) ? 'D' : 'C', Number(m.debito) ? m.debito : m.credito]));
  };

  console.log('\n— Recibos reales de Siigo —');
  const cBol = await factura(bolivar, '6358177.80');
  const rc101 = await crearReciboCaja({ tercero_id: bolivar, fecha: '2026-09-18', cuenta_banco_id: banco,
    aplicaciones: [{ cartera_documento_id: cBol, valor_pagado: '6322457.80', retenciones: [{ retencion_id: icaBol, valor: '35720' }] }] }, null, { client });
  igual(await asiento(rc101), ordenar(SIIGO['RC-1-101']), 'RC-1-101 (Bolívar): el asiento es el de Siigo');
  igual((await q1(`SELECT saldo FROM sst.cartera_documentos WHERE id = $1`, [cBol])).saldo, '0.00', 'la factura queda en cero');

  const cAxa1 = await factura(axa, '1437357.69');
  const cAxa2 = await factura(axa, '1129352.47');
  const rc97 = await crearReciboCaja({ tercero_id: axa, fecha: '2026-09-08', cuenta_banco_id: banco, aplicaciones: [
    { cartera_documento_id: cAxa1, valor_pagado: '1427667.69', retenciones: [{ retencion_id: icaAxa, valor: '9690' }] },
    { cartera_documento_id: cAxa2, valor_pagado: '1121738.47', retenciones: [{ retencion_id: icaAxa, valor: '7614' }] },
  ] }, null, { client });
  igual(await asiento(rc97), ordenar(SIIGO['RC-1-97']), 'RC-1-97 (AXA, dos facturas): el asiento es el de Siigo');
  igual(rc97.valor_consignado, '2549406.16', 'lo consignado es la suma de lo pagado');

  const cSan = await factura(sandona, '2075820.01');
  const rc105 = await crearReciboCaja({ tercero_id: sandona, fecha: '2026-09-25', cuenta_banco_id: banco,
    aplicaciones: [{ cartera_documento_id: cSan, valor_pagado: '1883937.55', retenciones: [{ retencion_id: rfHon, valor: '191882.46' }] }] }, null, { client });
  igual(await asiento(rc105), ordenar(SIIGO['RC-1-105']), 'RC-1-105 (Sandoná, retefuente al pagar): el asiento es el de Siigo');

  console.log('\n— Reglas del recibo —');
  const cParcial = await factura(axa, '1000000.00', '1123595.51');
  const prop = await propuestaRecibo(axa, client);
  const pp = prop.facturas.find((f) => f.id === cParcial);
  // AXA tiene su ReteICA de pago en las condiciones (6 ‰) si está configurada; si no, la sugerida es 0.
  igual(pp.reteica_sugerida, prop.reteica ? String((Math.round(1123595.51 * Number(prop.reteica.tarifa) / 100)).toFixed(2)) : '0.00',
    `la ReteICA sugerida es la tarifa del pagador sobre el subtotal, en pesos (${pp.reteica_sugerida})`);
  const abono = await crearReciboCaja({ tercero_id: axa, fecha: '2026-09-28', cuenta_banco_id: banco,
    aplicaciones: [{ cartera_documento_id: cParcial, valor_pagado: '400000' }] }, null, { client });
  igual((await q1(`SELECT saldo FROM sst.cartera_documentos WHERE id = $1`, [cParcial])).saldo, '600000.00', 'un abono parcial deja el resto pendiente');
  await rechaza(() => crearReciboCaja({ tercero_id: axa, fecha: '2026-09-28', cuenta_banco_id: banco,
    aplicaciones: [{ cartera_documento_id: cParcial, valor_pagado: '600000.01' }] }, null, { client }), 'supera su saldo', 'no se paga más que el saldo');
  await rechaza(() => crearReciboCaja({ tercero_id: bolivar, fecha: '2026-09-28', cuenta_banco_id: banco,
    aplicaciones: [{ cartera_documento_id: cParcial, valor_pagado: '1' }] }, null, { client }), 'otro cliente', 'no se aplica a una factura de otro cliente');
  await rechaza(() => crearReciboCaja({ tercero_id: axa, fecha: '2026-09-28', cuenta_banco_id: cAxa1,
    aplicaciones: [{ cartera_documento_id: cParcial, valor_pagado: '1' }] }, null, { client }), 'cuenta de banco', 'exige una cuenta de banco');

  const anulado = await anularRecibo(abono.id, 'Consignación duplicada', null, { client });
  igual([anulado.estado, (await q1(`SELECT saldo FROM sst.cartera_documentos WHERE id = $1`, [cParcial])).saldo], ['ANULADO', '1000000.00'],
    'anular el recibo devuelve el saldo');
  igual((await q1(`SELECT estado FROM sst.comprobantes WHERE id = $1`, [abono.comprobante_id])).estado, 'ANULADO', 'y anula su comprobante RC');

  console.log('\n— Nota crédito —');
  const fNc = (await client.query(
    `INSERT INTO sst.documentos_electronicos (tipo, reference_code, estado, tercero_id, prefijo, numero, fecha_emision, subtotal, total_a_pagar)
     VALUES ('FACTURA', $1, 'VALIDADO', $2, 'ZZ', '9800', '2026-09-05', 500000, 500000) RETURNING id`, [`ORB-ZZ-${++n}`, axa])).rows[0].id;
  await client.query(`INSERT INTO sst.documento_items (documento_id, descripcion, base, total_linea) VALUES ($1, 'Servicio', 500000, 500000)`, [fNc]);
  await contabilizarEn(client, fNc, null);
  const nc = (await client.query(
    `INSERT INTO sst.documentos_electronicos (tipo, reference_code, estado, tercero_id, prefijo, numero, fecha_emision, subtotal, total_a_pagar, documento_referencia_id)
     VALUES ('NOTA_CREDITO', $1, 'VALIDADO', $2, 'ZZ', '9801', '2026-09-06', 200000, 200000, $3) RETURNING id`, [`ORB-ZZ-${++n}`, axa, fNc])).rows[0].id;
  await client.query(`INSERT INTO sst.documento_items (documento_id, descripcion, base, total_linea) VALUES ($1, 'Devolución', 200000, 200000)`, [nc]);
  await contabilizarEn(client, nc, null);
  igual((await q1(`SELECT saldo FROM sst.cartera_documentos WHERE documento_id = $1`, [fNc])).saldo, '300000.00', 'la nota crédito baja el saldo de su factura');

  console.log('\n— Informes y conciliación —');
  const ec = await estadoCuenta(axa, client);
  igual(ec.documentos.some((d) => d.movimientos.some((m) => m.origen_tipo === 'NOTA_CREDITO')), true, 'el estado de cuenta muestra la nota crédito');
  const ant = await antiguedad('2026-11-30', client);
  igual(ant.clientes.every((c) => Number(c.TOTAL) > 0), true, 'la antigüedad solo lista clientes con saldo');
  const conc = await conciliacion(client);
  igual([conc.cuadra, conc.diferencia], [true, '0.00'], `la cartera cuadra con el libro (${conc.saldo_cartera})`);
} finally {
  await client.query('ROLLBACK');
  client.release();
  const restos = (await pool.query(`SELECT (SELECT count(*) FROM sst.recibos_caja)::int + (SELECT count(*) FROM sst.documentos_electronicos WHERE reference_code LIKE 'ORB-ZZ-%')::int AS n`)).rows[0].n;
  console.log(`\nResiduos tras el ROLLBACK: ${restos}`);
  if (restos) fallos++;
  await pool.end();
}
console.log(fallos ? `\n${fallos} FALLO(S)` : '\nTodo OK');
process.exit(fallos ? 1 : 0);
