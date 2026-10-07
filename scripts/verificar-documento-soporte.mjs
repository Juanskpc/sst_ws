// A4-01 · Verificación de punta a punta del documento soporte contra el SANDBOX.
//
// Siembra en jdd_dev un profesional de prueba con su tercero y una cuenta de
// cobro ACEPTADA de dos órdenes (una con viáticos), y recorre el circuito real:
// crear el borrador → emitir → VALIDADO con número, CUDS, PDF y XML. Comprueba
// también los bloqueos (cuenta no aceptada, segundo DS de la misma cuenta).
// La contabilización (asiento DS, cuenta por pagar y su pago con un egreso) se
// prueba dentro de una transacción con ROLLBACK: un comprobante contabilizado no
// se puede borrar, y la base de desarrollo no debe quedar con rastros. Para eso la
// regla DS_CXP se apaga un momento antes de emitir (lo que de paso prueba el caso
// «validado ante la DIAN, contabilidad pendiente»).
// Al terminar borra todo lo sembrado, salvo con --conservar (para verlo en pantalla).
//
// Uso: node --import tsx scripts/verificar-documento-soporte.mjs [--conservar]
import { pool } from '../src/config/db.js';
import { esSandbox } from '../src/modules/facturacion/adaptadores/factus.cliente.js';
import { crearDesdePrecuenta, emitirSoporte, eliminarSoporte, listarSoportes } from '../src/modules/facturacion/soporte.service.js';
import { storage } from '../src/services/storage.service.js';
import { contabilizarEn } from '../src/modules/contabilidad/contabilizacion.service.js';
import { crearEgreso } from '../src/modules/cartera/pagos.service.js';
import { resumenPorMes } from '../src/modules/billing/billing.service.js';

const conservar = process.argv.includes('--conservar');
if (!esSandbox()) throw new Error('Solo corre contra el sandbox del proveedor.');
const db = (await pool.query('SELECT current_database() AS db')).rows[0].db;
if (db !== 'jdd_dev') throw new Error(`Base inesperada: ${db}`);

let fallos = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) fallos += 1; };
const q = async (sql, params) => (await pool.query(sql, params)).rows;

const MARCA = 'PRUEBA-DS';
const admin = (await q(`SELECT id FROM sst.usuarios WHERE rol = 'admin' ORDER BY creado_en LIMIT 1`))[0];
const ordenes = await q(
  `SELECT o.id, o.codigo, a.nombre AS arl FROM sst.ordenes_servicio o JOIN sst.arls a ON a.id = o.arl_id ORDER BY o.codigo LIMIT 2`,
);
if (ordenes.length < 2) throw new Error('jdd_dev necesita al menos dos órdenes con ARL.');
const cc = (await q(`SELECT id FROM sst.tipos_documento_identidad WHERE codigo_dian = '13'`))[0];
const pasto = (await q(`SELECT id FROM sst.municipios WHERE codigo_dian = '52001'`))[0];

const sembrado = {};
try {
  sembrado.tercero = (await q(
    `INSERT INTO sst.terceros (tipo_persona, tipo_documento_id, numero_documento, nombres, apellidos, direccion, municipio_id,
                               correo_facturacion, es_proveedor, creado_por, actualizado_por)
     VALUES ('NATURAL', $1, '1000000099', 'ASESOR', '${MARCA}', 'CR 26 N 19 07', $2, 'escalappsystem@gmail.com', true, $3, $3)
     RETURNING id`,
    [cc.id, pasto.id, admin.id],
  ))[0].id;
  sembrado.profesional = (await q(
    `INSERT INTO sst.profesionales (nombre, correo, valor_hora, tercero_id) VALUES ('ASESOR ${MARCA}', 'escalappsystem@gmail.com', 58000, $1) RETURNING id`,
    [sembrado.tercero],
  ))[0].id;
  sembrado.precuenta = (await q(
    `INSERT INTO sst.precuentas (profesional_id, periodo, total_horas, total_monto, total_viaticos, estado)
     VALUES ($1, '2026-09', 7.5, 455000, 20000, 'generada') RETURNING id`,
    [sembrado.profesional],
  ))[0].id;
  await q(
    `INSERT INTO sst.precuenta_items (precuenta_id, orden_id, horas, valor_hora_snapshot, monto, viaticos, orden_codigo, empresa_nombre, arl_nombre, actividad, fecha_ejecucion)
     VALUES ($1, $2, 4, 58000, 232000, 20000, $3, 'EMPRESA DE PRUEBA', $4, 'Capacitación', '2026-09-10'),
            ($1, $5, 3.5, 58000, 203000, 0, $6, 'OTRA EMPRESA', $7, 'Inspección', '2026-09-18')`,
    [sembrado.precuenta, ordenes[0].id, ordenes[0].codigo, ordenes[0].arl, ordenes[1].id, ordenes[1].codigo, ordenes[1].arl],
  );

  // 1 · Una cuenta que no está aceptada no da documento soporte.
  try {
    await crearDesdePrecuenta(sembrado.precuenta, admin.id);
    ok(false, 'cuenta «generada» rechazada');
  } catch (e) { ok(e.statusCode === 409, `cuenta «generada» rechazada (${e.message})`); }

  await q(`UPDATE sst.precuentas SET estado = 'aceptada' WHERE id = $1`, [sembrado.precuenta]);

  // 2 · Borrador: dos líneas de honorarios y una de viáticos, total = lo aceptado.
  const borrador = await crearDesdePrecuenta(sembrado.precuenta, admin.id);
  sembrado.documento = borrador.id;
  ok(borrador.estado === 'BORRADOR' && borrador.tipo === 'DOC_SOPORTE', `borrador ${borrador.reference_code}`);
  ok(borrador.items.length === 3, `3 líneas (${borrador.items.map((i) => `${i.codigo} ${i.cantidad}×${i.valor_unitario}`).join(' | ')})`);
  ok(Number(borrador.total_a_pagar) === 455000, `total ${borrador.total_a_pagar} = 455000`);
  ok(borrador.items.every((i) => i.arl_nombre), `cada línea con su ARL (${borrador.items.map((i) => i.arl_nombre).join(', ')})`);
  ok(borrador.precuenta?.periodo === '2026-09', `enlazado a la cuenta de ${borrador.precuenta?.periodo_largo}`);

  // 3 · No hay dos documentos soporte vivos para la misma cuenta.
  try {
    await crearDesdePrecuenta(sembrado.precuenta, admin.id);
    ok(false, 'segundo DS de la misma cuenta bloqueado');
  } catch (e) { ok(e.statusCode === 409, `segundo DS bloqueado (${e.message})`); }

  // 4 · Emisión real en el sandbox (con la regla DS_CXP apagada: el asiento queda pendiente).
  sembrado.reglaApagada = (await q(
    `UPDATE sst.reglas_contables SET activa = false WHERE concepto = 'DS_CXP' AND tercero_id IS NULL AND activa RETURNING id`,
  ))[0]?.id;
  if (!sembrado.reglaApagada) throw new Error('Falta la regla general DS_CXP en jdd_dev (Contabilidad → Reglas → cargar las de Siigo).');
  const emitido = await emitirSoporte(borrador.id, admin.id);
  await q(`UPDATE sst.reglas_contables SET activa = true WHERE id = $1`, [sembrado.reglaApagada]);
  sembrado.reglaApagada = null;
  ok(emitido.estado === 'VALIDADO', `emitido: ${emitido.estado} ${emitido.prefijo ?? ''} ${emitido.numero ?? ''}`);
  ok(Boolean(emitido.cufe), `CUDS ${String(emitido.cufe).slice(0, 16)}…`);
  ok(Boolean(emitido.pdf_path) && Boolean(emitido.xml_path), `PDF ${emitido.pdf_path} · XML ${emitido.xml_path}`);
  if (emitido.pdf_path) {
    const pdf = await storage.get(emitido.pdf_path);
    ok(pdf.subarray(0, 4).toString() === '%PDF', `el PDF guardado es un PDF (${pdf.length} bytes)`);
  }
  if (emitido.estado !== 'VALIDADO') console.log(JSON.stringify(emitido.errores ?? emitido, null, 2));

  const lista = await listarSoportes({ periodo: '2026-09' });
  ok(lista.some((d) => d.id === borrador.id && d.profesional_nombre === `ASESOR ${MARCA}`), 'aparece en la lista del periodo');

  ok(emitido.eventos.some((e) => e.codigo === 'CONTABILIZACION_PENDIENTE') && !emitido.comprobante_id,
    'sin la regla, queda «contabilidad pendiente» y el DS sigue validado');

  // 6 · Contabilización + cuenta por pagar + egreso, todo con ROLLBACK.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const comp = await contabilizarEn(client, borrador.id, admin.id);
    const movs = (await client.query(
      `SELECT c.codigo, m.debito, m.credito FROM sst.movimientos m JOIN sst.cuentas_contables c ON c.id = m.cuenta_id
        WHERE m.comprobante_id = $1 ORDER BY m.credito NULLS FIRST, c.codigo`, [comp.id],
    )).rows;
    console.log('   asiento:', movs.map((m) => `${m.codigo} ${Number(m.debito) ? 'D ' + m.debito : 'C ' + m.credito}`).join(' | '));
    ok(String(comp.numero_completo ?? '').startsWith('DS'), `comprobante ${comp.numero_completo}`);
    const debitos = movs.filter((m) => Number(m.debito) > 0);
    const costo = debitos.reduce((s, m) => s + Number(m.debito), 0);
    ok(debitos.every((m) => m.codigo === '73050501') && costo === 455000, 'débitos al costo de Bolívar (73050501) por 455.000');
    ok(movs.some((m) => m.codigo === '23352501' && Number(m.credito) === 455000), 'crédito a honorarios por pagar (23352501) por 455.000');
    const cxp = (await client.query(`SELECT id, tipo, saldo FROM sst.cartera_documentos WHERE documento_id = $1`, [borrador.id])).rows[0];
    ok(cxp?.tipo === 'CXP' && Number(cxp.saldo) === 455000, `cuenta por pagar abierta por ${cxp?.saldo}`);

    const banco = (await client.query(
      `SELECT id, codigo FROM sst.cuentas_contables WHERE codigo LIKE '1110%' AND acepta_movimiento AND activa ORDER BY codigo LIMIT 1`,
    )).rows[0];
    const egreso = await crearEgreso({
      tercero_id: sembrado.tercero, fecha: borrador.fecha_emision ?? new Date().toISOString().slice(0, 10), cuenta_banco_id: banco.id,
      aplicaciones: [{ cartera_documento_id: cxp.id, valor_pagado: 455000 }],
    }, admin.id, { client });
    const saldo = (await client.query(`SELECT saldo FROM sst.cartera_documentos WHERE id = $1`, [cxp.id])).rows[0].saldo;
    ok(Number(saldo) === 0, `egreso ${egreso.numero_completo ?? ''} (banco ${banco.codigo}) deja la cuenta por pagar en ${saldo}`);
    const fila = (await resumenPorMes({ anio: 2026, client })).find((f) => f.precuenta_id === sembrado.precuenta);
    ok(fila?.documento_soporte && Number(fila.documento_soporte.saldo) === 0, 'Cuentas de cobro ve el DS pagado (saldo 0)');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }

  // 7 · Un validado no se borra.
  try {
    await eliminarSoporte(borrador.id);
    ok(false, 'un DS validado no se elimina');
  } catch (e) { ok(e.statusCode === 409, 'un DS validado no se elimina'); }
} finally {
  if (sembrado.reglaApagada) await q(`UPDATE sst.reglas_contables SET activa = true WHERE id = $1`, [sembrado.reglaApagada]);
  if (conservar) {
    console.log(`\nConservado para verlo en pantalla (precuenta ${sembrado.precuenta}).`);
  } else {
    if (sembrado.documento) await q(`DELETE FROM sst.documentos_electronicos WHERE id = $1`, [sembrado.documento]);
    if (sembrado.profesional) await q(`DELETE FROM sst.profesionales WHERE id = $1`, [sembrado.profesional]); // la cuenta cae en cascada
    if (sembrado.tercero) await q(`DELETE FROM sst.terceros WHERE id = $1`, [sembrado.tercero]);
    console.log('\nDatos de prueba borrados.');
  }
  await pool.end();
}
console.log(fallos ? `\n${fallos} comprobación(es) fallaron.` : '\nTodo en verde.');
process.exitCode = fallos ? 1 : 0;
