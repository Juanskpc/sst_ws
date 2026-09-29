import { Router } from 'express';
import ExcelJS from 'exceljs';
import { pool } from '../../config/db.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authRequired } from '../../middleware/auth.js';
import { badRequest, notFound } from '../../utils/httpError.js';
import { getOrderExpanded } from '../orders/orders.service.js';
import { executiveSummary, interpretSearch } from '../../services/gemini.service.js';
import { avisarCorteDeCobro } from '../billing/billing.service.js';
import { etiquetaTipoActividadBolivar } from '../../utils/bolivar.js';

const router = Router();
router.use(authRequired);

/**
 * Tope de filas por exportación. Por encima de esto el propio cuerpo JSON
 * chocaría antes con el límite de 2 MB de `express.json` (ver src/app.js), así
 * que el número se mantiene alineado con ese techo real.
 */
const MAX_FILAS_XLSX = 5000;

/**
 * Valor listo para una celda: los números se escriben como números (para que
 * Excel pueda sumarlos u ordenarlos) y el resto como texto. Un string como
 * "0450" se deja tal cual: convertirlo perdería el cero inicial.
 */
function aCelda(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  return String(v);
}

// RPT-01/02 · KPIs del dashboard + distribución por ARL.
router.get('/dashboard', asyncHandler(async (_req, res) => {
  // CFG-05 · Sin tareas programadas, el aviso del día de corte se materializa
  // al abrir una pantalla. Esta la abre todo el mundo al entrar, así que es
  // donde antes se enteran de que el mes anterior quedó sin cobrar.
  avisarCorteDeCobro().catch(() => {});
  const [kpis, byArl, monthly] = await Promise.all([
    pool.query(`SELECT * FROM sst.vw_kpis_dashboard`),
    pool.query(`SELECT * FROM sst.vw_ordenes_por_arl`),
    pool.query(`SELECT * FROM sst.vw_estados_mensual WHERE mes = date_trunc('month', now())`),
  ]);
  res.json({
    data: {
      kpis: kpis.rows[0],
      por_arl: byArl.rows,
      estados_mes: monthly.rows,
    },
  });
}));

// Informes · Resumen ejecutivo IA de 3 párrafos por OS.
// PENDIENTE DE MIGRACIÓN: usa executiveSummary (Gemini/mock), NO el motor
// principal de extracción (OpenAI).
router.post('/summary/:orderId', asyncHandler(async (req, res) => {
  const order = await getOrderExpanded(req.params.orderId);
  if (!order) throw notFound('OS no encontrada');
  const summary = await executiveSummary(order);
  res.json({ data: { order_id: order.id, summary } });
}));

// Informes · Buscador en lenguaje natural → filtros → resultados.
// PENDIENTE DE MIGRACIÓN: usa interpretSearch (Gemini/mock), NO el motor
// principal de extracción (OpenAI).
router.post('/search', asyncHandler(async (req, res) => {
  const { query } = req.body || {};
  const filters = await interpretSearch(query || '');

  const clauses = [];
  const params = [];
  if (filters.arl) { params.push(filters.arl); clauses.push(`arl_nombre = $${params.length}`); }
  if (filters.status) { params.push(filters.status); clauses.push(`estado = $${params.length}::sst.estado_orden`); }
  if (filters.minHoras) { params.push(filters.minHoras); clauses.push(`horas_asignadas >= $${params.length}`); }
  if (filters.bajaConfianza) {
    clauses.push(`(metadatos_extraccion->>'overall_confidence')::numeric <
      (SELECT valor::numeric FROM sst.configuracion WHERE clave='confidence_threshold')`);
  }
  if (filters.texto) {
    params.push(`%${filters.texto}%`);
    clauses.push(`(empresa_nombre ILIKE $${params.length} OR descripcion ILIKE $${params.length})`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const r = await pool.query(
    `SELECT * FROM sst.vw_ordenes_expandidas ${where} ORDER BY fecha_carga DESC LIMIT 100`, params
  );
  res.json({ data: { filters, results: r.rows } });
}));

/**
 * RPT-03 · Órdenes vencidas: más de N días (60 por defecto) sin ejecutarse.
 *
 * Se devuelven ordenadas por antigüedad porque el reporte se lee de arriba
 * hacia abajo para decidir a quién llamar primero.
 */
router.get('/vencidas', asyncHandler(async (req, res) => {
  const dias = Number.parseInt(req.query.dias ?? '60', 10);
  if (!Number.isFinite(dias) || dias < 0) throw badRequest('El umbral de días debe ser un entero positivo');

  const params = [dias];
  const clauses = [`dias_transcurridos > $1`];
  if (req.query.arl_id) { params.push(req.query.arl_id); clauses.push(`arl_id = $${params.length}`); }
  if (req.query.estado) { params.push(req.query.estado); clauses.push(`estado = $${params.length}::sst.estado_orden`); }

  const [filas, resumen] = await Promise.all([
    pool.query(
      `SELECT * FROM sst.vw_ordenes_vencidas WHERE ${clauses.join(' AND ')}
        ORDER BY dias_transcurridos DESC LIMIT 1000`, params),
    pool.query(
      `SELECT count(*)::int                                              AS total,
              count(*) FILTER (WHERE dias_transcurridos > $1 * 2)::int   AS criticas,
              coalesce(sum(horas_asignadas), 0)::numeric                 AS horas,
              max(dias_transcurridos)::int                               AS max_dias
         FROM sst.vw_ordenes_vencidas WHERE ${clauses.join(' AND ')}`, params),
  ]);
  res.json({ data: { umbral_dias: dias, resumen: resumen.rows[0], ordenes: filas.rows } });
}));

/**
 * RPT-05 · Horas ejecutadas por profesional y por ARL en un rango de fechas.
 *
 * El rango se mide sobre la fecha de ejecución (la misma que usa la pre-cuenta),
 * no sobre la de carga: si no coincidieran, las horas del informe y las que se
 * le pagan al profesional darían distinto.
 */
router.get('/horas', asyncHandler(async (req, res) => {
  const { desde, hasta } = req.query;
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(desde || '') || !iso.test(hasta || '')) {
    throw badRequest('Indique "desde" y "hasta" en formato AAAA-MM-DD');
  }
  if (desde > hasta) throw badRequest('La fecha inicial no puede ser posterior a la final');

  const rango = [desde, hasta];
  const [porProfesional, porArl, porMes, totales] = await Promise.all([
    pool.query(
      // Los viáticos van en su propia columna, no sumados a nada: son un
      // reembolso de gasto y mezclarlos con las horas o con los honorarios haría
      // ilegible el informe de trabajo ejecutado.
      `SELECT profesional_id, profesional_nombre,
              count(*)::int AS ordenes, sum(horas)::numeric AS horas,
              coalesce(sum(viaticos_valor), 0)::numeric AS viaticos
         FROM sst.vw_horas_ejecutadas
        WHERE fecha_ejecucion BETWEEN $1::date AND $2::date
        GROUP BY 1,2 ORDER BY horas DESC`, rango),
    pool.query(
      `SELECT arl_nombre, count(*)::int AS ordenes, sum(horas)::numeric AS horas,
              coalesce(sum(viaticos_valor), 0)::numeric AS viaticos
         FROM sst.vw_horas_ejecutadas
        WHERE fecha_ejecucion BETWEEN $1::date AND $2::date
        GROUP BY 1 ORDER BY horas DESC`, rango),
    pool.query(
      `SELECT periodo AS mes, count(*)::int AS ordenes, sum(horas)::numeric AS horas
         FROM sst.vw_horas_ejecutadas
        WHERE fecha_ejecucion BETWEEN $1::date AND $2::date
        GROUP BY 1 ORDER BY 1`, rango),
    pool.query(
      `SELECT count(*)::int AS ordenes, coalesce(sum(horas),0)::numeric AS horas,
              coalesce(sum(viaticos_valor),0)::numeric AS viaticos,
              count(DISTINCT profesional_id)::int AS profesionales
         FROM sst.vw_horas_ejecutadas
        WHERE fecha_ejecucion BETWEEN $1::date AND $2::date`, rango),
  ]);

  res.json({
    data: {
      desde, hasta,
      totales: totales.rows[0],
      por_profesional: porProfesional.rows,
      por_arl: porArl.rows,
      por_mes: porMes.rows,
    },
  });
}));

/**
 * Estado de FACTURACIÓN de las órdenes cerradas (ago-2026, petición 6).
 *
 * Responde a la pregunta que el cliente hizo en la reunión: «de lo que ya
 * ejecutamos, ¿qué falta por facturar?». Solo entran las FINALIZADAS, que es
 * donde arranca el eje (decisión D-7): una orden sin cerrar no tiene nada que
 * facturarse.
 *
 * ⚠️ La cifra es `valor_total`, el valor de la orden SEGÚN EL DOCUMENTO DE LA
 * ARL — que es lo que se le cobra a ella—, no `valor_cobro_total`, que es lo que
 * JD&D le paga al profesional. Son dos números distintos y confundirlos daría un
 * pendiente de cobro que no existe. Los viáticos van aparte por lo mismo: son un
 * reembolso, y si se cobran a la ARL o no sigue siendo la decisión D-9.
 */
router.get('/cobro', asyncHandler(async (req, res) => {
  const params = [];
  const clauses = [`estado = 'FINALIZADA'`];
  if (req.query.arl_id) { params.push(req.query.arl_id); clauses.push(`arl_id = $${params.length}`); }
  if (req.query.estado_cobro) {
    params.push(req.query.estado_cobro);
    clauses.push(`estado_cobro = $${params.length}::sst.estado_cobro`);
  }
  const where = `WHERE ${clauses.join(' AND ')}`;
  // El desglose por estado se calcula SIN el filtro de estado de cobro: si no,
  // marcar "FACTURADA" en el filtro dejaría el resumen con una sola barra y ya no
  // se podría ver contra qué se compara.
  const whereSinEstado = `WHERE ${clauses.filter((c) => !c.includes('estado_cobro')).join(' AND ')}`;
  const paramsSinEstado = req.query.arl_id ? [req.query.arl_id] : [];

  const [porEstado, porArl, filas, totales] = await Promise.all([
    pool.query(
      `SELECT estado_cobro::text AS estado_cobro, count(*)::int AS ordenes,
              coalesce(sum(valor_total), 0)::numeric AS valor
         FROM sst.vw_ordenes_expandidas ${whereSinEstado}
        GROUP BY 1`, paramsSinEstado),
    pool.query(
      // A3-01 · Las órdenes particulares no tienen ARL: van juntas en su fila.
      `SELECT COALESCE(arl_nombre, 'PARTICULAR') AS arl_nombre, count(*)::int AS ordenes,
              coalesce(sum(valor_total), 0)::numeric AS valor,
              -- Lo que falta por facturarle a cada ARL: es la cifra que la
              -- contadora persigue, y es por ARL porque se radica ARL por ARL.
              coalesce(sum(valor_total) FILTER (WHERE estado_cobro = 'NO FACTURADA'), 0)::numeric AS sin_facturar
         FROM sst.vw_ordenes_expandidas ${where}
        GROUP BY 1 ORDER BY sin_facturar DESC`, params),
    pool.query(
      `SELECT id, codigo, COALESCE(arl_nombre, 'PARTICULAR') AS arl_nombre, empresa_nombre, nit_nic, tipo_actividad,
              horas_asignadas, valor_total, viaticos_valor, viaticos_tipo,
              estado_cobro::text AS estado_cobro, cobro_numero_factura, cobro_observacion,
              cobro_actualizado_en, fecha_ejecucion, profesional_nombre
         FROM sst.vw_ordenes_expandidas ${where}
        ORDER BY estado_cobro, fecha_ejecucion DESC NULLS LAST
        LIMIT 1000`, params),
    // Con dos estados los totales son dos y suman el valor: lo que falta por
    // facturar y lo ya facturado. No hay "pendiente de cobro" separado —eso
    // exigiría un estado PAGADA que el cliente retiró—, y fingirlo con la misma
    // cifra que "sin facturar" sería enseñar dos veces el mismo número.
    pool.query(
      `SELECT count(*)::int AS ordenes,
              coalesce(sum(valor_total), 0)::numeric AS valor,
              coalesce(sum(valor_total) FILTER (WHERE estado_cobro = 'NO FACTURADA'), 0)::numeric AS sin_facturar,
              coalesce(sum(valor_total) FILTER (WHERE estado_cobro = 'FACTURADA'), 0)::numeric AS facturado,
              coalesce(sum(viaticos_valor), 0)::numeric AS viaticos
         FROM sst.vw_ordenes_expandidas ${where}`, params),
  ]);

  res.json({
    data: {
      totales: totales.rows[0],
      por_estado: porEstado.rows,
      por_arl: porArl.rows,
      ordenes: filas.rows,
    },
  });
}));

/**
 * T0-08 · "Bolívar: qué debo facturar" — la relación de órdenes en el MISMO
 * formato que `RELACION ORDENES ARL BOLIVAR-…xlsx` que ya arma JD&D a mano
 * (§3.6 del plan): mismas diez columnas, en el mismo orden, con una fila de
 * total al final. Es la hoja que se radica junto a la prefactura.
 *
 * Filtro: ARL Bolívar, FINALIZADA, NO FACTURADA (lo ya facturado no vuelve a
 * aparecer aquí) y la fecha de ejecución dentro del rango. Por defecto el rango
 * es el ÚLTIMO CORTE DE BOLÍVAR: del 16 del mes anterior al 15 del actual —el
 * nombre del archivo de ejemplo ("...-15 DE SEPTIEMBRE...") es ese corte—, pero
 * se puede pedir cualquier otro con `?desde=&hasta=`.
 */
router.get('/relacion-bolivar', asyncHandler(async (req, res) => {
  const hoy = new Date();
  // Corte por defecto: si hoy es 20-sep, el corte vigente va del 16-ago al
  // 15-sep (el que ya se puede radicar); del 1 al 15, el corte es el del propio
  // mes (16 del mes anterior sigue siendo el mes anterior).
  const anclaHasta = new Date(hoy.getFullYear(), hoy.getMonth(), 15);
  const hastaPorDefecto = hoy.getDate() > 15 ? new Date(hoy.getFullYear(), hoy.getMonth() + 1, 15) : anclaHasta;
  const desdePorDefecto = new Date(hastaPorDefecto.getFullYear(), hastaPorDefecto.getMonth() - 1, 16);
  const aIso = (d) => d.toISOString().slice(0, 10);

  const desde = /^\d{4}-\d{2}-\d{2}$/.test(req.query.desde) ? req.query.desde : aIso(desdePorDefecto);
  const hasta = /^\d{4}-\d{2}-\d{2}$/.test(req.query.hasta) ? req.query.hasta : aIso(hastaPorDefecto);
  if (desde > hasta) throw badRequest('"desde" no puede ser posterior a "hasta".');

  const filas = (await pool.query(
    `SELECT o.tipo_servicio_arl, o.tipo_actividad, o.descripcion,
            o.horas_asignadas, o.valor_unitario,
            COALESCE((o.viaticos_detalle->>'transporte')::numeric, 0) AS valor_transporte,
            o.codigo_cronograma, o.secuencia, o.empresa_nombre, o.numero_prefactura
       FROM sst.ordenes_servicio o
       JOIN sst.arls a ON a.id = o.arl_id
      WHERE a.nombre ILIKE '%bol%var%'
        AND o.estado = 'FINALIZADA'
        AND o.estado_cobro = 'NO FACTURADA'
        AND COALESCE(o.fecha_ejecucion::date, o.fecha_programada::date, o.actualizado_en::date)
            BETWEEN $1::date AND $2::date
      ORDER BY o.codigo_cronograma, o.secuencia`,
    [desde, hasta]
  )).rows;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'JD&D IA-Core';
  wb.created = new Date();
  const ws = wb.addWorksheet('Relación Bolívar');

  const headers = [
    'Tipo de actividad', 'Cantidad de horas', 'Valor unitario por hora', 'Valor transporte',
    'Total', 'SIPAB No. De Cronograma', 'secuencia', 'Empresa', 'Actividad a realizar',
    'Estado de facturación',
  ];
  ws.addRow(headers);
  const cabecera = ws.getRow(1);
  cabecera.font = { bold: true, size: 11 };
  cabecera.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFBFBFBF' } };
  cabecera.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };

  // Sin tarifa de venta (A0-06) todavía: el valor hora es el que trajo la orden
  // (`valor_unitario`, del documento de la ARL) y NADA MÁS. Inventar un
  // "estándar" —como el 71.457 del ejemplo, que es la tarifa vieja de Siigo—
  // dejaría una factura con un valor que nadie pactó. Sin él, la celda (y el
  // Total, que depende de ella) quedan vacías y resaltadas para completarlas a
  // mano antes de radicar.
  const SIN_TARIFA = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
  let totalGeneral = 0;
  for (const f of filas) {
    const horas = Number(f.horas_asignadas) || 0;
    const transporte = Number(f.valor_transporte) || 0;
    const tieneValor = f.valor_unitario != null && Number(f.valor_unitario) > 0;
    const valorUnitario = tieneValor ? Number(f.valor_unitario) : null;
    const total = tieneValor ? Math.round(horas * valorUnitario + transporte) : null;
    if (total != null) totalGeneral += total;

    const tipo = etiquetaTipoActividadBolivar(f.tipo_servicio_arl)?.toLowerCase()
      ?? (f.tipo_actividad || f.descripcion || '').toLowerCase();
    const row = ws.addRow([
      tipo, horas, valorUnitario ?? '', transporte, total ?? '',
      f.codigo_cronograma || '', f.secuencia || '', f.empresa_nombre || '',
      f.tipo_actividad || f.descripcion || '', f.numero_prefactura || '',
    ]);
    if (!tieneValor) {
      row.getCell(3).fill = SIN_TARIFA;
      row.getCell(5).fill = SIN_TARIFA;
    }
  }
  const filaTotal = ws.addRow(['', '', '', '', totalGeneral, '', '', '', '', '']);
  filaTotal.getCell(5).font = { bold: true };

  ws.getColumn(1).width = 20;
  ws.getColumn(2).width = 16;
  ws.getColumn(3).width = 20;
  ws.getColumn(4).width = 16;
  ws.getColumn(5).width = 14;
  ws.getColumn(6).width = 20;
  ws.getColumn(7).width = 12;
  ws.getColumn(8).width = 32;
  ws.getColumn(9).width = 40;
  ws.getColumn(10).width = 18;
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const buffer = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="relacion-bolivar-${hasta}.xlsx"`);
  res.send(Buffer.from(buffer));
}));

/**
 * Informes · Exportación a Excel real (.xlsx).
 *
 * Antes se descargaba un CSV separado por ';': Excel solo lo parte en columnas
 * si el separador de listas del sistema coincide, y en configuraciones con ','
 * la fila entera cae en la columna A. Un .xlsx no depende de la configuración
 * regional del equipo que lo abre.
 *
 * El frontend ya arma headers/filas (aplica sus filtros y calcula las columnas
 * de confianza), así que aquí solo se les da formato de hoja de cálculo.
 */
router.post('/xlsx', asyncHandler(async (req, res) => {
  const { hoja = 'Informe', headers = [], rows = [] } = req.body || {};
  if (!Array.isArray(headers) || !headers.length) throw badRequest('headers es obligatorio');
  if (!Array.isArray(rows)) throw badRequest('rows debe ser una lista');
  if (rows.length > MAX_FILAS_XLSX) {
    throw badRequest(`El informe supera las ${MAX_FILAS_XLSX} filas exportables`);
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'JD&D IA-Core';
  wb.created = new Date();
  // El nombre de hoja de Excel admite 31 caracteres y ningún []*/\?: .
  const ws = wb.addWorksheet(String(hoja).replace(/[[\]*/\\?:]/g, '').slice(0, 31) || 'Informe');

  ws.addRow(headers.map(String));
  for (const fila of rows) ws.addRow(Array.isArray(fila) ? fila.map(aCelda) : []);

  const cabecera = ws.getRow(1);
  cabecera.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  cabecera.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000B50' } }; // azul del logo
  cabecera.alignment = { vertical: 'middle' };
  cabecera.height = 22;
  // Fila de títulos siempre visible y filtros por columna: con informes de
  // decenas de columnas es la diferencia entre usable e ilegible.
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };

  // Ancho por columna según su contenido más largo, acotado para que una
  // descripción larga no deje una columna de 300 caracteres.
  ws.columns.forEach((col, i) => {
    let max = String(headers[i] ?? '').length;
    for (const fila of rows) {
      const largo = String(fila?.[i] ?? '').length;
      if (largo > max) max = largo;
    }
    col.width = Math.min(Math.max(max + 2, 10), 45);
  });

  const buffer = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment');
  res.send(Buffer.from(buffer));
}));

export default router;
