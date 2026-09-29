// Verifica A1-04 (borrador de factura) contra jdd_dev DENTRO de una transacción
// con ROLLBACK: crea órdenes/prefactura desechables, crea el borrador, lo edita
// y lo borra; comprueba que los totales cuadren con calculo.js y que las
// validaciones de negocio (pagador ajeno, orden ya usada, sin tarifa) funcionen.
// Uso: node scripts/verificar-borrador-factura.mjs (requiere el túnel a jdd_dev)
import { pool } from '../src/config/db.js';
import { calcularDocumento } from '../src/modules/facturacion/calculo.js';
import { deCentavos } from '../src/utils/dinero.js';
import { crearBorrador, actualizarBorrador, obtenerBorrador, eliminarBorrador, listarBorradores } from '../src/modules/facturacion/borrador.service.js';

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
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${texto} → ${e.message.slice(0, 130)}`);
  }
};

const client = await pool.connect();
try {
  await client.query('BEGIN');
  const axa = (await client.query(`SELECT id, tercero_id FROM sst.arls WHERE nombre = 'AXA Colpatria'`)).rows[0];
  const bolivar = (await client.query(`SELECT id, tercero_id FROM sst.arls WHERE nombre = 'Bolívar'`)).rows[0];
  const colmena = (await client.query(`SELECT id, tercero_id FROM sst.arls WHERE nombre = 'Colmena'`)).rows[0];

  let n = 0;
  const orden = async (a, c = {}) => (await client.query(
    `INSERT INTO sst.ordenes_servicio
       (arl_id, codigo, numero_orden, codigo_cronograma, secuencia, empresa_nombre, tipo_actividad, tema_actividad,
        horas_asignadas, estado, estado_arl, estado_cobro)
     VALUES ($1,$2,$3,$4,$5,'EMPRESA DE PRUEBA','Capacitación','Riesgo biomecánico',$6,
             'FINALIZADA'::sst.estado_orden,'APROBADO'::sst.estado_arl,'NO FACTURADA'::sst.estado_cobro)
     RETURNING id`,
    [a.id, `OS-B04-${++n}`, c.numero_orden ?? null, c.cronograma ?? null, c.secuencia ?? null, c.horas ?? 10],
  )).rows[0].id;

  // ── AXA: 10 h × 58.856, descuento 2 %, retefuente 11 % + autorretención 1,1 % ──
  const a1 = await orden(axa, { numero_orden: 'AXA-B1', horas: 10 });
  const b1 = await crearBorrador({ arlId: axa.id, ordenIds: [a1], usuarioId: null }, client);
  const esperadoAxa = calcularDocumento({
    items: [{ cantidad: 10, valorUnitario: 58856, ivaPct: 0 }],
    descuentoComercialPct: 2,
    retenciones: [{ codigo: 'RF-HON', tipo: 'RETEFUENTE', tarifa: 11 }, { codigo: 'AUTO-1.1', tipo: 'AUTORRETENCION', tarifa: 1.1 }],
  });
  igual(b1.estado, 'BORRADOR', 'AXA: nace en BORRADOR');
  igual(b1.tercero_nombre, 'AXA COLPATRIA SEGUROS DE VIDA SA', 'AXA: pagador correcto');
  igual(b1.items.length, 1, 'AXA: un ítem por orden');
  igual(b1.items[0].iva_pct, 0, 'AXA (ARL) usa el producto EXENTO');
  igual(b1.totales.total_a_pagar, deCentavos(esperadoAxa.totalAPagar), 'AXA: total a pagar cuadra con calculo.js (retefuente resta, autorretención no)');
  igual(b1.totales.total_descuento, deCentavos(esperadoAxa.totalDescuento), 'AXA: descuento comercial 2 % aplicado');
  igual(b1.retenciones.map((r) => r.tipo).sort(), ['AUTORRETENCION', 'RETEFUENTE'], 'AXA: ambas retenciones quedaron registradas');
  igual(!!b1.items[0].descripcion, true, 'AXA: la descripción no quedó vacía');
  console.log(`  descripción generada: "${b1.items[0].descripcion}"`);

  // Una segunda orden de AXA no se puede facturar con la primera ya en borrador.
  const a2 = await orden(axa, { numero_orden: 'AXA-B2', horas: 5 });
  await rechaza(() => crearBorrador({ arlId: axa.id, ordenIds: [a1, a2], usuarioId: null }, client), 'Ya está en un borrador', 'AXA: no deja reusar una orden ya en borrador');

  // Colmena sin tarifa de venta ni valor_total: crearBorrador debe rechazarlo (nunca inventa una cifra).
  const c1 = await orden(colmena, { numero_orden: 'COL-B1', horas: 4 });
  await rechaza(() => crearBorrador({ arlId: colmena.id, ordenIds: [c1], usuarioId: null }, client), 'no tiene', 'Colmena sin tarifa: rechaza crear el borrador');

  // ── Edición: cambia cantidad/valor y agrega descuento distinto ──────────────
  const editado = await actualizarBorrador(b1.id, {
    items: [{ orden_id: a1, producto_id: b1.items[0].producto_id, descripcion: 'Capacitación editada a mano', cantidad: 10, valor_unitario: 60000 }],
    descuento_comercial_pct: 0,
    retenciones_ids: [],
    observaciones: 'Prueba A1-04',
    plazo_dias: 30,
  }, null, client);
  const esperadoEditado = calcularDocumento({ items: [{ cantidad: 10, valorUnitario: 60000, ivaPct: 0 }], descuentoComercialPct: 0, retenciones: [] });
  igual(editado.totales.total_a_pagar, deCentavos(esperadoEditado.totalAPagar), 'Editado: el total refleja el nuevo valor unitario');
  igual(editado.items[0].descripcion, 'Capacitación editada a mano', 'Editado: la descripción a mano se conserva');
  igual(editado.forma_pago_nombre, 'Pago a crédito', 'Editado: 30 días de plazo pasa la forma de pago a crédito');
  igual(
    editado.fecha_vencimiento,
    new Date(new Date(`${editado.fecha_emision}T00:00:00Z`).getTime() + 30 * 86400000).toISOString().slice(0, 10),
    'Editado: el vencimiento es emisión + 30 días',
  );

  // El GET recalcula en vivo (no depende de que alguien vuelva a editar).
  const relectura = await obtenerBorrador(b1.id, client);
  igual(relectura.totales, editado.totales, 'GET: el recálculo en vivo coincide con lo que devolvió el PUT');

  // Meter la orden de otro pagador en la edición debe rechazarse.
  await rechaza(
    () => actualizarBorrador(b1.id, { items: [{ orden_id: c1, descripcion: 'x', cantidad: 1, valor_unitario: 1000 }] }, null, client),
    'no es del pagador',
    'Editado: rechaza meter una orden de otro pagador',
  );

  // ── Bolívar: una línea por fila de prefactura, valor tal cual (no por hora) ──
  const pf = (await client.query(`INSERT INTO sst.prefacturas (numero_prefactura, fecha_corte, valor_total) VALUES ('999501', '2026-09-15', 900000) RETURNING id`)).rows[0].id;
  const bOrden = await orden(bolivar, { numero_orden: null, cronograma: 'ZZC1', secuencia: '1', horas: 6 });
  await client.query(
    `INSERT INTO sst.prefactura_filas (prefactura_id, orden_id, codigo_cronograma, secuencia, razon_social, actividad_programa, valor_a_facturar, transporte)
     VALUES ($1,$2,'ZZC1','1','EMPRESA DE PRUEBA','CAPACITACION', 900000, 0)`,
    [pf, bOrden],
  );
  const bolDraft = await crearBorrador({ arlId: bolivar.id, prefacturaId: pf, usuarioId: null }, client);
  igual(bolDraft.items.length, 1, 'Bolívar: una línea (la de la prefactura)');
  igual([bolDraft.items[0].cantidad, bolDraft.items[0].valor_unitario], ['1.0000', '900000.00'], 'Bolívar: 1 unidad por el valor íntegro de la prefactura (no por hora)');
  // Bolívar SÍ tiene condición real sembrada (A0-07): retefuente 11 % (RF-HON).
  // 900.000 sin IVA (exento) − 11 % de retefuente = 801.000.
  igual(bolDraft.totales.total_a_pagar, '801000.00', 'Bolívar: retefuente 11 % de la condición real del pagador se descuenta');
  igual(bolDraft.retenciones.map((r) => r.tipo), ['RETEFUENTE'], 'Bolívar: la retención registrada es la de su condición real');

  // Listado y borrado.
  const listado = await listarBorradores({ estado: 'BORRADOR' }, client);
  igual(listado.some((d) => d.id === editado.id) && listado.some((d) => d.id === bolDraft.id), true, 'Listado: ambos borradores aparecen');
  await eliminarBorrador(bolDraft.id, client);
  await rechaza(() => obtenerBorrador(bolDraft.id, client), 'no existe', 'Borrado: el borrador de Bolívar ya no está');
  await eliminarBorrador(editado.id, client);

  // Un documento que no está en BORRADOR no se puede borrar (probado aparte,
  // sin depender de A1-05 todavía inexistente): se fuerza el estado a mano.
  const paraValidar = await crearBorrador({ arlId: axa.id, ordenIds: [a2], usuarioId: null }, client);
  await client.query(`UPDATE sst.documentos_electronicos SET estado = 'VALIDADO' WHERE id = $1`, [paraValidar.id]);
  await rechaza(() => eliminarBorrador(paraValidar.id, client), 'Solo se puede eliminar', 'No se puede borrar un documento ya VALIDADO');
} finally {
  await client.query('ROLLBACK');
  client.release();
  const restos = (await pool.query(`SELECT count(*)::int AS n FROM sst.ordenes_servicio WHERE codigo LIKE 'OS-B04-%'`)).rows[0].n;
  console.log(`\nResiduos en la base tras el ROLLBACK: ${restos}`);
  if (restos) fallos++;
  await pool.end();
}
console.log(fallos ? `\n${fallos} FALLO(S)` : '\nTodo OK');
process.exit(fallos ? 1 : 0);
