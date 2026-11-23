import { pool } from '../../config/db.js';
import { badRequest } from '../../utils/httpError.js';
import { aCentavos, deCentavos } from '../../utils/dinero.js';
import { hoyCO } from '../../utils/formato.js';
import { EDADES } from '../cartera/cartera.service.js';

/**
 * Estadísticas de Finanzas (solo lectura, sin migraciones).
 *
 * Un solo endpoint para las cuatro pestañas (Resumen, Ingresos, Cartera y pagos,
 * Resultado): son ~16 consultas agregadas sobre pocas filas, y una sola carga
 * evita que el alto del lienzo salte entre pestañas.
 *
 * Reglas que NO se cambian (veredicto del 20-nov-2026, §4):
 *  - Fechas de negocio (`fecha_emision`, `fecha`, `anio`/`mes`), nunca `creado_en`;
 *    y salen de SQL como texto, porque `pg` corre los DATE a la zona local.
 *  - Documentos que cuentan: VALIDADO + ANULADO; la nota crédito (y la nota de
 *    ajuste del documento soporte) resta. Es la regla de `ventas.service.js`.
 *  - Libro: solo CONTABILIZADO y sin el comprobante de cierre (CA); la utilidad es
 *    4 − (6 + 7) − 5, la misma de `estadoResultados`.
 *  - Cartera al corte: valor − Σ(pagado + retenciones + anticipo) de las
 *    aplicaciones no anuladas hasta el corte. Límite: una aplicación anulada
 *    DESPUÉS del corte no se ve, porque no se guarda la fecha de anulación.
 *  - Montos como texto con dos decimales; las sumas en JS, en centavos.
 */

// ─── Periodo (fechas AAAA-MM-DD, sin Date local) ─────────────────────────────

const pad = (n) => String(n).padStart(2, '0');
const ultimoDia = (a, m) => new Date(Date.UTC(a, m, 0)).getUTCDate();
const mesMas = (a, m, n) => { const t = a * 12 + (m - 1) + n; return [Math.floor(t / 12), (t % 12) + 1]; };
const aUTC = (iso) => { const [a, m, d] = iso.split('-').map(Number); return Date.UTC(a, m - 1, d); };
const desdeUTC = (ms) => new Date(ms).toISOString().slice(0, 10);
const DIA = 86400000;
const minIso = (a, b) => (a < b ? a : b);
const MESES_POR = { mes: 1, trimestre: 3, anio: 12 };

/** Calcula desde, fin, corte y la comparación «a la misma altura» del periodo anterior. */
export function calcularPeriodo(q = {}, hoy = hoyCO()) {
  const tipo = q.periodo === undefined || q.periodo === '' ? 'mes' : String(q.periodo);
  if (!MESES_POR[tipo]) throw badRequest('El periodo debe ser mes, trimestre o año.');
  const ref = q.ref === undefined || q.ref === '' ? hoy.slice(0, 7) : String(q.ref);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ref)) throw badRequest('El mes no es válido (AAAA-MM).');
  const [ra, rm] = ref.split('-').map(Number);
  const n = MESES_POR[tipo];
  const mIni = tipo === 'mes' ? rm : tipo === 'trimestre' ? Math.floor((rm - 1) / 3) * 3 + 1 : 1;
  const desde = `${ra}-${pad(mIni)}-01`;
  if (desde > hoy) throw badRequest('Ese periodo aún no empieza.');
  const [fa, fm] = mesMas(ra, mIni, n - 1);
  const fin = `${fa}-${pad(fm)}-${pad(ultimoDia(fa, fm))}`;
  const corte = minIso(fin, hoy);

  const [ca, cm] = mesMas(ra, mIni, -n);
  const compDesde = `${ca}-${pad(cm)}-01`;
  const [cfa, cfm] = mesMas(ca, cm, n - 1);
  const compFin = `${cfa}-${pad(cfm)}-${pad(ultimoDia(cfa, cfm))}`;
  // A la misma altura: 1–20 nov. contra 1–20 oct.; un periodo completo contra el anterior completo
  // (así un trimestre cerrado no pierde los dos últimos días del anterior por la diferencia de largo).
  const compCorte = corte === fin ? compFin : minIso(desdeUTC(aUTC(compDesde) + (aUTC(corte) - aUTC(desde))), compFin);

  return { tipo, desde, fin, corte, en_curso: corte === hoy, comparacion: { desde: compDesde, corte: compCorte } };
}

// ─── SQL (§6 del veredicto, probado en jdd_dev) ──────────────────────────────

const SQL_VENTAS = (pos, neg) => `
SELECT COALESCE(sum(CASE WHEN tipo='${pos}' THEN subtotal ELSE -subtotal END),0)::numeric(16,2) AS neto,
       COALESCE(sum(subtotal) FILTER (WHERE tipo='${pos}'),0)::numeric(16,2) AS facturado_bruto,
       COALESCE(sum(subtotal) FILTER (WHERE tipo='${neg}'),0)::numeric(16,2) AS notas_valor,
       count(*) FILTER (WHERE tipo='${pos}')::int AS facturas,
       count(*) FILTER (WHERE tipo='${neg}')::int AS notas
  FROM sst.documentos_electronicos
 WHERE tipo IN ('${pos}','${neg}') AND estado IN ('VALIDADO','ANULADO')
   AND fecha_emision BETWEEN $1 AND $2`;

const SQL_CLIENTES = `
SELECT d.tercero_id,
       COALESCE(t.razon_social, NULLIF(btrim(concat_ws(' ', t.nombres, t.apellidos)), '')) AS nombre,
       sum(CASE WHEN d.tipo='FACTURA' THEN d.subtotal ELSE -d.subtotal END)::numeric(16,2) AS valor
  FROM sst.documentos_electronicos d JOIN sst.terceros t ON t.id = d.tercero_id
 WHERE d.tipo IN ('FACTURA','NOTA_CREDITO') AND d.estado IN ('VALIDADO','ANULADO')
   AND d.fecha_emision BETWEEN $1 AND $2
 GROUP BY 1, 2 ORDER BY valor DESC, nombre`;

const SQL_CAUSALES = `
SELECT causal, count(*)::int AS notas, sum(subtotal)::numeric(16,2) AS valor
  FROM sst.documentos_electronicos
 WHERE tipo='NOTA_CREDITO' AND estado IN ('VALIDADO','ANULADO') AND fecha_emision BETWEEN $1 AND $2
 GROUP BY causal ORDER BY valor DESC`;

const LIBRO = `
  FROM sst.movimientos m
  JOIN sst.comprobantes c       ON c.id = m.comprobante_id
  JOIN sst.tipos_comprobante tc ON tc.id = c.tipo_id
  JOIN sst.cuentas_contables cc ON cc.id = m.cuenta_id`;

const SQL_RESULTADO = `
SELECT COALESCE(-sum(m.debito - m.credito) FILTER (WHERE left(cc.codigo,1) = '4'),0)::numeric(16,2)        AS ingresos,
       COALESCE( sum(m.debito - m.credito) FILTER (WHERE left(cc.codigo,1) IN ('6','7')),0)::numeric(16,2) AS costos,
       COALESCE( sum(m.debito - m.credito) FILTER (WHERE left(cc.codigo,1) = '5'),0)::numeric(16,2)        AS gastos,
       count(*)::int AS movimientos
${LIBRO}
 WHERE c.estado = 'CONTABILIZADO' AND tc.codigo <> 'CA'
   AND left(cc.codigo,1) IN ('4','5','6','7') AND c.fecha BETWEEN $1 AND $2`;

/** Saldo de cada documento de cartera reconstruido al corte ($1). Lo reutiliza el script de verificación. */
export const SQL_SALDO_AL_CORTE = `
  SELECT cd.id, cd.vencimiento,
         cd.valor - COALESCE((SELECT sum(a.valor_pagado + a.valor_retenciones + a.valor_anticipo)
                                FROM sst.cartera_aplicaciones a
                               WHERE a.cartera_documento_id = cd.id AND NOT a.anulada AND a.fecha <= $1), 0) AS saldo
    FROM sst.cartera_documentos cd
   WHERE cd.tipo = $2 AND NOT cd.anulado AND cd.fecha <= $1`;

const SQL_CARTERA = `
WITH doc AS (${SQL_SALDO_AL_CORTE})
SELECT CASE WHEN $1::date - vencimiento <= 0  THEN 'POR_VENCER'
            WHEN $1::date - vencimiento <= 30 THEN 'D1_30'
            WHEN $1::date - vencimiento <= 60 THEN 'D31_60'
            WHEN $1::date - vencimiento <= 90 THEN 'D61_90' ELSE 'MAS_90' END AS edad,
       count(*)::int AS documentos,
       sum(saldo)::numeric(16,2) AS valor,
       COALESCE(sum(saldo) FILTER (WHERE vencimiento > $1::date AND vencimiento <= $1::date + 7),0)::numeric(16,2) AS vence_7_dias
  FROM doc WHERE saldo > 0 GROUP BY 1`;

const SQL_CUENTAS = `
SELECT left(cc.codigo,4) AS codigo, COALESCE(p.nombre, 'Cuenta ' || left(cc.codigo,4)) AS nombre,
       sum(m.debito - m.credito)::numeric(16,2) AS valor
${LIBRO}
  LEFT JOIN sst.cuentas_contables p ON p.codigo = left(cc.codigo,4)
 WHERE c.estado='CONTABILIZADO' AND tc.codigo <> 'CA'
   AND left(cc.codigo,1) IN ('5','6','7') AND c.fecha BETWEEN $1 AND $2
 GROUP BY 1, 2 ORDER BY valor DESC`;

const SQL_COBERTURA = `
SELECT count(*)::int AS documentos,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM sst.comprobantes c
                                       WHERE c.id = d.comprobante_id AND c.estado = 'CONTABILIZADO'))::int AS contabilizados,
       count(*) FILTER (WHERE d.contabilizacion_error IS NOT NULL
                          AND NOT EXISTS (SELECT 1 FROM sst.comprobantes c
                                           WHERE c.id = d.comprobante_id AND c.estado = 'CONTABILIZADO'))::int AS con_error
  FROM sst.documentos_electronicos d
 WHERE d.tipo IN ('FACTURA','NOTA_CREDITO','DOC_SOPORTE','NOTA_AJUSTE_DS') AND d.estado IN ('VALIDADO','ANULADO')
   AND d.fecha_emision BETWEEN $1 AND $2`;

const SQL_BORRADORES = `SELECT count(*)::int AS comprobantes_borrador FROM sst.comprobantes WHERE estado='BORRADOR' AND fecha BETWEEN $1 AND $2`;

const SQL_MESES_CERRADOS = `
SELECT count(*)::int AS meses, count(p.id)::int AS meses_cerrados
  FROM generate_series(date_trunc('month',$1::date), date_trunc('month',$2::date), interval '1 month') g(mes)
  LEFT JOIN sst.periodos_contables p
         ON p.anio = EXTRACT(YEAR FROM g.mes) AND p.mes = EXTRACT(MONTH FROM g.mes) AND p.estado = 'CERRADO'`;

const SQL_RECAUDO = `SELECT COALESCE(sum(valor_consignado),0)::numeric(16,2) AS valor
  FROM sst.recibos_caja WHERE estado='CONTABILIZADO' AND fecha BETWEEN $1 AND $2`;
const SQL_RETENIDO = `SELECT COALESCE(sum(valor_retenciones),0)::numeric(16,2) AS retenido
  FROM sst.cartera_aplicaciones WHERE origen_tipo='RECIBO_CAJA' AND NOT anulada AND fecha BETWEEN $1 AND $2`;
const SQL_EGRESOS = `SELECT COALESCE(sum(valor_pagado),0)::numeric(16,2) AS pagado
  FROM sst.egresos WHERE estado='CONTABILIZADO' AND fecha BETWEEN $1 AND $2`;
const SQL_NOMINA = `SELECT count(DISTINCT empleado_id)::int AS empleados, COALESCE(sum(total_devengado),0)::numeric(16,2) AS devengado
  FROM sst.nomina_liquidaciones
 WHERE estado='VALIDADO' AND make_date(anio, mes, 1) BETWEEN date_trunc('month',$1::date)::date AND $2::date`;
const SQL_DESDE_DATOS = `SELECT LEAST(
  (SELECT min(fecha_emision) FROM sst.documentos_electronicos WHERE estado IN ('VALIDADO','ANULADO')),
  (SELECT min(fecha) FROM sst.comprobantes WHERE estado='CONTABILIZADO'))::text AS desde_datos`;

const SQL_SERIE = `
WITH meses AS (SELECT generate_series($1::date, $2::date, interval '1 month')::date AS mes),
v AS (SELECT date_trunc('month', fecha_emision)::date AS mes,
             sum(CASE WHEN tipo='FACTURA' THEN subtotal      ELSE -subtotal      END) AS neto,
             sum(CASE WHEN tipo='FACTURA' THEN total_a_pagar ELSE -total_a_pagar END) AS total
        FROM sst.documentos_electronicos
       WHERE tipo IN ('FACTURA','NOTA_CREDITO') AND estado IN ('VALIDADO','ANULADO')
         AND fecha_emision BETWEEN $1 AND $3 GROUP BY 1),
r AS (SELECT date_trunc('month', fecha)::date AS mes, sum(valor_consignado) AS recaudado
        FROM sst.recibos_caja WHERE estado='CONTABILIZADO' AND fecha BETWEEN $1 AND $3 GROUP BY 1),
l AS (SELECT date_trunc('month', c.fecha)::date AS mes,  -- el mismo campo que filtra (no anio/mes del comprobante)
             -sum(m.debito - m.credito) FILTER (WHERE left(cc.codigo,1)='4')              AS ingresos,
              sum(m.debito - m.credito) FILTER (WHERE left(cc.codigo,1) IN ('5','6','7')) AS costos_gastos
${LIBRO}
       WHERE c.estado='CONTABILIZADO' AND tc.codigo <> 'CA' AND left(cc.codigo,1) IN ('4','5','6','7')
         AND c.fecha BETWEEN $1 AND $3 GROUP BY 1)
SELECT to_char(meses.mes,'YYYY-MM') AS mes,
       COALESCE(v.neto,0)::numeric(16,2)  AS facturado_neto,
       COALESCE(v.total,0)::numeric(16,2) AS facturado_total,
       COALESCE(r.recaudado,0)::numeric(16,2) AS recaudado,
       COALESCE(l.ingresos,0)::numeric(16,2)  AS ingresos,
       COALESCE(l.costos_gastos,0)::numeric(16,2) AS costos_gastos,
       (COALESCE(l.ingresos,0) - COALESCE(l.costos_gastos,0))::numeric(16,2) AS utilidad,
       EXISTS (SELECT 1 FROM sst.periodos_contables p
                WHERE p.anio = EXTRACT(YEAR FROM meses.mes) AND p.mes = EXTRACT(MONTH FROM meses.mes)
                  AND p.estado='CERRADO') AS cerrado
  FROM meses LEFT JOIN v USING (mes) LEFT JOIN r USING (mes) LEFT JOIN l USING (mes)
 ORDER BY meses.mes`;

// ─── Agrupación en pocas idas a la base ──────────────────────────────────────
//
// Las consultas de arriba son las del veredicto, sin cambiar una coma. Para que la
// respuesta salga en < 500 ms aun por el túnel de desarrollo (≈ 75 ms por ida),
// se envían en 7 consultas y no en 23: las que se repiten por periodo (actual y
// comparación) o por cartera (CXC/CXP) se evalúan con LATERAL sobre una lista de
// rangos, y las de un solo valor se juntan con CROSS JOIN. Las fórmulas son las
// mismas; el script de verificación lo comprueba al centavo.

/** Cambia los parámetros posicionales de una consulta por columnas del rango (`$1` → `r.d`). */
const conRango = (sql, nombres) => nombres.reduce((t, n, i) => t.replaceAll(`$${i + 1}`, n), sql);

const SQL_POR_PERIODO = `
SELECT r.k,
       v.neto, v.facturado_bruto, v.notas_valor, v.facturas, v.notas,
       ds.neto AS prof_neto, ds.facturas AS prof_documentos,
       res.ingresos, res.costos, res.gastos, res.movimientos,
       rc.valor AS recaudo
  FROM (VALUES ('act', $1::date, $2::date), ('ant', $3::date, $4::date)) r(k, d, h)
  CROSS JOIN LATERAL (${conRango(SQL_VENTAS('FACTURA', 'NOTA_CREDITO'), ['r.d', 'r.h'])}) v
  CROSS JOIN LATERAL (${conRango(SQL_VENTAS('DOC_SOPORTE', 'NOTA_AJUSTE_DS'), ['r.d', 'r.h'])}) ds
  CROSS JOIN LATERAL (${conRango(SQL_RESULTADO, ['r.d', 'r.h'])}) res
  CROSS JOIN LATERAL (${conRango(SQL_RECAUDO, ['r.d', 'r.h'])}) rc`;

const SQL_CARTERAS = `
SELECT r.k, x.*
  FROM (VALUES ('cxc', $1::date, 'CXC'), ('cxc_ant', $2::date, 'CXC'),
               ('cxp', $1::date, 'CXP'), ('cxp_ant', $2::date, 'CXP')) r(k, corte, tipo)
  CROSS JOIN LATERAL (${conRango(SQL_CARTERA, ['r.corte', 'r.tipo'])}) x`;

const SQL_DEL_PERIODO = `
SELECT * FROM (${SQL_COBERTURA}) cob
  CROSS JOIN (${SQL_BORRADORES}) bor
  CROSS JOIN (${SQL_MESES_CERRADOS}) mc
  CROSS JOIN (${SQL_RETENIDO}) ret
  CROSS JOIN (${SQL_EGRESOS}) egr
  CROSS JOIN (${SQL_NOMINA}) nom
  CROSS JOIN (${SQL_DESDE_DATOS}) dd`;

/**
 * Serie mensual con la ventana resuelta en SQL: [máx(mes de desde_datos, $1), $2].
 * $1 = mes del corte − 11, $2 = mes del corte, $3 = corte. Sin datos, no hay filas.
 */
const SQL_SERIE_VENTANA = SQL_SERIE.replace(
  'generate_series($1::date, $2::date,',
  `generate_series(GREATEST($1::date, date_trunc('month', (${SQL_DESDE_DATOS.replace(' AS desde_datos', '')})::date)::date), $2::date,`,
);

// ─── Ensamblado ──────────────────────────────────────────────────────────────

const filas = async (db, sql, params) => (await db.query(sql, params)).rows;

/** Edades de cartera al corte: siempre las 5, en el orden de EDADES. */
function armarEdades(rows) {
  const por = new Map(rows.map((r) => [r.edad, r]));
  const edades = EDADES.map((e) => ({
    edad: e,
    documentos: por.get(e)?.documentos ?? 0,
    valor: deCentavos(aCentavos(por.get(e)?.valor ?? 0)),
  }));
  const saldo = edades.reduce((s, e) => s + aCentavos(e.valor), 0);
  const vencido = edades.filter((e) => e.edad !== 'POR_VENCER').reduce((s, e) => s + aCentavos(e.valor), 0);
  const vence7 = rows.reduce((s, r) => s + aCentavos(r.vence_7_dias), 0);
  return { edades, saldo: deCentavos(saldo), vencido: deCentavos(vencido), vence_7_dias: deCentavos(vence7) };
}

const utilidadDe = (r) => deCentavos(aCentavos(r.ingresos) - aCentavos(r.costos) - aCentavos(r.gastos));

export async function estadisticasFinanzas(q = {}, db = pool, hoy = hoyCO()) {
  const p = calcularPeriodo(q, hoy);
  const act = [p.desde, p.corte];
  const [ya, ym] = p.corte.split('-').map(Number);
  const [ia, im] = mesMas(ya, ym, -11);
  const mesFin = `${p.corte.slice(0, 7)}-01`;

  // Todas a la vez sobre el pool (no sobre un solo cliente: pg avisa de consultas concurrentes).
  const [porPeriodo, carteras, [unico], clientes, causales, cuentas, serie] = await Promise.all([
    filas(db, SQL_POR_PERIODO, [p.desde, p.corte, p.comparacion.desde, p.comparacion.corte]),
    filas(db, SQL_CARTERAS, [p.corte, p.comparacion.corte]),
    filas(db, SQL_DEL_PERIODO, act),
    filas(db, SQL_CLIENTES, act),
    filas(db, SQL_CAUSALES, act),
    filas(db, SQL_CUENTAS, act),
    filas(db, SQL_SERIE_VENTANA, [`${ia}-${pad(im)}-01`, mesFin, p.corte]),
  ]);
  const actual = porPeriodo.find((r) => r.k === 'act');
  const anterior = porPeriodo.find((r) => r.k === 'ant');
  const cartera = (k) => armarEdades(carteras.filter((r) => r.k === k));
  const desde_datos = unico.desde_datos ? unico.desde_datos.slice(0, 10) : null;

  const mesHoy = hoy.slice(0, 7);
  const rango = [p.desde.slice(0, 7), p.corte.slice(0, 7)];
  const meses = desde_datos ? serie.map((m) => ({
    mes: m.mes,
    en_periodo: m.mes >= rango[0] && m.mes <= rango[1],
    actual: m.mes === mesHoy,
    cerrado: m.cerrado,
    facturado_neto: m.facturado_neto,
    facturado_total: m.facturado_total,
    recaudado: m.recaudado,
    ingresos: m.ingresos,
    costos_gastos: m.costos_gastos,
    utilidad: m.utilidad,
  })) : [];

  // Clientes: 5 primeros y el resto en «otros».
  const top = clientes.slice(0, 5).map((c) => ({ tercero_id: c.tercero_id, nombre: c.nombre, valor: c.valor }));
  const resto = clientes.slice(5);
  const otrosValor = resto.reduce((s, c) => s + aCentavos(c.valor), 0);
  const totalClientes = clientes.reduce((s, c) => s + aCentavos(c.valor), 0);

  // Cuentas de costos y gastos: 5 primeras y el resto en «otras».
  const cuentasTop = cuentas.slice(0, 5).map((c) => ({ codigo: c.codigo, nombre: c.nombre, valor: c.valor }));
  const otras = cuentas.slice(5).reduce((s, c) => s + aCentavos(c.valor), 0);

  const carteraAct = cartera('cxc');
  const carteraAnt = cartera('cxc_ant');
  const pagarAct = cartera('cxp');
  const pagarAnt = cartera('cxp_ant');

  return {
    periodo: {
      tipo: p.tipo, desde: p.desde, fin: p.fin, corte: p.corte,
      en_curso: p.en_curso,
      provisional: unico.meses_cerrados < unico.meses,
      comparacion: p.comparacion,
    },
    desde_datos,
    cobertura: {
      documentos: unico.documentos,
      contabilizados: unico.contabilizados,
      pendientes: unico.documentos - unico.contabilizados,
      con_error: unico.con_error,
      comprobantes_borrador: unico.comprobantes_borrador,
      meses: unico.meses,
      meses_cerrados: unico.meses_cerrados,
    },
    resumen: {
      facturacion: { neto: actual.neto, anterior: anterior.neto, facturas: actual.facturas, notas: actual.notas },
      recaudo: { valor: actual.recaudo, anterior: anterior.recaudo, retenido: unico.retenido },
      cartera: { saldo: carteraAct.saldo, vencido: carteraAct.vencido, anterior: carteraAnt.saldo },
      por_pagar: { saldo: pagarAct.saldo, vencido: pagarAct.vencido, vence_7_dias: pagarAct.vence_7_dias, anterior: pagarAnt.saldo },
      resultado: {
        ingresos: actual.ingresos, costos: actual.costos, gastos: actual.gastos,
        utilidad: utilidadDe(actual), anterior: utilidadDe(anterior), movimientos: actual.movimientos,
      },
      profesionales: { neto: actual.prof_neto, anterior: anterior.prof_neto, documentos: actual.prof_documentos },
    },
    meses,
    clientes: {
      top,
      otros: { valor: deCentavos(otrosValor), clientes: resto.length },
      total: deCentavos(totalClientes),
    },
    notas_credito: {
      valor: actual.notas_valor,
      facturado_bruto: actual.facturado_bruto,
      por_causal: causales.map((c) => ({ causal: c.causal == null ? null : String(c.causal), notas: c.notas, valor: c.valor })),
    },
    edades_cxc: carteraAct.edades,
    por_pagar: { saldo: pagarAct.saldo, vencido: pagarAct.vencido, vence_7_dias: pagarAct.vence_7_dias, pagado_periodo: unico.pagado },
    resultado: {
      cuentas: cuentasTop,
      otras: deCentavos(otras),
      nomina: { devengado: unico.devengado, empleados: unico.empleados },
    },
  };
}
