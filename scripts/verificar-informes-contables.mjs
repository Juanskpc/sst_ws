// Verifica C1-01 (balance de comprobación) y C2-01 (auxiliar por cuenta) contra
// jdd_dev DENTRO de una transacción con ROLLBACK. Los asientos de prueba van en
// 2024, que no tiene movimientos reales, para que las cifras esperadas sean exactas;
// además se cruzan el balance y el auxiliar sobre el libro entero de desarrollo.
// Uso: node --import tsx scripts/verificar-informes-contables.mjs   (requiere el túnel)
import { pool } from '../src/config/db.js';
import { anularComprobante, crearComprobante } from '../src/modules/contabilidad/comprobantes.service.js';
import { cerrarAnio } from '../src/modules/contabilidad/cierre.service.js';
import { balanceComprobacion } from '../src/modules/informes-contables/balance.service.js';
import { auxiliarPorCuenta } from '../src/modules/informes-contables/auxiliar.service.js';
import { aCentavos } from '../src/utils/dinero.js';

let fallos = 0;
const igual = (obtenido, esperado, texto) => {
  const ok = JSON.stringify(obtenido) === JSON.stringify(esperado);
  if (!ok) fallos++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${texto}${ok ? '' : `\n     obtenido ${JSON.stringify(obtenido)}\n     esperado ${JSON.stringify(esperado)}`}`);
};
const rechaza = async (fn, fragmento, texto) => {
  try {
    await fn();
    fallos++; console.log(`FAIL ${texto} → no lanzó error`);
  } catch (e) {
    const ok = e.message.includes(fragmento);
    if (!ok) fallos++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${texto} → ${e.message.slice(0, 120)}`);
  }
};
const fila = (b, codigo) => {
  const f = b.filas.find((x) => x.codigo === codigo);
  return f ? [f.saldo_inicial, f.debito, f.credito, f.saldo_final] : null;
};

const client = await pool.connect();
try {
  await client.query('BEGIN');
  const q1 = async (sql, p = []) => (await client.query(sql, p)).rows[0];
  const cuenta = async (codigo) => (await q1(`SELECT id FROM sst.cuentas_contables WHERE codigo = $1`, [codigo])).id;
  const op = { client };

  const previos = (await q1(
    `SELECT count(*)::int AS n FROM sst.movimientos m JOIN sst.comprobantes c ON c.id = m.comprobante_id WHERE c.fecha < '2025-01-01'`,
  )).n;
  igual(previos, 0, 'no hay movimientos antes de 2025 (las cifras esperadas de 2024 son exactas)');

  const banco = await cuenta('11100501');
  const ingreso = await cuenta('41800101');
  const combustible = await cuenta('51953501');
  const ni = (fecha, lineas, extra = {}) => crearComprobante({ tipo: 'NI', fecha, lineas, contabilizar: true, ...extra }, null, op);

  await ni('2024-05-10', [{ cuenta_id: banco, debito: '1000000' }, { cuenta_id: ingreso, credito: '1000000' }]);
  await ni('2024-06-15', [{ cuenta_id: combustible, debito: '300000.55' }, { cuenta_id: banco, credito: '300000.55' }]);
  // Ni el anulado ni el borrador son libro: no deben aparecer.
  const anulado = await ni('2024-06-20', [{ cuenta_id: combustible, debito: '77777' }, { cuenta_id: banco, credito: '77777' }]);
  await anularComprobante(anulado.id, 'prueba de informes', null, op);
  const borrador = await crearComprobante({ tipo: 'NI', fecha: '2024-06-21', lineas: [{ cuenta_id: combustible, debito: '55555' }, { cuenta_id: banco, credito: '55555' }] }, null, op);

  console.log('\n— C1-01 · Balance de comprobación (junio de 2024) —');
  const junio = { desde: '2024-06-01', hasta: '2024-06-30' };
  const b = await balanceComprobacion(junio, client);
  igual(fila(b, '11100501'), ['1000000.00', '0.00', '300000.55', '699999.45'], 'banco: inicial de mayo, crédito de junio y saldo final');
  igual(fila(b, '41800101'), ['-1000000.00', '0.00', '0.00', '-1000000.00'], 'ingreso sin movimiento en junio sale con su saldo (crédito en negativo)');
  igual(fila(b, '51953501'), ['0.00', '300000.55', '0.00', '300000.55'], 'gasto: solo el contabilizado (sin el anulado ni el borrador)');
  igual(fila(b, '1'), fila(b, '11100501'), 'la clase 1 suma lo de sus auxiliares');
  igual(fila(b, '5'), fila(b, '51953501'), 'la clase 5 suma lo de sus auxiliares');
  igual([b.totales, b.cuadra], [{ saldo_inicial: '0.00', debito: '300000.55', credito: '300000.55', saldo_final: '0.00' }, true],
    'totales: débitos = créditos y saldos en cero → cuadra');
  igual(b.filas.map((f) => f.codigo), [...b.filas.map((f) => f.codigo)].sort(), 'filas en orden de código');

  const n1 = await balanceComprobacion({ ...junio, nivel: 1 }, client);
  igual(n1.filas.map((f) => f.codigo), ['1', '4', '5'], 'nivel 1: solo las clases');
  igual(n1.totales, b.totales, 'y los mismos totales');
  const n4 = await balanceComprobacion({ ...junio, nivel: 4 }, client);
  igual(n4.filas.every((f) => f.nivel <= 4), true, 'nivel 4: nada más fino que la cuenta');

  const filtrado = await balanceComprobacion({ ...junio, cuenta: '11' }, client);
  igual([filtrado.filas.map((f) => f.codigo), filtrado.completo, filtrado.cuadra], [['1', '11', '1110', '111005', '11100501'], false, null],
    'filtro por cuenta 11: solo esa rama y sin exigir cuadre');

  await rechaza(() => balanceComprobacion({ desde: '2024-07-01', hasta: '2024-06-01' }, client), 'posterior', 'rango al revés');
  await rechaza(() => balanceComprobacion({ ...junio, nivel: 3 }, client), 'Nivel', 'nivel que no existe en el PUC');
  await rechaza(() => balanceComprobacion({ ...junio, cuenta: '11a' }, client), 'dígitos', 'código de cuenta con letras');
  await rechaza(() => balanceComprobacion({ ...junio, tercero_id: 'x' }, client), 'tercero', 'tercero con id inválido');

  console.log('\n— C2-01 · Auxiliar por cuenta (junio de 2024) —');
  const a = await auxiliarPorCuenta(junio, client);
  igual(a.cuentas.map((c) => c.codigo), ['11100501', '41800101', '51953501'], 'tres cuentas: dos con movimiento y una solo con saldo');
  const bancoAux = a.cuentas.find((c) => c.codigo === '11100501');
  igual([bancoAux.saldo_inicial, bancoAux.movimientos.length, bancoAux.movimientos[0].saldo, bancoAux.saldo_final],
    ['1000000.00', 1, '699999.45', '699999.45'], 'banco: un movimiento con el saldo corrido');
  igual(bancoAux.movimientos[0].comprobante.startsWith('NI-'), true, 'el movimiento trae su comprobante (NI-n) para abrirlo');
  igual(a.cuentas.find((c) => c.codigo === '41800101').movimientos.length, 0, 'el ingreso sale sin movimientos, con su saldo');
  igual(a.totales, b.totales, 'los totales del auxiliar = los del balance');

  console.log('\n— Cierre de año (2024) —');
  const nueva = async (codigo, nombre, padre, mov = false) => (await q1(
    `INSERT INTO sst.cuentas_contables (codigo, nombre, naturaleza, padre_id, acepta_movimiento) VALUES ($1, $2, 'CREDITO', $3, $4) RETURNING id`,
    [codigo, nombre, padre, mov])).id;
  const c36 = await nueva('36', 'Resultados del ejercicio', await nueva('3', 'Patrimonio', null));
  const utilidad = await nueva('36050501', 'Utilidad del ejercicio', await nueva('360505', 'Utilidad', await nueva('3605', 'Utilidad', c36)), true);
  const perdida = await nueva('36100501', 'Pérdida del ejercicio', await nueva('361005', 'Pérdida', await nueva('3610', 'Pérdida', c36)), true);
  // El cierre exige el año sin borradores (B10-01).
  await client.query(`DELETE FROM sst.comprobantes WHERE id = $1`, [borrador.id]);
  await cerrarAnio(2024, { cuenta_utilidad_id: utilidad, cuenta_perdida_id: perdida }, null, op);
  const dic = { desde: '2024-12-01', hasta: '2024-12-31' };
  const conCierre = await balanceComprobacion(dic, client);
  igual(fila(conCierre, '41800101'), ['-1000000.00', '1000000.00', '0.00', '0.00'], 'con el CA, el ingreso queda en cero el 31-dic');
  igual(fila(conCierre, '36050501'), ['0.00', '0.00', '699999.45', '-699999.45'], 'y la utilidad pasa al patrimonio');
  igual(conCierre.cuadra, true, 'el balance de diciembre cuadra con el cierre');
  const sinCierre = await balanceComprobacion({ ...dic, sin_cierre: 'true' }, client);
  igual([fila(sinCierre, '41800101'), fila(sinCierre, '36050501')], [['-1000000.00', '0.00', '0.00', '-1000000.00'], null],
    'sin el CA: el ingreso conserva su saldo y no hay utilidad');
  const enero = await balanceComprobacion({ desde: '2025-01-01', hasta: '2025-01-31', cuenta: '4' }, client);
  igual(enero.filas.length, 0, 'en 2025 el ingreso de 2024 ya no arrastra saldo (lo canceló el cierre)');

  console.log('\n— Libro entero de desarrollo —');
  const todo = { desde: '2000-01-01', hasta: '2100-12-31' };
  const bt = await balanceComprobacion(todo, client);
  igual(bt.cuadra, true, `el libro entero cuadra (${bt.totales.debito} = ${bt.totales.credito})`);
  const at = await auxiliarPorCuenta(todo, client);
  const hojas = bt.filas.filter((f) => f.acepta_movimiento);
  igual(
    hojas.map((f) => [f.codigo, f.saldo_final]),
    at.cuentas.map((c) => [c.codigo, c.saldo_final]),
    `cada cuenta de movimiento: saldo del balance = saldo del auxiliar (${hojas.length} cuentas)`,
  );
  // Cada fila agregada = suma de las cuentas de movimiento que cuelgan de ella.
  let descuadres = 0;
  for (const f of bt.filas.filter((x) => !x.acepta_movimiento)) {
    const suma = hojas.filter((h) => h.codigo.startsWith(f.codigo)).reduce((s, h) => s + aCentavos(h.debito), 0);
    if (suma !== aCentavos(f.debito)) descuadres++;
  }
  igual(descuadres, 0, 'cada clase, grupo, cuenta y subcuenta suma exactamente sus auxiliares');
  const corridos = at.cuentas.every((c) => {
    const ultimo = c.movimientos.at(-1);
    return !ultimo || ultimo.saldo === c.saldo_final;
  });
  igual(corridos, true, 'el saldo corrido de la última línea = el saldo final de cada cuenta');
} finally {
  await client.query('ROLLBACK');
  client.release();
  await pool.end();
}

console.log(`\n${fallos ? `${fallos} FALLO(S)` : 'Todo OK'}`);
process.exit(fallos ? 1 : 0);
