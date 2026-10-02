import { Router } from 'express';
import { pool } from '../../config/db.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authRequired, requireRole } from '../../middleware/auth.js';
import { balanceComprobacion } from './balance.service.js';
import { auxiliarPorCuenta } from './auxiliar.service.js';
import { enviarLibro, libroConEncabezado, pesos, titulosDeColumna } from './excel.js';

const router = Router();
router.use(authRequired);

/**
 * Fase C · Informes contables. Solo consultan el libro: los ven quienes ven la
 * contabilidad (admin, contador y auditor).
 *
 * Filtros comunes (query): desde, hasta (AAAA-MM-DD; sin ellas, el mes en curso),
 * cuenta (prefijo del código), tercero_id, centro_costo_id, sin_cierre=true.
 */
const LEER = requireRole('admin', 'contador', 'auditor');

/** Las líneas de «filtros aplicados» del encabezado del Excel, con nombres y no ids. */
async function lineasDeFiltro(f) {
  const lineas = [];
  if (f.cuenta) lineas.push(`Cuentas que empiezan por ${f.cuenta}`);
  if (f.terceroId) {
    const t = (await pool.query(
      `SELECT COALESCE(razon_social, NULLIF(btrim(concat_ws(' ', nombres, apellidos)), '')) AS nombre, numero_documento
         FROM sst.terceros WHERE id = $1`, [f.terceroId],
    )).rows[0];
    if (t) lineas.push(`Tercero: ${t.nombre} (${t.numero_documento})`);
  }
  if (f.centroCostoId) {
    const c = (await pool.query(`SELECT codigo, nombre FROM sst.centros_costo WHERE id = $1`, [f.centroCostoId])).rows[0];
    if (c) lineas.push(`Centro de costo: ${c.codigo} · ${c.nombre}`);
  }
  if (f.sinCierre) lineas.push('Sin el comprobante de cierre de año');
  return lineas;
}

// ─── C1-01 · Balance de comprobación (RPC-06) ────────────────────────────────

// ?nivel=1|2|4|6|10 (por defecto 10: hasta el auxiliar).
router.get('/balance', LEER, asyncHandler(async (req, res) => {
  res.json({ data: await balanceComprobacion(req.query) });
}));

router.get('/balance/xlsx', LEER, asyncHandler(async (req, res) => {
  const b = await balanceComprobacion(req.query);
  const extra = [`Nivel: ${b.filtros.nivel_nombre}`, ...(await lineasDeFiltro(b.filtros))];
  const { wb, ws } = await libroConEncabezado({
    titulo: 'Balance de comprobación', hoja: 'Balance', desde: b.filtros.desde, hasta: b.filtros.hasta, extra,
  });
  titulosDeColumna(ws, ['Código', 'Cuenta', 'Nivel', 'Saldo inicial', 'Débito', 'Crédito', 'Saldo final'], [14, 46, 11, 18, 18, 18, 18]);
  for (const f of b.filas) {
    const fila = ws.addRow([f.codigo, f.nombre, nombreNivel(f.nivel), f.saldo_inicial, f.debito, f.credito, f.saldo_final]);
    pesos(fila, [4, 5, 6, 7]);
    // Clases y grupos en negrilla: es como se lee un balance de prueba.
    if (f.nivel <= 2) fila.font = { bold: true };
  }
  const total = ws.addRow(['', 'Total', '', b.totales.saldo_inicial, b.totales.debito, b.totales.credito, b.totales.saldo_final]);
  pesos(total, [4, 5, 6, 7]);
  total.font = { bold: true };
  total.border = { top: { style: 'thin' } };
  await enviarLibro(res, wb, `balance-de-comprobacion_${b.filtros.desde}_${b.filtros.hasta}`);
}));

const nombreNivel = (n) => ({ 1: 'Clase', 2: 'Grupo', 4: 'Cuenta', 6: 'Subcuenta' })[n] ?? 'Auxiliar';

// ─── C2-01 · Movimiento general por cuenta — auxiliar (RPC-09) ───────────────

router.get('/auxiliar', LEER, asyncHandler(async (req, res) => {
  res.json({ data: await auxiliarPorCuenta(req.query) });
}));

router.get('/auxiliar/xlsx', LEER, asyncHandler(async (req, res) => {
  const a = await auxiliarPorCuenta(req.query);
  const { wb, ws } = await libroConEncabezado({
    titulo: 'Movimiento auxiliar de cuenta', hoja: 'Auxiliar', desde: a.filtros.desde, hasta: a.filtros.hasta,
    extra: await lineasDeFiltro(a.filtros),
  });
  // Las nueve columnas de Siigo en su orden, y después lo que Siigo no trae.
  titulosDeColumna(
    ws,
    ['Código contable', 'Cuenta contable', 'Comprobante', 'Fecha', 'Cliente, Proveedor u Otros', 'Saldo inicial', 'Débito', 'Crédito', 'Saldo final', 'Documento cruce', 'Descripción'],
    [14, 30, 13, 12, 40, 17, 17, 17, 17, 16, 40],
  );
  for (const c of a.cuentas) {
    let saldoAnterior = c.saldo_inicial;
    for (const m of c.movimientos) {
      const fila = ws.addRow([
        c.codigo, c.nombre, m.comprobante, fechaExcel(m.fecha), m.tercero_nombre ?? '',
        saldoAnterior, m.debito, m.credito, m.saldo, m.documento_cruce ?? '', m.descripcion ?? '',
      ]);
      fila.getCell(4).numFmt = 'dd/mm/yyyy';
      pesos(fila, [6, 7, 8, 9]);
      saldoAnterior = m.saldo;
    }
    // Total de la cuenta, como la fila sin comprobante con que Siigo cierra cada una.
    const sub = ws.addRow([c.codigo, c.nombre, '', null, '', c.saldo_inicial, c.debito, c.credito, c.saldo_final]);
    pesos(sub, [6, 7, 8, 9]);
    sub.font = { bold: true };
    sub.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2FB' } };
  }
  const total = ws.addRow(['', 'Total general', '', null, '', a.totales.saldo_inicial, a.totales.debito, a.totales.credito, a.totales.saldo_final]);
  pesos(total, [6, 7, 8, 9]);
  total.font = { bold: true };
  total.border = { top: { style: 'thin' } };
  await enviarLibro(res, wb, `auxiliar_${a.filtros.desde}_${a.filtros.hasta}`);
}));

// "2026-09-30" → fecha de Excel sin corrimiento de zona (mediodía UTC).
const fechaExcel = (iso) => (iso ? new Date(`${iso}T12:00:00Z`) : null);

export default router;
