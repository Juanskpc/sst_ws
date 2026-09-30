import { pool, withTransaction } from '../../config/db.js';
import { badRequest, conflict } from '../../utils/httpError.js';
import { aCentavos, deCentavos } from '../../utils/dinero.js';
import { crearComprobante } from './comprobantes.service.js';

/**
 * B10-01 (CNT-12) · Cierre de año.
 *
 * Cancela el saldo del año de cada cuenta de resultado (clases 4 ingresos, 5
 * gastos, 6 costos de venta y 7 costos de producción) contra la cuenta de
 * utilidad o de pérdida del ejercicio (clase 3; la elige la contadora, en el PUC
 * suelen ser la 3605 y la 3610), en un comprobante CA del 31 de diciembre, y
 * cierra los doce meses. Las cuentas que exigen tercero o centro de costo se
 * cancelan por cada uno, para que los auxiliares también queden en cero.
 *
 * Un año cerrado NO se reabre (decisión D-20 de la v2): su CA no se puede anular
 * desde la pantalla. Lo que sí existe es reabrir un mes (solo admin, con motivo).
 */

const CLASES_RESULTADO = ['4', '5', '6', '7'];

const validarAnio = (v) => {
  const a = Number(v);
  if (!Number.isInteger(a) || a < 2000 || a > 2100) throw badRequest('Año inválido.');
  return a;
};

async function yaCerrado(db, anio) {
  return (await db.query(
    `SELECT c.id, 'CA-' || c.numero AS numero FROM sst.comprobantes c JOIN sst.tipos_comprobante t ON t.id = c.tipo_id
      WHERE t.codigo = 'CA' AND c.anio = $1 AND c.estado = 'CONTABILIZADO' LIMIT 1`,
    [anio],
  )).rows[0] ?? null;
}

/**
 * Saldos del año en las cuentas de resultado y las líneas que los cancelan.
 * Devuelve también el resultado del ejercicio en centavos (positivo = utilidad).
 */
async function armarCierre(db, anio) {
  const saldos = (await db.query(
    `SELECT m.cuenta_id, cc.codigo, cc.nombre,
            CASE WHEN cc.exige_tercero THEN m.tercero_id END AS tercero_id,
            CASE WHEN cc.exige_centro_costo THEN m.centro_costo_id END AS centro_costo_id,
            sum(m.debito) AS debito, sum(m.credito) AS credito
       FROM sst.movimientos m
       JOIN sst.comprobantes c ON c.id = m.comprobante_id AND c.estado = 'CONTABILIZADO' AND c.anio = $1
       JOIN sst.cuentas_contables cc ON cc.id = m.cuenta_id
      WHERE left(cc.codigo, 1) = ANY($2)
      GROUP BY 1, 2, 3, 4, 5
      ORDER BY cc.codigo`,
    [anio, CLASES_RESULTADO],
  )).rows;
  let resultado = 0;
  const lineas = [];
  for (const s of saldos) {
    const saldo = aCentavos(s.debito) - aCentavos(s.credito); // débito − crédito
    if (!saldo) continue;
    resultado -= saldo; // ingresos (saldo crédito) suman; gastos y costos (débito) restan
    lineas.push({
      cuenta_id: s.cuenta_id, codigo: s.codigo, nombre: s.nombre, tercero_id: s.tercero_id, centro_costo_id: s.centro_costo_id,
      // Se cancela con el movimiento contrario a su saldo.
      debito: saldo < 0 ? deCentavos(-saldo) : null,
      credito: saldo > 0 ? deCentavos(saldo) : null,
      descripcion: `Cierre ${anio}`,
    });
  }
  return { lineas, resultado };
}

async function cuentaPatrimonio(db, id, texto) {
  const c = (await db.query(`SELECT id, codigo, nombre, acepta_movimiento, activa, exige_tercero FROM sst.cuentas_contables WHERE id = $1`, [id])).rows[0];
  if (!c) throw badRequest(`Elija la cuenta de ${texto} del ejercicio.`);
  if (!c.codigo.startsWith('3')) throw badRequest(`La cuenta de ${texto} va en el patrimonio (clase 3); ${c.codigo} no lo es.`);
  if (!c.acepta_movimiento || !c.activa) throw badRequest(`La cuenta ${c.codigo} no recibe movimiento (o está inactiva).`);
  if (c.exige_tercero) throw badRequest(`La cuenta ${c.codigo} exige tercero: la de ${texto} del ejercicio no debería.`);
  return c;
}

/** Lo que haría el cierre, sin guardar nada (la pantalla lo muestra antes de confirmar). */
export async function vistaPreviaCierre(anio, db = pool) {
  const a = validarAnio(anio);
  const cerrado = await yaCerrado(db, a);
  const { lineas, resultado } = await armarCierre(db, a);
  const borradores = (await db.query(`SELECT count(*)::int AS n FROM sst.comprobantes WHERE anio = $1 AND estado = 'BORRADOR'`, [a])).rows[0].n;
  const diciembreCerrado = (await db.query(`SELECT sst.fn_periodo_cerrado($1::date) AS c`, [`${a}-12-31`])).rows[0].c;
  return {
    anio: a,
    cerrado: cerrado ? cerrado.numero : null,
    borradores,
    diciembre_cerrado: diciembreCerrado,
    cuentas: lineas.length,
    lineas,
    resultado: deCentavos(Math.abs(resultado)),
    tipo_resultado: resultado > 0 ? 'UTILIDAD' : resultado < 0 ? 'PERDIDA' : 'CERO',
  };
}

/**
 * Cierra el año: CA del 31 de diciembre y los doce meses cerrados, todo en una
 * transacción. `cuenta_utilidad_id` / `cuenta_perdida_id`: la que corresponda al
 * resultado (basta la que se use, pero la pantalla pide las dos).
 */
export async function cerrarAnio(anio, b = {}, usuarioId = null, { client = null } = {}) {
  const a = validarAnio(anio);
  const correr = (fn) => (client ? fn(client) : withTransaction(fn));
  return correr(async (db) => {
    // Un cerrojo por año: dos personas cerrando a la vez no generan dos CA.
    await db.query(`SELECT pg_advisory_xact_lock(9472, $1)`, [a]);
    const ya = await yaCerrado(db, a);
    if (ya) throw conflict(`El año ${a} ya está cerrado (${ya.numero}). Un año cerrado no se reabre.`);
    const borradores = (await db.query(`SELECT count(*)::int AS n FROM sst.comprobantes WHERE anio = $1 AND estado = 'BORRADOR'`, [a])).rows[0].n;
    if (borradores) throw badRequest(`Hay ${borradores} comprobante(s) en borrador en ${a}: contabilícelos o elimínelos antes de cerrar el año.`);
    if ((await db.query(`SELECT sst.fn_periodo_cerrado($1::date) AS c`, [`${a}-12-31`])).rows[0].c) {
      throw badRequest(`Diciembre de ${a} está cerrado: el cierre se registra el 31 de diciembre, así que el mes debe estar abierto.`);
    }

    const { lineas, resultado } = await armarCierre(db, a);
    if (!lineas.length) throw badRequest(`No hay saldos en las cuentas de resultado de ${a}: no hay nada que cerrar.`);
    if (resultado) {
      const destino = resultado > 0
        ? await cuentaPatrimonio(db, b.cuenta_utilidad_id, 'utilidad')
        : await cuentaPatrimonio(db, b.cuenta_perdida_id, 'pérdida');
      lineas.push({
        cuenta_id: destino.id, debito: resultado < 0 ? deCentavos(-resultado) : null, credito: resultado > 0 ? deCentavos(resultado) : null,
        descripcion: resultado > 0 ? `Utilidad del ejercicio ${a}` : `Pérdida del ejercicio ${a}`,
      });
    }

    const comp = await crearComprobante({
      tipo: 'CA', fecha: `${a}-12-31`, descripcion: `Cierre del año ${a}`,
      lineas: lineas.map(({ codigo: _c, nombre: _n, ...l }) => l),
      // Con origen: así no se anula desde la pantalla de comprobantes (D-20).
      origen_tipo: 'CIERRE_ANUAL', contabilizar: true,
    }, usuarioId, { client: db });

    for (let mes = 1; mes <= 12; mes++) {
      await db.query(
        `INSERT INTO sst.periodos_contables (anio, mes, estado, cerrado_por, cerrado_en) VALUES ($1, $2, 'CERRADO', $3, now())
         ON CONFLICT (anio, mes) DO UPDATE SET estado = 'CERRADO', cerrado_por = $3, cerrado_en = now()`,
        [a, mes, usuarioId],
      );
    }
    return {
      anio: a, comprobante: comp.numero_completo, comprobante_id: comp.id, cuentas: lineas.length - (resultado ? 1 : 0),
      resultado: deCentavos(Math.abs(resultado)), tipo_resultado: resultado > 0 ? 'UTILIDAD' : resultado < 0 ? 'PERDIDA' : 'CERO',
    };
  });
}
