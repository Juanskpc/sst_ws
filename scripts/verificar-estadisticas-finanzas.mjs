// Verifica al centavo las cifras de Estadísticas de Finanzas contra los informes que ya existen.
// SOLO LEE: cada conexión abre con default_transaction_read_only = on (PGOPTIONS, antes de crear el pool).
//
//   cd sst_ws && node scripts/verificar-estadisticas-finanzas.mjs [AAAA-MM ...]
//
// Sin argumentos revisa cada mes desde `desde_datos` hasta hoy, más el trimestre y el año en curso.
// Comprobaciones (veredicto del 20-nov-2026, §9.2):
//   V1  facturación neta = Ventas por cliente (subtotal)          V7  Σ meses del periodo = V1 y V5
//   V2  Σ top + otros = total de clientes = V1                     V8  edades CXC al día de hoy = Antigüedad de cartera
//   V3  cada cliente del top = su fila en Ventas por cliente      V9  por pagar hoy = Antigüedad CXP
//   V4  notas crédito = − Σ notas de Ventas por cliente           V10 recaudo = recibos contabilizados del periodo
//   V5  ingresos, costos, gastos y utilidad = Estado de resultados V11 pendientes = documentos sin asiento del periodo
//   V6  Σ cuentas + otras = costos + gastos                        V12 saldo reconstruido a hoy = saldo de cada documento
//   V13 cifras «anterior» (comparación a la misma altura) = las mismas fuentes en ese tramo
// Además informa (sin fallar) la diferencia entre la facturación documental y los ingresos del libro.
// Sale con código 1 si alguna comprobación da DIFERENTE.
process.env.PGOPTIONS = '-c default_transaction_read_only=on';

const { pool } = await import('../src/config/db.js');
const { aCentavos, deCentavos } = await import('../src/utils/dinero.js');
const { hoyCO } = await import('../src/utils/formato.js');
const { estadisticasFinanzas, SQL_SALDO_AL_CORTE } = await import('../src/modules/informes-contables/estadisticas.service.js');
const { ventasPorCliente } = await import('../src/modules/informes-contables/ventas.service.js');
const { estadoResultados } = await import('../src/modules/informes-contables/estados.service.js');
const { antiguedad, listarRecibos, EDADES } = await import('../src/modules/cartera/cartera.service.js');
const { listarPendientes } = await import('../src/modules/contabilidad/contabilizacion.service.js');

const ro = (await pool.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only;
if (ro !== 'on') { console.error('La sesión no quedó en solo lectura; se aborta.'); process.exit(2); }

const hoy = hoyCO();
const c = (v) => aCentavos(v ?? 0);
const pesos = (cent) => deCentavos(cent);
const resultados = [];
let fallos = 0;
const comprobar = (clave, periodo, detalle, a, b) => {
  const ok = a === b;
  if (!ok) fallos++;
  resultados.push({ comprobacion: clave, periodo, detalle, estadisticas: pesos(a), informe: pesos(b), resultado: ok ? 'OK' : 'DIFERENTE' });
};
const verificarIgual = (clave, periodo, detalle, cond, texto) => {
  if (!cond) fallos++;
  resultados.push({ comprobacion: clave, periodo, detalle, estadisticas: texto, informe: '', resultado: cond ? 'OK' : 'DIFERENTE' });
};

// Periodos a revisar.
const args = process.argv.slice(2).filter((a) => /^\d{4}-\d{2}$/.test(a));
const base = await estadisticasFinanzas({});
const periodos = [];
if (args.length) for (const ref of args) periodos.push({ periodo: 'mes', ref });
else {
  const ini = base.desde_datos ? base.desde_datos.slice(0, 7) : hoy.slice(0, 7);
  let [a, m] = ini.split('-').map(Number);
  const [ha, hm] = hoy.slice(0, 7).split('-').map(Number);
  while (a * 12 + m <= ha * 12 + hm) {
    periodos.push({ periodo: 'mes', ref: `${a}-${String(m).padStart(2, '0')}` });
    m++; if (m > 12) { m = 1; a++; }
  }
  periodos.push({ periodo: 'trimestre', ref: hoy.slice(0, 7) }, { periodo: 'anio', ref: hoy.slice(0, 7) });
}

const pendientes = await listarPendientes();
const tiempos = [];
let controlLibro = [];

for (const q of periodos) {
  const t0 = performance.now();
  console.time(`estadisticas ${q.periodo} ${q.ref}`);
  const e = await estadisticasFinanzas(q);
  console.timeEnd(`estadisticas ${q.periodo} ${q.ref}`);
  tiempos.push(performance.now() - t0);
  const { desde, corte } = e.periodo;
  const nom = `${q.periodo} ${q.ref} (${desde}→${corte})`;

  // V1–V4 · Ventas por cliente.
  const v = await ventasPorCliente({ desde, hasta: corte });
  comprobar('V1', nom, 'Facturación neta', c(e.resumen.facturacion.neto), c(v.totales.subtotal));
  const sumaClientes = e.clientes.top.reduce((s, x) => s + c(x.valor), 0) + c(e.clientes.otros.valor);
  comprobar('V2', nom, 'Σ top + otros', sumaClientes, c(v.totales.subtotal));
  comprobar('V2', nom, 'clientes.total', c(e.clientes.total), c(v.totales.subtotal));
  if (!e.clientes.top.length) verificarIgual('V3', nom, 'Sin clientes en el periodo', v.clientes.length === 0, `${v.clientes.length} clientes en el informe`);
  for (const t of e.clientes.top) {
    const fila = v.clientes.find((x) => x.tercero_id === t.tercero_id);
    comprobar('V3', nom, `Cliente ${t.nombre.slice(0, 28)}`, c(t.valor), c(fila?.subtotal));
  }
  const notasInforme = v.clientes.flatMap((x) => x.documentos).filter((d) => d.tipo === 'NOTA_CREDITO').reduce((s, d) => s + c(d.subtotal), 0);
  comprobar('V4', nom, 'Notas crédito', c(e.notas_credito.valor), -notasInforme);

  // V5–V6 · Estado de resultados.
  const er = await estadoResultados({ desde, hasta: corte });
  const sec = (k) => c(er.secciones.find((s) => s.clave === k)?.total);
  comprobar('V5', nom, 'Ingresos', c(e.resumen.resultado.ingresos), sec('INGRESOS'));
  comprobar('V5', nom, 'Costos', c(e.resumen.resultado.costos), sec('COSTOS'));
  comprobar('V5', nom, 'Gastos', c(e.resumen.resultado.gastos), sec('GASTOS'));
  comprobar('V5', nom, 'Utilidad', c(e.resumen.resultado.utilidad), c(er.utilidad));
  const sumaCuentas = e.resultado.cuentas.reduce((s, x) => s + c(x.valor), 0) + c(e.resultado.otras);
  comprobar('V6', nom, 'Σ cuentas + otras', sumaCuentas, c(e.resumen.resultado.costos) + c(e.resumen.resultado.gastos));

  // V7 · La serie mensual del periodo suma lo mismo.
  const enPeriodo = e.meses.filter((m) => m.en_periodo);
  if (enPeriodo.length || c(v.totales.subtotal) || c(er.utilidad)) {
    comprobar('V7', nom, 'Σ meses · facturado neto', enPeriodo.reduce((s, m) => s + c(m.facturado_neto), 0), c(v.totales.subtotal));
    comprobar('V7', nom, 'Σ meses · utilidad', enPeriodo.reduce((s, m) => s + c(m.utilidad), 0), c(er.utilidad));
  }

  // V10 · Recaudo.
  const recibos = (await listarRecibos({ desde, hasta: corte })).filter((r) => r.estado === 'CONTABILIZADO');
  comprobar('V10', nom, 'Recaudo', c(e.resumen.recaudo.valor), recibos.reduce((s, r) => s + c(r.valor_consignado), 0));

  // V11 · Cobertura.
  const pend = pendientes.filter((p) => p.fecha_emision >= desde && p.fecha_emision <= corte).length;
  comprobar('V11', nom, 'Documentos sin asiento (cantidad)', (e.cobertura.documentos - e.cobertura.contabilizados) * 100, pend * 100);

  // V8–V9 · Cartera con corte = hoy.
  if (corte === hoy) {
    const ant = await antiguedad(hoy);
    comprobar('V8', nom, 'CXC total', e.edades_cxc.reduce((s, x) => s + c(x.valor), 0), c(ant.total.TOTAL));
    for (const ed of EDADES) comprobar('V8', nom, `CXC ${ed}`, c(e.edades_cxc.find((x) => x.edad === ed)?.valor), c(ant.total[ed]));
    verificarIgual('V8', nom, 'edades_cxc en orden', e.edades_cxc.map((x) => x.edad).join() === EDADES.join(), e.edades_cxc.map((x) => x.edad).join());
    const antP = await antiguedad(hoy, pool, 'CXP');
    comprobar('V9', nom, 'Por pagar', c(e.por_pagar.saldo), c(antP.total.TOTAL));
  }

  // V13 · Las cifras «anterior» (comparación a la misma altura) contra las mismas fuentes.
  {
    const ca = e.periodo.comparacion;
    const vA = await ventasPorCliente({ desde: ca.desde, hasta: ca.corte });
    comprobar('V13', nom, `Facturación anterior (${ca.desde}→${ca.corte})`, c(e.resumen.facturacion.anterior), c(vA.totales.subtotal));
    const erA = await estadoResultados({ desde: ca.desde, hasta: ca.corte });
    comprobar('V13', nom, 'Utilidad anterior', c(e.resumen.resultado.anterior), c(erA.utilidad));
    const recA = (await listarRecibos({ desde: ca.desde, hasta: ca.corte })).filter((r) => r.estado === 'CONTABILIZADO');
    comprobar('V13', nom, 'Recaudo anterior', c(e.resumen.recaudo.anterior), recA.reduce((s, r) => s + c(r.valor_consignado), 0));
    const dsA = (await pool.query(
      `SELECT COALESCE(sum(CASE WHEN tipo='DOC_SOPORTE' THEN subtotal ELSE -subtotal END),0)::numeric(16,2) AS neto
         FROM sst.documentos_electronicos WHERE tipo IN ('DOC_SOPORTE','NOTA_AJUSTE_DS') AND estado IN ('VALIDADO','ANULADO')
          AND fecha_emision BETWEEN $1 AND $2`, [ca.desde, ca.corte])).rows[0];
    comprobar('V13', nom, 'Pago a profesionales anterior', c(e.resumen.profesionales.anterior), c(dsA.neto));
    // Cartera a la fecha de comparación por otro camino: saldo guardado hoy + lo aplicado después de esa fecha.
    for (const [tipo, clave] of [['CXC', 'cartera'], ['CXP', 'por_pagar']]) {
      const r = (await pool.query(
        `SELECT COALESCE(sum(s) FILTER (WHERE s > 0), 0)::numeric(16,2) AS total FROM (
           SELECT cd.saldo + COALESCE((SELECT sum(a.valor_pagado + a.valor_retenciones + a.valor_anticipo) FROM sst.cartera_aplicaciones a
                                        WHERE a.cartera_documento_id = cd.id AND NOT a.anulada AND a.fecha > $1), 0) AS s
             FROM sst.cartera_documentos cd WHERE cd.tipo = $2 AND NOT cd.anulado AND cd.fecha <= $1) x`, [ca.corte, tipo])).rows[0];
      comprobar('V13', nom, `${tipo} anterior (saldo hoy + aplicado después)`, c(e.resumen[clave].anterior), c(r.total));
    }
  }

  controlLibro.push({ periodo: nom, documentos: e.resumen.facturacion.neto, libro: e.resumen.resultado.ingresos, diferencia: pesos(c(e.resumen.resultado.ingresos) - c(e.resumen.facturacion.neto)) });
}

// V12 · La reconstrucción a hoy da el saldo guardado de cada documento.
for (const tipo of ['CXC', 'CXP']) {
  const rec = (await pool.query(`${SQL_SALDO_AL_CORTE}`, [hoy, tipo])).rows;
  const guardado = new Map((await pool.query(`SELECT id, saldo FROM sst.cartera_documentos WHERE tipo = $1 AND NOT anulado`, [tipo])).rows.map((r) => [r.id, r.saldo]));
  const distintos = rec.filter((r) => c(r.saldo) !== c(guardado.get(r.id)));
  verificarIgual('V12', `hoy ${hoy}`, `Saldo reconstruido ${tipo} (${rec.length} documentos)`, distintos.length === 0 && rec.length === guardado.size,
    distintos.length ? `${distintos.length} documentos distintos` : `${rec.length} de ${guardado.size} iguales`);
}

console.table(resultados);
console.log('\nControl documental vs libro (se informa, no falla): ingresos del libro − facturación documental');
console.table(controlLibro);
const porClave = [...new Set(resultados.map((r) => r.comprobacion))];
console.log(`Comprobaciones cubiertas: ${porClave.join(', ')} (${porClave.length} de 13)`);
console.log(`Tiempo por respuesta: máx. ${Math.round(Math.max(...tiempos))} ms · promedio ${Math.round(tiempos.reduce((s, t) => s + t, 0) / tiempos.length)} ms (límite 500 ms)`);
const lento = Math.max(...tiempos) >= 500;
if (lento) { console.log('DIFERENTE · alguna respuesta tardó 500 ms o más'); fallos++; }
if (porClave.length < 13) { console.log('DIFERENTE · faltan comprobaciones'); fallos++; }
console.log(fallos ? `\n${fallos} comprobaciones DIFERENTES` : '\nTodo OK');
await pool.end();
process.exit(fallos ? 1 : 0);
