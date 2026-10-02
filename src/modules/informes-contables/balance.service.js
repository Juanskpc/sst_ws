import { pool } from '../../config/db.js';
import { badRequest } from '../../utils/httpError.js';
import { aCentavos, deCentavos } from '../../utils/dinero.js';
import { hoyCO } from '../../utils/formato.js';

/**
 * C1-01 (RPC-06) · Balance de comprobación.
 *
 * Por cuenta: saldo inicial (todo lo contabilizado ANTES de `desde`), débitos y
 * créditos del rango y saldo final. Los saldos van como débito − crédito, igual
 * que los informes de Siigo que hoy usa la contadora (`puc.xlsx`: la caja con
 * saldo crédito sale en negativo); así una cuenta de naturaleza crédito con su
 * saldo normal se lee en negativo, y la suma de todas da cero si el libro cuadra.
 *
 * Solo cuenta lo CONTABILIZADO: el borrador aún no es libro y el anulado dejó de
 * serlo (se anula marcando el comprobante, no con un asiento contrario).
 *
 * El saldo inicial arrastra toda la historia, sin cortar por año: las cuentas de
 * resultado vuelven a cero solo cuando el cierre de año (CA) las cancela. Si un
 * año no se ha cerrado, su resultado sigue en las clases 4-7, que es lo que
 * mostraría Siigo en la misma situación.
 */

/** Niveles del PUC por largo del código: clase, grupo, cuenta, subcuenta y auxiliar. */
export const NIVELES = { 1: 'Clase', 2: 'Grupo', 4: 'Cuenta', 6: 'Subcuenta', 10: 'Auxiliar' };

const validarFecha = (v, texto) => {
  const f = String(v ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f) || Number.isNaN(Date.parse(f))) throw badRequest(`La fecha ${texto} no es válida (AAAA-MM-DD).`);
  return f;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validarId = (v, texto) => {
  if (v == null || v === '') return null;
  if (!UUID.test(String(v))) throw badRequest(`El ${texto} no es válido.`);
  return String(v);
};

/**
 * Normaliza los filtros comunes de los informes contables. Sin fechas, el mes en
 * curso hasta hoy (en Colombia: el servidor corre en UTC).
 */
export function leerFiltros(q = {}) {
  const hoy = hoyCO();
  const desde = q.desde ? validarFecha(q.desde, 'inicial') : `${hoy.slice(0, 7)}-01`;
  const hasta = q.hasta ? validarFecha(q.hasta, 'final') : hoy;
  if (desde > hasta) throw badRequest('La fecha inicial es posterior a la final.');
  const cuenta = q.cuenta ? String(q.cuenta).trim() : '';
  if (cuenta && !/^[0-9]{1,10}$/.test(cuenta)) throw badRequest('El código de cuenta solo lleva dígitos.');
  return {
    desde,
    hasta,
    cuenta,
    terceroId: validarId(q.tercero_id, 'tercero'),
    centroCostoId: validarId(q.centro_costo_id, 'centro de costo'),
    // El comprobante de cierre (CA) pone en cero las cuentas de resultado al 31 de
    // diciembre; para revisar el año antes del cierre, la contadora lo excluye.
    sinCierre: q.sin_cierre === true || q.sin_cierre === 'true',
  };
}

/**
 * Condiciones sobre movimientos (`m`), comprobantes (`c`), tipo (`tc`) y cuenta
 * (`cc`) que comparten el balance y el auxiliar. `p` agrega un parámetro.
 */
export function condicionesMovimiento(f, p) {
  const w = [`c.estado = 'CONTABILIZADO'`, `c.fecha <= ${p(f.hasta)}`];
  if (f.cuenta) w.push(`left(cc.codigo, ${p(f.cuenta.length)}) = ${p(f.cuenta)}`);
  if (f.terceroId) w.push(`m.tercero_id = ${p(f.terceroId)}`);
  if (f.centroCostoId) w.push(`m.centro_costo_id = ${p(f.centroCostoId)}`);
  if (f.sinCierre) w.push(`tc.codigo <> 'CA'`);
  return w;
}

export async function balanceComprobacion(q = {}, db = pool) {
  const f = leerFiltros(q);
  const nivel = Number(q.nivel) || 10;
  if (!NIVELES[nivel]) throw badRequest('Nivel inválido: 1 clase, 2 grupo, 4 cuenta, 6 subcuenta o 10 auxiliar.');

  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  const w = condicionesMovimiento(f, p);
  const pDesde = p(f.desde);

  // Primero el saldo de cada cuenta que recibió movimientos; después se suma
  // hacia arriba por prefijo del código (en el PUC el padre es el prefijo del
  // hijo), así cada clase, grupo y subcuenta muestra lo de todo lo que cuelga de ella.
  const r = await db.query(
    `WITH mov AS (
       SELECT m.cuenta_id, cc.codigo,
              sum(CASE WHEN c.fecha <  ${pDesde} THEN m.debito - m.credito ELSE 0 END) AS inicial,
              sum(CASE WHEN c.fecha >= ${pDesde} THEN m.debito  ELSE 0 END) AS debito,
              sum(CASE WHEN c.fecha >= ${pDesde} THEN m.credito ELSE 0 END) AS credito
         FROM sst.movimientos m
         JOIN sst.comprobantes c ON c.id = m.comprobante_id
         JOIN sst.tipos_comprobante tc ON tc.id = c.tipo_id
         JOIN sst.cuentas_contables cc ON cc.id = m.cuenta_id
        WHERE ${w.join(' AND ')}
        GROUP BY m.cuenta_id, cc.codigo
     )
     SELECT a.id AS cuenta_id, a.codigo, a.nombre, a.nivel, a.naturaleza, a.acepta_movimiento,
            sum(mov.inicial)::numeric(16,2) AS saldo_inicial, sum(mov.debito)::numeric(16,2) AS debito,
            sum(mov.credito)::numeric(16,2) AS credito,
            sum(mov.inicial + mov.debito - mov.credito)::numeric(16,2) AS saldo_final
       FROM sst.cuentas_contables a
       JOIN mov ON left(mov.codigo, a.nivel) = a.codigo
      WHERE a.nivel <= ${p(nivel)}
      GROUP BY a.id
     HAVING sum(mov.inicial) <> 0 OR sum(mov.debito) <> 0 OR sum(mov.credito) <> 0
      ORDER BY a.codigo`,
    params,
  );

  // Los totales salen de las clases (nivel 1): sumar todas las filas contaría
  // cada peso una vez por nivel.
  const t = { inicial: 0, debito: 0, credito: 0, final: 0 };
  for (const fila of r.rows) {
    if (fila.nivel !== 1) continue;
    t.inicial += aCentavos(fila.saldo_inicial);
    t.debito += aCentavos(fila.debito);
    t.credito += aCentavos(fila.credito);
    t.final += aCentavos(fila.saldo_final);
  }
  // Débitos = créditos solo se puede exigir al libro entero: con un filtro de
  // cuenta, tercero o centro de costo se ve una parte de cada asiento.
  const completo = !f.cuenta && !f.terceroId && !f.centroCostoId;

  return {
    filtros: { ...f, nivel, nivel_nombre: NIVELES[nivel] },
    filas: r.rows,
    totales: {
      saldo_inicial: deCentavos(t.inicial),
      debito: deCentavos(t.debito),
      credito: deCentavos(t.credito),
      saldo_final: deCentavos(t.final),
    },
    completo,
    cuadra: completo ? t.debito === t.credito && t.inicial === 0 && t.final === 0 : null,
    diferencia: deCentavos(t.debito - t.credito),
  };
}
