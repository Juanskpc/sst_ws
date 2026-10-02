import { pool } from '../../config/db.js';
import { badRequest } from '../../utils/httpError.js';
import { leerFiltros } from './balance.service.js';
import { libroAgrupado, salida, sumar } from './auxiliar.service.js';

/**
 * C4-01 (RPC-08 + RPC-02) · Libros auxiliares de impuestos, cuentas por cobrar y
 * cuentas por pagar: movimiento cronológico con saldo corrido.
 *
 * RPC-02 (impuestos detallados) y el libro de IVA de RPC-08 son el mismo informe
 * con otro filtro (la v2 de requisitos lo pide así): se elige el impuesto.
 *
 * Qué cuentas son de cada impuesto lo dice el PUC colombiano (Decreto 2650, el
 * mismo que usa Siigo y del que sale el plan de cuentas de JD&D): 2408 IVA por
 * pagar (generado, descontable y devoluciones), 2365/135515 retención en la
 * fuente (por pagar / a favor), 2367/135517 retención de IVA y 2368/135518
 * retención de ICA. Las autorretenciones caen en las mismas ramas (236575,
 * 135518). Las cuentas de cartera no salen del PUC sino de la marca `es_cartera`
 * del plan de cuentas (B3-01/B4-01), la misma con la que se concilia la cartera.
 */
export const LIBROS = {
  IVA: { nombre: 'IVA', prefijos: ['2408'] },
  RETEFUENTE: { nombre: 'Retención en la fuente', prefijos: ['2365', '135515'] },
  RETEIVA: { nombre: 'Retención de IVA', prefijos: ['2367', '135517'] },
  RETEICA: { nombre: 'Retención de ICA', prefijos: ['2368', '135518'] },
  IMPUESTOS: { nombre: 'Todos los impuestos', prefijos: ['2408', '2365', '135515', '2367', '135517', '2368', '135518'] },
  CXC: { nombre: 'Cuentas por cobrar', cartera: 'CXC' },
  CXP: { nombre: 'Cuentas por pagar', cartera: 'CXP' },
};

export async function libroAuxiliar(q = {}, db = pool) {
  const f = leerFiltros(q);
  const libro = String(q.libro ?? 'IVA').toUpperCase();
  const def = LIBROS[libro];
  if (!def) throw badRequest(`Libro inválido: ${Object.keys(LIBROS).join(', ')}.`);

  if (def.cartera) {
    const ids = (await db.query(
      `SELECT id FROM sst.cuentas_contables WHERE es_cartera = $1`, [def.cartera],
    )).rows.map((r) => r.id);
    if (!ids.length) {
      throw badRequest(`Ninguna cuenta del plan está marcada como ${def.cartera === 'CXC' ? 'cartera por cobrar' : 'cuentas por pagar'}: márquela en Contabilidad → Plan de cuentas.`);
    }
    f.cuentaIds = ids;
  } else {
    f.prefijos = def.prefijos;
  }

  const base = { libro, libro_nombre: def.nombre };
  if (def.cartera) {
    // La cartera se lee por cliente o proveedor: cada tercero con su saldo corrido.
    const grupos = await libroAgrupado(f, { porTercero: true, conMovimientos: true }, db);
    const porTercero = new Map();
    for (const g of grupos) {
      const k = g.tercero_id ?? '';
      if (!porTercero.has(k)) porTercero.set(k, { tercero_id: g.tercero_id, nombre: g.tercero_nombre ?? 'Sin tercero', documento: g.tercero_documento, grupos: [] });
      porTercero.get(k).grupos.push(g);
    }
    const terceros = [...porTercero.values()]
      .sort((a, b) => (!a.tercero_id) - (!b.tercero_id) || a.nombre.localeCompare(b.nombre, 'es'))
      .map((t) => ({
        tercero_id: t.tercero_id, nombre: t.nombre, documento: t.documento,
        cuentas: t.grupos.sort((a, b) => a.codigo.localeCompare(b.codigo)).map((g) => salida(g, true)),
        totales: sumar(t.grupos),
      }));
    return {
      ...base, agrupado_por: 'tercero', filtros: { ...f, cuentaIds: undefined }, terceros, totales: sumar(grupos),
      n_movimientos: grupos.reduce((n, g) => n + g.movimientos.length, 0),
    };
  }

  const grupos = (await libroAgrupado(f, { porTercero: false, conMovimientos: true }, db))
    .sort((a, b) => a.codigo.localeCompare(b.codigo));
  return {
    ...base, agrupado_por: 'cuenta', filtros: { ...f, prefijos: undefined },
    cuentas: grupos.map((g) => salida(g, true)),
    totales: sumar(grupos),
    n_movimientos: grupos.reduce((n, g) => n + g.movimientos.length, 0),
  };
}
