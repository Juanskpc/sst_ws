import { pool } from '../../config/db.js';
import { badRequest } from '../../utils/httpError.js';
import { aCentavos, deCentavos } from '../../utils/dinero.js';
import { condicionesMovimiento, leerFiltros } from './balance.service.js';

/**
 * C2-01 (RPC-09) · Movimiento general por cuenta (libro auxiliar).
 *
 * Las mismas columnas que el «Movimiento auxiliar de cuenta» de Siigo
 * (`puc.xlsx`): código, cuenta, comprobante, fecha, tercero, saldo inicial,
 * débito, crédito y saldo final; además la descripción, el documento cruce y el
 * id del comprobante para abrirlo. A diferencia de Siigo, el saldo final de cada
 * línea es el saldo CORRIDO de la cuenta (Siigo repite el saldo inicial en todas
 * las filas y su saldo final no se puede seguir línea a línea).
 *
 * Una cuenta sin movimientos en el rango pero con saldo también sale (una sola
 * fila de saldo), como la caja general en el ejemplo de septiembre.
 */

// Un año de JD&D son unos pocos miles de líneas; esto solo frena un rango
// absurdo que tumbaría el navegador.
const MAX_MOVIMIENTOS = 20000;

const NOMBRE_TERCERO = `COALESCE(t.razon_social, NULLIF(btrim(concat_ws(' ', t.nombres, t.apellidos)), ''))`;

export async function auxiliarPorCuenta(q = {}, db = pool) {
  const f = leerFiltros(q);

  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  const w = condicionesMovimiento(f, p);
  const pDesde = p(f.desde);
  const FROM = `
      FROM sst.movimientos m
      JOIN sst.comprobantes c ON c.id = m.comprobante_id
      JOIN sst.tipos_comprobante tc ON tc.id = c.tipo_id
      JOIN sst.cuentas_contables cc ON cc.id = m.cuenta_id`;

  const iniciales = (await db.query(
    `SELECT m.cuenta_id, cc.codigo, cc.nombre, sum(m.debito - m.credito) AS saldo
       ${FROM}
      WHERE ${w.join(' AND ')} AND c.fecha < ${pDesde}
      GROUP BY m.cuenta_id, cc.codigo, cc.nombre
     HAVING sum(m.debito - m.credito) <> 0`,
    params,
  )).rows;

  const movs = (await db.query(
    `SELECT m.cuenta_id, cc.codigo, cc.nombre, c.id AS comprobante_id,
            tc.codigo || '-' || c.numero AS comprobante, c.fecha::text AS fecha,
            m.tercero_id, ${NOMBRE_TERCERO} AS tercero_nombre, t.numero_documento AS tercero_documento,
            m.debito, m.credito, COALESCE(m.descripcion, c.descripcion) AS descripcion, m.documento_cruce
       ${FROM}
       LEFT JOIN sst.terceros t ON t.id = m.tercero_id
      WHERE ${w.join(' AND ')} AND c.fecha >= ${pDesde}
      ORDER BY cc.codigo, c.fecha, tc.codigo, c.numero, m.linea
      LIMIT ${MAX_MOVIMIENTOS + 1}`,
    params,
  )).rows;
  if (movs.length > MAX_MOVIMIENTOS) {
    throw badRequest(`El rango tiene más de ${MAX_MOVIMIENTOS} movimientos: acórtelo o filtre por cuenta.`);
  }

  // Una entrada por cuenta, en orden de código, con su saldo corrido.
  const porCuenta = new Map();
  const cuentaDe = (fila) => {
    let c = porCuenta.get(fila.cuenta_id);
    if (!c) {
      c = { cuenta_id: fila.cuenta_id, codigo: fila.codigo, nombre: fila.nombre, inicial: 0, debito: 0, credito: 0, movimientos: [] };
      porCuenta.set(fila.cuenta_id, c);
    }
    return c;
  };
  for (const i of iniciales) cuentaDe(i).inicial = aCentavos(i.saldo);
  for (const m of movs) cuentaDe(m);

  const cuentas = [...porCuenta.values()].sort((a, b) => a.codigo.localeCompare(b.codigo));
  const movsPorCuenta = agrupar(movs);
  const t = { inicial: 0, debito: 0, credito: 0 };
  for (const c of cuentas) {
    let saldo = c.inicial;
    for (const m of movsPorCuenta.get(c.cuenta_id) ?? []) {
      const d = aCentavos(m.debito);
      const cr = aCentavos(m.credito);
      saldo += d - cr;
      c.debito += d;
      c.credito += cr;
      c.movimientos.push({
        comprobante_id: m.comprobante_id, comprobante: m.comprobante, fecha: m.fecha,
        tercero_id: m.tercero_id, tercero_nombre: m.tercero_nombre, tercero_documento: m.tercero_documento,
        descripcion: m.descripcion, documento_cruce: m.documento_cruce,
        debito: m.debito, credito: m.credito, saldo: deCentavos(saldo),
      });
    }
    t.inicial += c.inicial;
    t.debito += c.debito;
    t.credito += c.credito;
  }

  return {
    filtros: f,
    cuentas: cuentas.map((c) => ({
      cuenta_id: c.cuenta_id, codigo: c.codigo, nombre: c.nombre,
      saldo_inicial: deCentavos(c.inicial), debito: deCentavos(c.debito), credito: deCentavos(c.credito),
      saldo_final: deCentavos(c.inicial + c.debito - c.credito),
      movimientos: c.movimientos,
    })),
    totales: {
      saldo_inicial: deCentavos(t.inicial), debito: deCentavos(t.debito), credito: deCentavos(t.credito),
      saldo_final: deCentavos(t.inicial + t.debito - t.credito),
    },
    n_movimientos: movs.length,
  };
}

function agrupar(lista) {
  const m = new Map();
  for (const x of lista) {
    if (!m.has(x.cuenta_id)) m.set(x.cuenta_id, []);
    m.get(x.cuenta_id).push(x);
  }
  return m;
}
