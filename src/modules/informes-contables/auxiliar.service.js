import { pool } from '../../config/db.js';
import { badRequest } from '../../utils/httpError.js';
import { aCentavos, deCentavos } from '../../utils/dinero.js';
import { condicionesMovimiento, leerFiltros } from './balance.service.js';

/**
 * C2-01 (RPC-09) · Movimiento general por cuenta (libro auxiliar) y
 * C3-01 (RPC-10) · Tercero general y detallado.
 *
 * Los dos son el mismo cálculo con otra agrupación: el auxiliar agrupa por
 * cuenta; el informe por tercero, por tercero y dentro de él por cuenta. Por
 * eso comparten `libroAgrupado`.
 *
 * El auxiliar lleva las mismas columnas que el «Movimiento auxiliar de cuenta»
 * de Siigo (`puc.xlsx`): código, cuenta, comprobante, fecha, tercero, saldo
 * inicial, débito, crédito y saldo final; además la descripción, el documento
 * cruce y el id del comprobante para abrirlo. A diferencia de Siigo, el saldo
 * final de cada línea es el saldo CORRIDO de la cuenta (Siigo repite el saldo
 * inicial en todas las filas y su saldo final no se puede seguir línea a línea).
 *
 * Una cuenta sin movimientos en el rango pero con saldo también sale (una sola
 * fila de saldo), como la caja general en el ejemplo de septiembre.
 */

// Un año de JD&D son unos pocos miles de líneas; esto solo frena un rango
// absurdo que tumbaría el navegador.
const MAX_MOVIMIENTOS = 20000;

const NOMBRE_TERCERO = `COALESCE(t.razon_social, NULLIF(btrim(concat_ws(' ', t.nombres, t.apellidos)), ''))`;

const FROM = `
      FROM sst.movimientos m
      JOIN sst.comprobantes c ON c.id = m.comprobante_id
      JOIN sst.tipos_comprobante tc ON tc.id = c.tipo_id
      JOIN sst.cuentas_contables cc ON cc.id = m.cuenta_id
      LEFT JOIN sst.terceros t ON t.id = m.tercero_id`;

/**
 * Saldos por (cuenta) o por (tercero, cuenta). Con `conMovimientos` trae cada
 * línea con su saldo corrido; sin él, solo las sumas del rango (el informe
 * «general», que no necesita cargar las líneas).
 */
export async function libroAgrupado(f, { porTercero, conMovimientos }, db) {
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  const w = condicionesMovimiento(f, p);
  const pDesde = p(f.desde);
  const claves = porTercero
    ? 'm.tercero_id, t.numero_documento, tercero_nombre, m.cuenta_id, cc.codigo, cc.nombre'
    : 'm.cuenta_id, cc.codigo, cc.nombre';
  const selClaves = porTercero
    ? `m.tercero_id, t.numero_documento AS tercero_documento, ${NOMBRE_TERCERO} AS tercero_nombre, m.cuenta_id, cc.codigo, cc.nombre`
    : 'm.cuenta_id, cc.codigo, cc.nombre';
  const llave = (r) => (porTercero ? `${r.tercero_id ?? ''}|${r.cuenta_id}` : r.cuenta_id);

  const iniciales = (await db.query(
    `SELECT ${selClaves}, sum(m.debito - m.credito) AS saldo
       ${FROM}
      WHERE ${w.join(' AND ')} AND c.fecha < ${pDesde}
      GROUP BY ${claves}
     HAVING sum(m.debito - m.credito) <> 0`,
    params,
  )).rows;

  let filas;
  if (conMovimientos) {
    filas = (await db.query(
      `SELECT ${selClaves}, c.id AS comprobante_id,
              tc.codigo || '-' || c.numero AS comprobante, c.fecha::text AS fecha,
              ${porTercero ? '' : `m.tercero_id, ${NOMBRE_TERCERO} AS tercero_nombre, t.numero_documento AS tercero_documento,`}
              m.debito, m.credito, m.base, COALESCE(m.descripcion, c.descripcion) AS descripcion, m.documento_cruce
         ${FROM}
        WHERE ${w.join(' AND ')} AND c.fecha >= ${pDesde}
        ORDER BY cc.codigo, c.fecha, tc.codigo, c.numero, m.linea
        LIMIT ${MAX_MOVIMIENTOS + 1}`,
      params,
    )).rows;
    if (filas.length > MAX_MOVIMIENTOS) {
      throw badRequest(`El rango tiene más de ${MAX_MOVIMIENTOS} movimientos: acórtelo o filtre por cuenta o tercero.`);
    }
  } else {
    filas = (await db.query(
      `SELECT ${selClaves}, sum(m.debito) AS debito, sum(m.credito) AS credito
         ${FROM}
        WHERE ${w.join(' AND ')} AND c.fecha >= ${pDesde}
        GROUP BY ${claves}`,
      params,
    )).rows;
  }

  const grupos = new Map();
  const grupoDe = (r) => {
    let g = grupos.get(llave(r));
    if (!g) {
      g = {
        cuenta_id: r.cuenta_id, codigo: r.codigo, nombre: r.nombre,
        tercero_id: r.tercero_id ?? null, tercero_nombre: r.tercero_nombre ?? null, tercero_documento: r.tercero_documento ?? null,
        inicial: 0, debito: 0, credito: 0, movimientos: [],
      };
      grupos.set(llave(r), g);
    }
    return g;
  };
  for (const i of iniciales) grupoDe(i).inicial = aCentavos(i.saldo);
  for (const r of filas) grupoDe(r);

  // Saldo corrido línea a línea (las filas vienen en orden de cuenta y fecha).
  const corrido = new Map();
  for (const r of filas) {
    const g = grupoDe(r);
    const d = aCentavos(r.debito);
    const cr = aCentavos(r.credito);
    g.debito += d;
    g.credito += cr;
    if (!conMovimientos) continue;
    const saldo = (corrido.has(g) ? corrido.get(g) : g.inicial) + d - cr;
    corrido.set(g, saldo);
    g.movimientos.push({
      comprobante_id: r.comprobante_id, comprobante: r.comprobante, fecha: r.fecha,
      tercero_id: r.tercero_id, tercero_nombre: r.tercero_nombre, tercero_documento: r.tercero_documento,
      descripcion: r.descripcion, documento_cruce: r.documento_cruce,
      debito: r.debito, credito: r.credito, base: r.base ?? null, saldo: deCentavos(saldo),
    });
  }
  return [...grupos.values()];
}

export const salida = (g, conMovimientos) => ({
  cuenta_id: g.cuenta_id, codigo: g.codigo, nombre: g.nombre,
  saldo_inicial: deCentavos(g.inicial), debito: deCentavos(g.debito), credito: deCentavos(g.credito),
  saldo_final: deCentavos(g.inicial + g.debito - g.credito),
  ...(conMovimientos ? { movimientos: g.movimientos } : {}),
});

export function sumar(grupos) {
  const t = { inicial: 0, debito: 0, credito: 0 };
  for (const g of grupos) { t.inicial += g.inicial; t.debito += g.debito; t.credito += g.credito; }
  return {
    saldo_inicial: deCentavos(t.inicial), debito: deCentavos(t.debito), credito: deCentavos(t.credito),
    saldo_final: deCentavos(t.inicial + t.debito - t.credito),
  };
}

export async function auxiliarPorCuenta(q = {}, db = pool) {
  const f = leerFiltros(q);
  const grupos = (await libroAgrupado(f, { porTercero: false, conMovimientos: true }, db))
    .sort((a, b) => a.codigo.localeCompare(b.codigo));
  return {
    filtros: f,
    cuentas: grupos.map((g) => salida(g, true)),
    totales: sumar(grupos),
    n_movimientos: grupos.reduce((n, g) => n + g.movimientos.length, 0),
  };
}

/**
 * C3-01 · Por tercero. `modo` = 'general' (saldo por tercero y cuenta) o
 * 'detallado' (además, cada movimiento con su comprobante). Las líneas sin
 * tercero (bancos, impuestos por pagar…) se agrupan aparte, al final, para que
 * los totales sigan siendo los del libro.
 */
export async function informePorTercero(q = {}, db = pool) {
  const f = leerFiltros(q);
  const modo = q.modo === 'detallado' ? 'detallado' : 'general';
  // Sin la contrapartida (bancos, impuestos), el informe de un tercero solo
  // mostraría la mitad del asiento; pero la contadora lo usa sobre todo para
  // las cuentas que llevan tercero, así que `solo_con_tercero` las aparta.
  const soloConTercero = q.solo_con_tercero === true || q.solo_con_tercero === 'true';
  const conMovimientos = modo === 'detallado';
  let grupos = await libroAgrupado(f, { porTercero: true, conMovimientos }, db);
  if (soloConTercero) grupos = grupos.filter((g) => g.tercero_id);

  const porTercero = new Map();
  for (const g of grupos) {
    const k = g.tercero_id ?? '';
    if (!porTercero.has(k)) {
      porTercero.set(k, {
        tercero_id: g.tercero_id, nombre: g.tercero_nombre ?? 'Sin tercero', documento: g.tercero_documento, grupos: [],
      });
    }
    porTercero.get(k).grupos.push(g);
  }
  const terceros = [...porTercero.values()]
    // Por nombre, y «Sin tercero» al final.
    .sort((a, b) => (!a.tercero_id) - (!b.tercero_id) || a.nombre.localeCompare(b.nombre, 'es'))
    .map((t) => ({
      tercero_id: t.tercero_id, nombre: t.nombre, documento: t.documento,
      cuentas: t.grupos.sort((a, b) => a.codigo.localeCompare(b.codigo)).map((g) => salida(g, conMovimientos)),
      totales: sumar(t.grupos),
    }));

  return {
    filtros: { ...f, modo, solo_con_tercero: soloConTercero },
    terceros,
    totales: sumar(grupos),
    ...(conMovimientos ? { n_movimientos: grupos.reduce((n, g) => n + g.movimientos.length, 0) } : {}),
  };
}
