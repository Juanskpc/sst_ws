// Verifica lo de la tanda del 23/24-oct-2026 contra jdd_dev DENTRO de una transacción con ROLLBACK:
// centro de costo por ítem de compra, cuenta del anticipo y su eliminación, eliminación de cuentas
// contables, ajuste de valor hora y viáticos de una cuenta de cobro, formatos de ARL SURA y las
// alertas de vencimiento.
// Uso: node --import tsx scripts/verificar-24-oct.mjs   (requiere el túnel)
import { pool } from '../src/config/db.js';
import { sembrarReglasSiigo } from '../src/modules/contabilidad/reglas.service.js';
import { crearCompra, obtenerCompra } from '../src/modules/compras/compras.service.js';
import { anularAnticipo, crearAnticipo, cuentaDeAnticipo, listarAnticipos } from '../src/modules/cartera/pagos.service.js';
import { eliminarCuenta } from '../src/modules/contabilidad/cuentas.service.js';
import { ajustarItemsPrecuenta } from '../src/modules/billing/billing.service.js';
import { revisarVencimientos } from '../src/modules/parametros/alertas.service.js';
import { entregaDeLaOrden } from '../src/services/entrega-arl.service.js';

let fallos = 0;
const igual = (obtenido, esperado, texto) => {
  const ok = JSON.stringify(obtenido) === JSON.stringify(esperado);
  if (!ok) fallos++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${texto}${ok ? '' : `\n     obtenido ${JSON.stringify(obtenido)}\n     esperado ${JSON.stringify(esperado)}`}`);
};
const client = await pool.connect();
const q1 = async (sql, p = []) => (await client.query(sql, p)).rows[0];
const op = { client };

try {
  await client.query('BEGIN');
  await sembrarReglasSiigo(null, client);
  const cuenta = async (codigo) => (await q1('SELECT id FROM sst.cuentas_contables WHERE codigo = $1', [codigo])).id;
  const nit = (await q1("SELECT id FROM sst.tipos_documento_identidad WHERE codigo_dian = '31'")).id;
  const proveedor = (await q1(
    `INSERT INTO sst.terceros (tipo_persona, tipo_documento_id, numero_documento, dv, razon_social, responsabilidades_fiscales, regimen, es_proveedor, activo)
     VALUES ('JURIDICA', $1, '900999777', 1, 'PROVEEDOR DE PRUEBA 24-OCT', '{}', 'RESPONSABLE_IVA', true, true) RETURNING id`, [nit])).id;
  const arlBol = (await q1("SELECT id FROM sst.arls WHERE nombre ILIKE '%bol%var%'")).id;
  const arlSura = (await q1("SELECT id FROM sst.arls WHERE nombre = 'ARL SURA'"))?.id;
  igual(!!arlSura, true, 'ARL SURA existe en el catálogo');
  const cBol = (await q1("INSERT INTO sst.centros_costo (codigo, nombre, arl_id) VALUES ('ZZBOL', 'Bolívar prueba', $1) RETURNING id", [arlBol])).id;
  const cAxa = (await q1("INSERT INTO sst.centros_costo (codigo, nombre) VALUES ('ZZAXA', 'AXA prueba') RETURNING id")).id;

  console.log('\n— Compras: centro de costo por ítem —');
  const c1 = await crearCompra({
    tipo: 'COMPRA', tercero_id: proveedor, numero_proveedor: 'ZZ-1', fecha: '2026-10-20', forma_pago: 'CREDITO', vencimiento: '2026-11-20',
    items: [
      { cuenta_id: await cuenta('51953501'), descripcion: 'Combustible Bolívar', valor: '10000', centro_costo_id: cBol },
      { cuenta_id: await cuenta('51953501'), descripcion: 'Combustible AXA', valor: '20000', centro_costo_id: cAxa },
    ],
  }, null, op);
  const d1 = await obtenerCompra(c1.id, client);
  igual(d1.items.map((i) => i.centro_costo_codigo), ['ZZBOL', 'ZZAXA'], 'cada ítem guarda su centro de costo');
  igual(d1.centro_costo_id, null, 'con centros distintos la cabecera queda sin centro');
  const mov = (await client.query('SELECT cuenta_id, centro_costo_id FROM sst.movimientos WHERE comprobante_id = $1 AND debito > 0 ORDER BY linea', [c1.comprobante_id])).rows;
  igual(mov.map((m) => m.centro_costo_id), [cBol, cAxa], 'el asiento lleva el centro de CADA línea de gasto');
  const c2 = await crearCompra({
    tipo: 'COMPRA', tercero_id: proveedor, numero_proveedor: 'ZZ-2', fecha: '2026-10-20', forma_pago: 'CREDITO', vencimiento: '2026-11-20',
    centro_costo_id: cBol, items: [{ cuenta_id: await cuenta('51953501'), descripcion: 'Un solo ítem', valor: '5000' }],
  }, null, op);
  igual((await obtenerCompra(c2.id, client)).items[0].centro_costo_codigo, 'ZZBOL', 'el centro de la cabecera lo toma un ítem que no trae el suyo');

  console.log('\n— Anticipos: cuenta visible y eliminación —');
  const banco = await cuenta('11100501');
  const rp = await crearAnticipo({ tercero_id: proveedor, fecha: '2026-10-20', cuenta_banco_id: banco, valor: '50000' }, null, op);
  const lista = await listarAnticipos({ terceroId: proveedor }, client);
  igual([lista[0].cuenta_codigo, lista[0].banco_codigo], ['13300501', '11100501'], 'el anticipo muestra su cuenta (13300501) y el banco');
  igual((await cuentaDeAnticipo(proveedor, client)).codigo, '13300501', 'la cuenta se conoce ANTES de registrar el anticipo');
  const anulado = await anularAnticipo(rp.id, 'Se registró dos veces', null, op);
  igual([anulado.estado, anulado.saldo], ['ANULADO', '0.00'], 'eliminar un anticipo lo anula y deja su saldo en cero');

  console.log('\n— Plan de cuentas: eliminar —');
  const padre = await cuenta('5195');
  const hija = (await q1("INSERT INTO sst.cuentas_contables (codigo, nombre, naturaleza, padre_id, acepta_movimiento) VALUES ('519599', 'Prueba borrar', 'DEBITO', $1, true) RETURNING id", [padre])).id;
  const eliminada = await eliminarCuenta(hija, client);
  igual(eliminada.codigo, '519599', 'una cuenta sin uso se elimina');
  igual((await q1("SELECT count(*)::int AS n FROM sst.cuentas_contables WHERE codigo = '519599'")).n, 0, 'y ya no está en el plan');
  let motivo = '';
  await client.query('SAVEPOINT s1');
  try { await eliminarCuenta(padre, client); } catch (e) { motivo = e.message; }
  await client.query('ROLLBACK TO SAVEPOINT s1');
  igual(/subcuentas/.test(motivo), true, 'una cuenta con subcuentas no se elimina y dice por qué');
  motivo = '';
  await client.query('SAVEPOINT s2');
  try { await eliminarCuenta(await cuenta('51953501'), client); } catch (e) { motivo = e.message; }
  await client.query('ROLLBACK TO SAVEPOINT s2');
  igual(/movimiento/.test(motivo), true, 'una cuenta con movimientos no se elimina (se inactiva)');

  console.log('\n— Cuentas de cobro: ajustar valor hora y viáticos —');
  // Una cuenta de cobro de prueba dentro de la transacción (con una orden y un asesor que ya existan).
  const ordenAny = await q1('SELECT id, codigo FROM sst.ordenes_servicio ORDER BY fecha_carga LIMIT 1');
  const profAny = await q1('SELECT id FROM sst.profesionales ORDER BY creado_en LIMIT 1');
  let pc = null;
  if (ordenAny && profAny) {
    pc = await q1(
      `INSERT INTO sst.precuentas (profesional_id, periodo, total_horas, total_monto, total_viaticos, estado, token)
       VALUES ($1, '2099-01', 4, 112000, 0, 'generada', 'zz-token-prueba-24oct') RETURNING id, estado`, [profAny.id]);
    await client.query(
      `INSERT INTO sst.precuenta_items (precuenta_id, orden_id, orden_codigo, empresa_nombre, arl_nombre, actividad, fecha_ejecucion, horas, valor_hora_snapshot, monto, viaticos, origen_tarifa)
       VALUES ($1, $2, $3, 'EMPRESA PRUEBA', 'ARL SURA', 'Risoterapia', '2099-01-10', 4, 28000, 112000, 0, 'tarifa')`, [pc.id, ordenAny.id, ordenAny.codigo]);
  }
  if (!pc) {
    console.log('SKIP no hay órdenes ni asesores en jdd_dev para probar el ajuste');
  } else {
    const it = await q1('SELECT id, horas FROM sst.precuenta_items WHERE precuenta_id = $1 ORDER BY fecha_ejecucion LIMIT 1', [pc.id]);
    const r = await ajustarItemsPrecuenta(pc.id, [{ id: it.id, valor_hora: 150000, viaticos: 35000 }], null, op);
    const linea = r.items.find((x) => x.id === it.id);
    igual([Number(linea.valor_hora_snapshot), Number(linea.monto), Number(linea.viaticos), linea.ajuste_manual],
      [150000, Math.round(Number(it.horas) * 150000), 35000, true], 'la línea toma el valor hora y los viáticos nuevos y queda marcada como ajustada');
    const honorarios = r.items.reduce((s, x) => s + Number(x.monto), 0);
    igual(Number(r.total_monto), honorarios + r.items.reduce((s, x) => s + Number(x.viaticos), 0), 'el total de la cuenta = honorarios + viáticos');
  }

  console.log('\n— ARL SURA: formatos por tipo de actividad —');
  const cap = entregaDeLaOrden({ arl_nombre: 'ARL SURA', tipo_servicio_arl: 'C' });
  const ase = entregaDeLaOrden({ arl_nombre: 'ARL SURA', tipo_servicio_arl: 'A' });
  igual([cap.formatos, cap.soportes], [['asistenciaSura'], ['asistencia']], 'capacitación: solo el registro de asistencia, que vuelve firmado');
  igual([ase.formatos, ase.soportes], [['informeSura'], ['informe']], 'asesoría: el modelo de informe, que vuelve redactado');

  console.log('\n— Alertas de vencimiento —');
  const res = await revisarVencimientos(client);
  igual(!res.error, true, 'la revisión corre sin error');
  console.log(`     (${res.creadas} aviso(s) nuevos)`);
} catch (e) {
  fallos++;
  console.error('ERROR', e);
} finally {
  await client.query('ROLLBACK');
  const residuo = (await pool.query("SELECT count(*)::int AS n FROM sst.terceros WHERE numero_documento = '900999777'")).rows[0].n;
  console.log(`\nResiduos tras el ROLLBACK: ${residuo}`);
  client.release();
  await pool.end();
  console.log(fallos ? `\n${fallos} FALLO(S)` : '\nTODO OK');
  process.exit(fallos ? 1 : 0);
}
