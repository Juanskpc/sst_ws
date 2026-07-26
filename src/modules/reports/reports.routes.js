import { Router } from 'express';
import ExcelJS from 'exceljs';
import { pool } from '../../config/db.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authRequired } from '../../middleware/auth.js';
import { badRequest, notFound } from '../../utils/httpError.js';
import { getOrderExpanded } from '../orders/orders.service.js';
import { executiveSummary, interpretSearch } from '../../services/gemini.service.js';

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
