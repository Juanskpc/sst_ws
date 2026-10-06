// Verifica C1-01 (balance), C2-01 (auxiliar), C3-01 (por tercero) y C4-01 (libros) contra
// jdd_dev DENTRO de una transacción con ROLLBACK. Los asientos de prueba van en
// 2024, que no tiene movimientos reales, para que las cifras esperadas sean exactas;
// además se cruzan el balance y el auxiliar sobre el libro entero de desarrollo.
// Uso: node --import tsx scripts/verificar-informes-contables.mjs   (requiere el túnel)
import { pool } from '../src/config/db.js';
import { anularComprobante, crearComprobante } from '../src/modules/contabilidad/comprobantes.service.js';
import { cerrarAnio } from '../src/modules/contabilidad/cierre.service.js';
import { balanceComprobacion } from '../src/modules/informes-contables/balance.service.js';
import { auxiliarPorCuenta, informePorTercero } from '../src/modules/informes-contables/auxiliar.service.js';
import { libroAuxiliar } from '../src/modules/informes-contables/libros.service.js';
import { estadoResultados, estadoSituacionFinanciera } from '../src/modules/informes-contables/estados.service.js';
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
  // Con el PUC real de Siigo cargado (6-oct-2026) la clase 3 ya existe: se reutiliza
  // la cuenta que haya y solo se crea la que falte.
  const nueva = async (codigo, nombre, padre, mov = false) =>
    (await q1(`SELECT id FROM sst.cuentas_contables WHERE codigo = $1`, [codigo]))?.id
    ?? (await q1(
      `INSERT INTO sst.cuentas_contables (codigo, nombre, naturaleza, padre_id, acepta_movimiento) VALUES ($1, $2, 'CREDITO', $3, $4) RETURNING id`,
      [codigo, nombre, padre, mov])).id;
  const c36 = await nueva('36', 'Resultados del ejercicio', await nueva('3', 'Patrimonio', null));
  const utilidad = await nueva('36050501', 'Utilidad del ejercicio', await nueva('360505', 'Utilidad', await nueva('3605', 'Utilidad', c36)), true);
  const perdida = await nueva('36100501', 'Pérdida del ejercicio', await nueva('361005', 'Pérdida', await nueva('3610', 'Pérdida', c36)), true);
  // En el PUC real 360505 y 361005 son hojas con movimiento; aquí reciben una
  // auxiliar de prueba, así que dentro de la transacción pasan a agrupar.
  await client.query(`UPDATE sst.cuentas_contables SET acepta_movimiento = false WHERE codigo IN ('360505', '361005')`);
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

  console.log('\n— C5-01 · Estados financieros (2024) —');
  const esfJun = await estadoSituacionFinanciera({ corte: '2024-06-30' }, client);
  const sec = (e, clave) => e.secciones.find((x) => x.clave === clave);
  igual([sec(esfJun, 'ACTIVO').total, sec(esfJun, 'PASIVO').total, esfJun.resultado_ejercicio, esfJun.cuadra],
    ['699999.45', '0.00', '699999.45', true], 'ESF al 30-jun: activo = resultado del ejercicio aún sin cerrar, y cuadra');
  igual(sec(esfJun, 'ACTIVO').renglones.map((r) => [r.grupo, r.valor]), [['11', '699999.45']], 'sin renglones definidos, el activo va por grupo del PUC');
  const erJun = await estadoResultados({ desde: '2024-01-01', hasta: '2024-06-30' }, client);
  igual([sec(erJun, 'INGRESOS').total, sec(erJun, 'GASTOS').total, erJun.utilidad], ['1000000.00', '300000.55', '699999.45'],
    'ER enero-junio: ingresos − gastos = utilidad');
  const erAnio = await estadoResultados({ desde: '2024-01-01', hasta: '2024-12-31' }, client);
  igual(erAnio.utilidad, '699999.45', 'el ER del año cerrado NO sale en cero (excluye el CA)');
  const esfDic = await estadoSituacionFinanciera({ corte: '2024-12-31', comparativo: 'true' }, client);
  igual([sec(esfDic, 'PATRIMONIO').total, esfDic.resultado_ejercicio, esfDic.cuadra], ['699999.45', '0.00', true],
    'ESF al 31-dic, tras el cierre: la utilidad está en el patrimonio y el resultado en cero');
  igual(esfDic.total_activo_anterior, '0.00', 'comparativo con el año anterior (2023, vacío)');
  await client.query(`UPDATE sst.cuentas_contables SET renglon_esf = 'Efectivo y equivalentes al efectivo' WHERE codigo = '11'`);
  const conRenglon = await estadoSituacionFinanciera({ corte: '2024-06-30' }, client);
  igual(sec(conRenglon, 'ACTIVO').renglones.map((r) => [r.nombre, r.grupo]), [['Efectivo y equivalentes al efectivo', null]],
    'el renglón definido en la cuenta (o un ancestro) manda sobre el grupo del PUC');

  console.log('\n— C3-01 y C4-01 · Tercero y libros (febrero de 2025) —');
  const feb = { desde: '2025-02-01', hasta: '2025-02-28' };
  const enFeb = (await q1(
    `SELECT count(*)::int AS n FROM sst.comprobantes WHERE fecha BETWEEN '2025-02-01' AND '2025-02-28'`,
  )).n;
  igual(enFeb, 0, 'febrero de 2025 está vacío (cifras exactas)');
  const [ta, tb] = (await client.query(`SELECT id FROM sst.terceros ORDER BY id LIMIT 2`)).rows.map((r) => r.id);
  const cxc = await cuenta('13050501');
  const ivaGen = await cuenta('24080601');
  const reteFte = await cuenta('13551509');
  // Venta a A con IVA (base 100.000) y retención; venta a B sin IVA; recaudo parcial de A.
  await ni('2025-02-05', [
    { cuenta_id: cxc, tercero_id: ta, debito: '108000' },
    { cuenta_id: reteFte, tercero_id: ta, debito: '11000', base: '100000' },
    { cuenta_id: ingreso, tercero_id: ta, credito: '100000' },
    { cuenta_id: ivaGen, tercero_id: ta, credito: '19000', base: '100000' },
  ]);
  await ni('2025-02-10', [{ cuenta_id: cxc, tercero_id: tb, debito: '50000' }, { cuenta_id: ingreso, tercero_id: tb, credito: '50000' }]);
  await ni('2025-02-20', [{ cuenta_id: banco, debito: '60000' }, { cuenta_id: cxc, tercero_id: ta, credito: '60000' }]);

  const gen = await informePorTercero({ ...feb, modo: 'general' }, client);
  const tA = gen.terceros.find((t) => t.tercero_id === ta);
  igual(tA.cuentas.map((c) => [c.codigo, c.debito, c.credito, c.saldo_final]),
    [['13050501', '108000.00', '60000.00', '48000.00'], ['13551509', '11000.00', '0.00', '11000.00'],
      ['24080601', '0.00', '19000.00', '-19000.00'], ['41800101', '0.00', '100000.00', '-100000.00']],
    'general: el tercero A con cada cuenta y su saldo');
  igual(tA.totales.saldo_final, '-60000.00', 'el total de A es su parte de los asientos (sin la contrapartida del banco)');
  igual([gen.terceros.at(-1).tercero_id, gen.terceros.at(-1).nombre], [null, 'Sin tercero'], 'las líneas sin tercero van aparte, al final');
  igual(gen.totales.debito, gen.totales.credito, 'con «Sin tercero» los totales son los del libro (débitos = créditos)');
  igual(tA.cuentas[0].movimientos, undefined, 'el general no carga las líneas');
  const soloCon = await informePorTercero({ ...feb, solo_con_tercero: 'true' }, client);
  igual(soloCon.terceros.some((t) => !t.tercero_id), false, 'solo_con_tercero aparta las líneas sin tercero');
  const det = await informePorTercero({ ...feb, modo: 'detallado', tercero_id: ta }, client);
  igual(det.terceros.map((t) => t.tercero_id), [ta], 'detallado filtrado por un tercero');
  igual(det.terceros[0].cuentas[0].movimientos.map((m) => m.saldo), ['108000.00', '48000.00'], 'detallado: la cartera de A con su saldo corrido');

  const iva = await libroAuxiliar({ ...feb, libro: 'IVA' }, client);
  igual(iva.cuentas.map((c) => c.codigo), ['24080601'], 'libro de IVA: solo la rama 2408');
  igual([iva.cuentas[0].movimientos[0].credito, iva.cuentas[0].movimientos[0].base], ['19000.00', '100000.00'], 'el IVA generado con su base gravable');
  const rf = await libroAuxiliar({ ...feb, libro: 'RETEFUENTE' }, client);
  igual(rf.cuentas.map((c) => [c.codigo, c.saldo_final]), [['13551509', '11000.00']], 'retención en la fuente: la que practicó el cliente (135515)');
  const imp = await libroAuxiliar({ ...feb, libro: 'IMPUESTOS' }, client);
  igual(imp.cuentas.map((c) => c.codigo), ['13551509', '24080601'], 'todos los impuestos juntos');
  const lcxc = await libroAuxiliar({ ...feb, libro: 'CXC' }, client);
  igual(lcxc.agrupado_por, 'tercero', 'la cartera por cobrar se lee por cliente');
  igual(lcxc.terceros.map((t) => [t.tercero_id, t.totales.saldo_final]).sort(), [[ta, '48000.00'], [tb, '50000.00']].sort(),
    'CxC: lo que debe cada cliente al cierre de febrero');
  await rechaza(() => libroAuxiliar({ ...feb, libro: 'XYZ' }, client), 'Libro inválido', 'libro que no existe');

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
