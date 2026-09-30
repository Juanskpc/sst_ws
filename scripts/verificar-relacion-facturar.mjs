// Verifica A1-03 (relación a facturar) contra jdd_dev DENTRO de una transacción
// con ROLLBACK: crea órdenes, una prefactura y documentos desechables, comprueba
// qué sale como facturable y qué no, y no deja nada.
// Uso: node scripts/verificar-relacion-facturar.mjs   (requiere el túnel a jdd_dev)
import { pool } from '../src/config/db.js';
import { relacionPorFacturar, resolverSeleccion } from '../src/modules/facturacion/relacion.service.js';

let fallos = 0;
const igual = (obtenido, esperado, texto) => {
  const ok = JSON.stringify(obtenido) === JSON.stringify(esperado);
  if (!ok) fallos++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${texto} → ${JSON.stringify(obtenido)}${ok ? '' : ` (esperado ${JSON.stringify(esperado)})`}`);
};
const rechaza = async (fn, fragmento, texto) => {
  try { await fn(); fallos++; console.log(`FAIL ${texto} → no lanzó error`); }
  catch (e) {
    const ok = e.message.includes(fragmento);
    if (!ok) fallos++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${texto} → ${e.message.slice(0, 110)}`);
  }
};

const client = await pool.connect();
try {
  await client.query('BEGIN');
  const arl = async (nombre) => (await client.query(`SELECT id, tercero_id FROM sst.arls WHERE nombre = $1`, [nombre])).rows[0];
  const axa = await arl('AXA Colpatria');
  const colmena = await arl('Colmena');
  const bolivar = await arl('Bolívar');

  let n = 0;
  const orden = async (a, c = {}) => (await client.query(
    `INSERT INTO sst.ordenes_servicio
       (arl_id, codigo, numero_orden, codigo_cronograma, secuencia, empresa_nombre, tipo_actividad,
        horas_asignadas, valor_total, estado, estado_arl, estado_cobro, cobro_numero_factura, numero_prefactura)
     VALUES ($1, $2, $3, $4, $5, 'EMPRESA DE PRUEBA', 'Asesoría', $6, $7,
             $8::sst.estado_orden, $9::sst.estado_arl, $10::sst.estado_cobro, $11, $12)
     RETURNING id`,
    [a.id, `OS-ZZ-${++n}`, c.numero_orden ?? null, c.cronograma ?? null, c.secuencia ?? null,
     c.horas ?? 10, c.valor_total ?? null, c.estado ?? 'FINALIZADA', c.estado_arl ?? 'APROBADO',
     c.cobro ?? 'NO FACTURADA', c.cobro === 'FACTURADA' ? 'FE-9999' : null, c.prefactura ?? null],
  )).rows[0].id;
  const documento = async (terceroId, estado, ordenId) => {
    const d = (await client.query(
      `INSERT INTO sst.documentos_electronicos (tipo, reference_code, estado, tercero_id, prefijo, numero)
       VALUES ('FACTURA', $1, $2, $3, $4, $5) RETURNING id`,
      [`ORB-ZZ-${++n}`, estado, terceroId, estado === 'VALIDADO' ? 'ZZ' : null, estado === 'VALIDADO' ? String(n) : null],
    )).rows[0].id;
    await client.query(`INSERT INTO sst.documento_ordenes (documento_id, orden_id) VALUES ($1, $2)`, [d, ordenId]);
    return d;
  };

  // ── AXA: tarifa de venta HORA 58.856 (sembrada en A0-06) ───────────────────
  const a1 = await orden(axa, { horas: 10 });                       // facturable
  const a2 = await orden(axa, { estado_arl: 'PENDIENTE' });         // ARL no aprueba
  const a3 = await orden(axa, { cobro: 'FACTURADA' });              // ya facturada por fuera
  const a4 = await orden(axa); await documento(axa.tercero_id, 'BORRADOR', a4);   // en borrador
  const a5 = await orden(axa); await documento(axa.tercero_id, 'VALIDADO', a5);   // ya facturada en Orbita
  const a6 = await orden(axa, { estado: 'EJECUTADA' });             // no finalizada
  // ── Colmena: sin tarifa → cae al valor que trajo la orden ─────────────────
  const c1 = await orden(colmena, { horas: 4, valor_total: 300000 });
  // ── Bolívar ────────────────────────────────────────────────────────────────
  const pf = (await client.query(
    `INSERT INTO sst.prefacturas (numero_prefactura, fecha_corte, valor_total) VALUES ('999001', '2026-09-15', 1000000) RETURNING id`,
  )).rows[0].id;
  const b1 = await orden(bolivar, { cronograma: 'ZZ1', secuencia: '1', prefactura: '999001' });
  const b2 = await orden(bolivar, { cronograma: 'ZZ1', secuencia: '2', prefactura: '999777' }); // otra prefactura
  const b3 = await orden(bolivar, { cronograma: 'ZZ1', secuencia: '3', prefactura: '999002' }); // sin prefactura cargada
  const b4 = await orden(bolivar, { cronograma: 'ZZ1', secuencia: '4', prefactura: '999001', cobro: 'FACTURADA' }); // ya facturada
  const fila = async (ordenId, sec, valor) => (await client.query(
    `INSERT INTO sst.prefactura_filas (prefactura_id, orden_id, codigo_cronograma, secuencia, razon_social,
                                       actividad_programa, valor_a_facturar, transporte)
     VALUES ($1, $2, 'ZZ1', $3, 'EMPRESA DE PRUEBA', 'ASESORIA', $4, 0) RETURNING id`,
    [pf, ordenId, sec, valor],
  )).rows[0].id;
  const f1 = await fila(b1, '1', 700000);
  await fila(b2, '2', 200000);
  const f9 = await fila(null, '9', 100000);          // fila sin orden en Orbita
  await fila(b4, '4', 50000);

  const { pagadores } = await relacionPorFacturar({}, client);
  const de = (nombre) => pagadores.find((p) => p.arl_nombre === nombre);
  const lineas = (p) => p.grupos.flatMap((g) => g.lineas);
  const porOrden = (p, id) => lineas(p).find((l) => l.orden_id === id);

  console.log('\n— AXA (elige órdenes) —');
  igual(de('AXA Colpatria').modo, 'SELECCION', 'AXA se factura eligiendo órdenes');
  igual(porOrden(de('AXA Colpatria'), a1).facturable, true, 'a1 FINALIZADA + APROBADO es facturable');
  igual(porOrden(de('AXA Colpatria'), a1).valor_referencia, 588560, 'a1 valor = 10 h × 58.856 (tarifa de venta)');
  igual(porOrden(de('AXA Colpatria'), a1).origen_valor, 'TARIFA', 'a1 el valor viene de la tarifa');
  igual(porOrden(de('AXA Colpatria'), a2).motivo?.startsWith('La ARL todavía no aprueba'), true, 'a2 PENDIENTE no se puede facturar');
  igual(porOrden(de('AXA Colpatria'), a3), undefined, 'a3 ya FACTURADA no sale');
  igual(porOrden(de('AXA Colpatria'), a4).motivo, 'Ya está en un borrador de factura.', 'a4 en borrador queda bloqueada');
  igual(porOrden(de('AXA Colpatria'), a5), undefined, 'a5 con factura VALIDADO no sale');
  igual(porOrden(de('AXA Colpatria'), a6), undefined, 'a6 EJECUTADA no es candidata');

  console.log('\n— Colmena (sin tarifa) —');
  const lc1 = porOrden(de('Colmena'), c1);
  igual([lc1.valor_referencia, lc1.origen_valor], [300000, 'ORDEN'], 'sin tarifa cae al valor de la orden');

  console.log('\n— Bolívar (por prefactura) —');
  const bol = de('Bolívar');
  igual(bol.modo, 'PREFACTURA', 'Bolívar se factura por prefactura');
  const g = bol.grupos.find((x) => x.prefactura?.numero === '999001');
  igual(g.ya_facturadas, 1, 'la fila de la orden ya facturada se cuenta aparte');
  igual(g.lineas.length, 3, 'la prefactura lista 3 líneas (la ya facturada no)');
  const lb1 = g.lineas.find((l) => l.orden_id === b1);
  igual([lb1.facturable, lb1.valor_referencia, lb1.origen_valor], [true, 700000, 'PREFACTURA'], 'b1 usa el valor de la prefactura, no la tarifa');
  igual(g.lineas.find((l) => l.orden_id === b2).motivo, 'La orden quedó aprobada con otra prefactura.', 'b2 aprobada con otra prefactura');
  const lsin = g.lineas.find((l) => l.fila_id === f9);
  igual([lsin.orden_id, lsin.facturable, lsin.marcada_por_defecto], [null, true, false], 'fila sin orden: facturable pero no se marca sola');
  igual(g.total_marcadas, 700000, 'el total marcado es solo el de b1');
  const sueltas = bol.grupos.find((x) => x.sin_prefactura);
  // jdd_dev puede tener otras órdenes de Bolívar sin prefactura (las de ejemplo): se mira solo la de la prueba.
  const lb3 = sueltas.lineas.find((l) => l.orden_id === b3);
  igual(!!lb3 && !g.lineas.some((l) => l.orden_id === b3), true, 'b3 (prefactura no cargada) queda en "sin prefactura"');
  igual(lb3?.facturable, false, 'b3 no es facturable');

  console.log('\n— Selección —');
  const ok = await resolverSeleccion({ arlId: axa.id, ordenIds: [a1] }, client);
  igual([ok.pagador.arl_nombre, ok.lineas.length, ok.total], ['AXA Colpatria', 1, 588560], 'selección AXA válida');
  await rechaza(() => resolverSeleccion({ arlId: axa.id, ordenIds: [a1, a2] }, client), 'todavía no aprueba', 'AXA rechaza una orden pendiente');
  await rechaza(() => resolverSeleccion({ arlId: axa.id, ordenIds: [a1, c1] }, client), 'no es del pagador', 'AXA rechaza una orden de otro pagador');
  await rechaza(() => resolverSeleccion({ arlId: axa.id, ordenIds: [a1], prefacturaId: pf }, client), 'Solo Bolívar', 'solo Bolívar usa prefactura');
  await rechaza(() => resolverSeleccion({ arlId: bolivar.id }, client), 'por prefactura', 'Bolívar exige la prefactura');
  const bolOk = await resolverSeleccion({ arlId: bolivar.id, prefacturaId: pf }, client);
  igual([bolOk.lineas.length, bolOk.total, bolOk.prefactura.numero], [1, 700000, '999001'], 'Bolívar sin filas explícitas toma las marcadas por defecto');
  const bolConSin = await resolverSeleccion({ arlId: bolivar.id, prefacturaId: pf, filaIds: [f1, f9] }, client);
  igual([bolConSin.lineas.length, bolConSin.total], [2, 800000], 'Bolívar acepta incluir la fila sin orden si se pide');
  await rechaza(() => resolverSeleccion({ arlId: bolivar.id, prefacturaId: pf, filaIds: [f1, '00000000-0000-0000-0000-000000000000'] }, client), 'no pertenece', 'Bolívar rechaza una fila ajena');
} finally {
  await client.query('ROLLBACK');
  client.release();
  const restos = (await pool.query(`SELECT count(*)::int AS n FROM sst.ordenes_servicio WHERE codigo LIKE 'OS-ZZ-%'`)).rows[0].n;
  console.log(`\nResiduos en la base tras el ROLLBACK: ${restos}`);
  if (restos) fallos++;
  await pool.end();
}
console.log(fallos ? `\n${fallos} FALLO(S)` : '\nTodo OK');
process.exit(fallos ? 1 : 0);
