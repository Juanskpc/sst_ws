import { pool } from '../../config/db.js';
import { badRequest } from '../../utils/httpError.js';
import { aCentavos, deCentavos } from '../../utils/dinero.js';
import { hoyCO } from '../../utils/formato.js';

/**
 * C5-01 (RPC-04, RPC-05) · Estado de situación financiera y estado de resultados.
 *
 * ⚠️ FORMATO PROVISIONAL (Q-19 / D-21 sin respuesta): el formato y el grupo NIIF
 * los define la contadora. Mientras tanto cada cuenta cae en un renglón así:
 *   1. el `renglon_esf` / `renglon_er` de la cuenta o del ancestro más cercano que
 *      lo tenga (se editan en Contabilidad → Plan de cuentas);
 *   2. si ninguno lo tiene, el GRUPO del PUC (dos dígitos: 11 Disponible, 13
 *      Deudores, 24 Impuestos…), que es como lee un balance quien viene de Siigo.
 * Cuando la contadora defina sus renglones, se cargan en el plan de cuentas y
 * este informe los toma sin tocar código.
 *
 * Signos: aquí NO se usa débito − crédito (la convención de los libros) sino el
 * valor como se presenta: activos, pasivos y patrimonio en positivo, y la
 * utilidad positiva / pérdida negativa.
 *
 * Solo lo CONTABILIZADO. El estado de resultados excluye siempre el comprobante
 * de cierre de año: con él, un año cerrado daría todo en cero.
 */

const validarFecha = (v, texto) => {
  const f = String(v ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f) || Number.isNaN(Date.parse(f))) throw badRequest(`La ${texto} no es válida (AAAA-MM-DD).`);
  return f;
};
const unAnioAntes = (iso) => {
  const [a, m, d] = iso.split('-').map(Number);
  // 29-feb → 28-feb del año anterior.
  const dia = m === 2 && d === 29 ? 28 : d;
  return `${a - 1}-${String(m).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
};

/** Mapa código → cuenta, para buscar el renglón subiendo por los prefijos. */
async function catalogo(db) {
  const r = await db.query(`SELECT codigo, nombre, renglon_esf, renglon_er FROM sst.cuentas_contables`);
  return new Map(r.rows.map((c) => [c.codigo, c]));
}

const LONGITUDES = [10, 8, 6, 4, 2, 1];

/** Renglón de una cuenta: el propio o el del ancestro más cercano; si no, su grupo del PUC. */
function renglonDe(codigo, cuentas, campo) {
  for (const n of LONGITUDES) {
    if (n > codigo.length) continue;
    const c = cuentas.get(codigo.slice(0, n));
    if (c?.[campo]) return { clave: `R:${c[campo]}`, nombre: c[campo], orden: codigo.slice(0, 2), propio: true };
  }
  const grupo = codigo.slice(0, 2);
  return { clave: `G:${grupo}`, nombre: cuentas.get(grupo)?.nombre ?? `Grupo ${grupo}`, orden: grupo, propio: false };
}

/** Saldos (débito − crédito, en centavos) por cuenta de movimiento, con un filtro de fechas. */
async function saldos(db, { hasta, desde = null, sinCierre = false, clases }) {
  const params = [hasta, clases];
  let w = `c.estado = 'CONTABILIZADO' AND c.fecha <= $1 AND left(cc.codigo, 1) = ANY($2)`;
  if (desde) { params.push(desde); w += ` AND c.fecha >= $${params.length}`; }
  if (sinCierre) w += ` AND tc.codigo <> 'CA'`;
  const r = await db.query(
    `SELECT cc.codigo, sum(m.debito - m.credito) AS saldo
       FROM sst.movimientos m
       JOIN sst.comprobantes c ON c.id = m.comprobante_id
       JOIN sst.tipos_comprobante tc ON tc.id = c.tipo_id
       JOIN sst.cuentas_contables cc ON cc.id = m.cuenta_id
      WHERE ${w}
      GROUP BY cc.codigo`,
    params,
  );
  return new Map(r.rows.map((x) => [x.codigo, aCentavos(x.saldo)]));
}

/**
 * Agrupa saldos en renglones de una sección. `signo` = -1 para lo de naturaleza
 * crédito (pasivo, patrimonio, ingresos), así se presenta en positivo.
 */
function seccion(clave, nombre, prefijos, signo, actual, anterior, cuentas, campo) {
  const renglones = new Map();
  const sumar = (mapa, col) => {
    for (const [codigo, saldo] of mapa) {
      if (!prefijos.some((p) => codigo.startsWith(p))) continue;
      const r = renglonDe(codigo, cuentas, campo);
      if (!renglones.has(r.clave)) renglones.set(r.clave, { nombre: r.nombre, orden: r.orden, propio: r.propio, actual: 0, anterior: 0 });
      renglones.get(r.clave)[col] += signo * saldo;
    }
  };
  sumar(actual, 'actual');
  if (anterior) sumar(anterior, 'anterior');
  const lista = [...renglones.values()]
    .filter((r) => r.actual || r.anterior)
    .sort((a, b) => a.orden.localeCompare(b.orden) || a.nombre.localeCompare(b.nombre, 'es'));
  const total = { actual: lista.reduce((s, r) => s + r.actual, 0), anterior: lista.reduce((s, r) => s + r.anterior, 0) };
  return { clave, nombre, renglones: lista, total };
}

const enPesos = (s, conAnterior) => ({
  clave: s.clave,
  nombre: s.nombre,
  renglones: s.renglones.map((r) => ({
    nombre: r.nombre, grupo: r.propio ? null : r.orden, valor: deCentavos(r.actual), ...(conAnterior ? { anterior: deCentavos(r.anterior) } : {}),
  })),
  total: deCentavos(s.total.actual),
  ...(conAnterior ? { total_anterior: deCentavos(s.total.anterior) } : {}),
});

/** RPC-04 · Estado de situación financiera a una fecha de corte. */
export async function estadoSituacionFinanciera(q = {}, db = pool) {
  const corte = q.corte ? validarFecha(q.corte, 'fecha de corte') : hoyCO();
  const comparativo = q.comparativo === true || q.comparativo === 'true';
  const corteAnterior = unAnioAntes(corte);
  const cuentas = await catalogo(db);
  // Las clases 4-7 entran como «resultado del ejercicio»: lo que aún no cerró el
  // CA. Con él, la ecuación activo = pasivo + patrimonio + resultado se cumple
  // siempre que el libro cuadre.
  const clases = ['1', '2', '3', '4', '5', '6', '7'];
  const actual = await saldos(db, { hasta: corte, clases });
  const anterior = comparativo ? await saldos(db, { hasta: corteAnterior, clases }) : null;

  const activo = seccion('ACTIVO', 'Activo', ['1'], 1, actual, anterior, cuentas, 'renglon_esf');
  const pasivo = seccion('PASIVO', 'Pasivo', ['2'], -1, actual, anterior, cuentas, 'renglon_esf');
  const patrimonio = seccion('PATRIMONIO', 'Patrimonio', ['3'], -1, actual, anterior, cuentas, 'renglon_esf');
  const resultado = (mapa) => {
    if (!mapa) return 0;
    let s = 0;
    for (const [codigo, saldo] of mapa) if (/^[4-7]/.test(codigo)) s -= saldo;
    return s;
  };
  const res = { actual: resultado(actual), anterior: resultado(anterior) };
  const pasivoMasPatrimonio = {
    actual: pasivo.total.actual + patrimonio.total.actual + res.actual,
    anterior: pasivo.total.anterior + patrimonio.total.anterior + res.anterior,
  };
  return {
    formato_provisional: true,
    corte,
    corte_anterior: comparativo ? corteAnterior : null,
    secciones: [activo, pasivo, patrimonio].map((s) => enPesos(s, comparativo)),
    resultado_ejercicio: deCentavos(res.actual),
    ...(comparativo ? { resultado_ejercicio_anterior: deCentavos(res.anterior) } : {}),
    total_activo: deCentavos(activo.total.actual),
    total_pasivo_patrimonio: deCentavos(pasivoMasPatrimonio.actual),
    ...(comparativo ? { total_activo_anterior: deCentavos(activo.total.anterior), total_pasivo_patrimonio_anterior: deCentavos(pasivoMasPatrimonio.anterior) } : {}),
    cuadra: activo.total.actual === pasivoMasPatrimonio.actual,
  };
}

/** RPC-05 · Estado de resultados de un periodo (sin el comprobante de cierre). */
export async function estadoResultados(q = {}, db = pool) {
  const hoy = hoyCO();
  const desde = q.desde ? validarFecha(q.desde, 'fecha inicial') : `${hoy.slice(0, 4)}-01-01`;
  const hasta = q.hasta ? validarFecha(q.hasta, 'fecha final') : hoy;
  if (desde > hasta) throw badRequest('La fecha inicial es posterior a la final.');
  const comparativo = q.comparativo === true || q.comparativo === 'true';
  const cuentas = await catalogo(db);
  const clases = ['4', '5', '6', '7'];
  const actual = await saldos(db, { desde, hasta, sinCierre: true, clases });
  const anterior = comparativo ? await saldos(db, { desde: unAnioAntes(desde), hasta: unAnioAntes(hasta), sinCierre: true, clases }) : null;

  const ingresos = seccion('INGRESOS', 'Ingresos', ['4'], -1, actual, anterior, cuentas, 'renglon_er');
  const costos = seccion('COSTOS', 'Costos de venta y de producción', ['6', '7'], 1, actual, anterior, cuentas, 'renglon_er');
  const gastos = seccion('GASTOS', 'Gastos', ['5'], 1, actual, anterior, cuentas, 'renglon_er');
  const utilidad = (col) => ingresos.total[col] - costos.total[col] - gastos.total[col];
  const bruta = (col) => ingresos.total[col] - costos.total[col];
  return {
    formato_provisional: true,
    desde, hasta,
    ...(comparativo ? { desde_anterior: unAnioAntes(desde), hasta_anterior: unAnioAntes(hasta) } : {}),
    secciones: [ingresos, costos, gastos].map((s) => enPesos(s, comparativo)),
    utilidad_bruta: deCentavos(bruta('actual')),
    utilidad: deCentavos(utilidad('actual')),
    ...(comparativo ? { utilidad_bruta_anterior: deCentavos(bruta('anterior')), utilidad_anterior: deCentavos(utilidad('anterior')) } : {}),
  };
}
