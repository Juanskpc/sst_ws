import { Router } from 'express';
import { pool } from '../../config/db.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authRequired, requireRole } from '../../middleware/auth.js';
import { balanceComprobacion } from './balance.service.js';
import { auxiliarPorCuenta, informePorTercero } from './auxiliar.service.js';
import { libroAuxiliar } from './libros.service.js';
import { ventasPorCliente } from './ventas.service.js';
import { estadoResultados, estadoSituacionFinanciera } from './estados.service.js';
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
  hojaPorCuenta(ws, a);
  await enviarLibro(res, wb, `auxiliar_${a.filtros.desde}_${a.filtros.hasta}`);
}));

// ─── C3-01 · Tercero general y detallado (RPC-10) ────────────────────────────

// ?modo=general|detallado&solo_con_tercero=true
router.get('/terceros', LEER, asyncHandler(async (req, res) => {
  res.json({ data: await informePorTercero(req.query) });
}));

router.get('/terceros/xlsx', LEER, asyncHandler(async (req, res) => {
  const r = await informePorTercero(req.query);
  const detallado = r.filtros.modo === 'detallado';
  const extra = await lineasDeFiltro(r.filtros);
  if (r.filtros.solo_con_tercero) extra.push('Solo movimientos con tercero');
  const { wb, ws } = await libroConEncabezado({
    titulo: `Movimiento por tercero (${detallado ? 'detallado' : 'general'})`, hoja: 'Terceros',
    desde: r.filtros.desde, hasta: r.filtros.hasta, extra,
  });
  hojaPorTercero(ws, r, detallado);
  await enviarLibro(res, wb, `terceros-${r.filtros.modo}_${r.filtros.desde}_${r.filtros.hasta}`);
}));

// ─── C4-01 · Libros auxiliares de impuestos, CxC y CxP (RPC-08, RPC-02) ──────

// ?libro=IVA|RETEFUENTE|RETEIVA|RETEICA|IMPUESTOS|CXC|CXP
router.get('/libros', LEER, asyncHandler(async (req, res) => {
  res.json({ data: await libroAuxiliar(req.query) });
}));

router.get('/libros/xlsx', LEER, asyncHandler(async (req, res) => {
  const l = await libroAuxiliar(req.query);
  const { wb, ws } = await libroConEncabezado({
    titulo: `Libro auxiliar · ${l.libro_nombre}`, hoja: l.libro_nombre.slice(0, 31),
    desde: l.filtros.desde, hasta: l.filtros.hasta, extra: await lineasDeFiltro(l.filtros),
  });
  if (l.agrupado_por === 'tercero') hojaPorTercero(ws, l, true);
  else hojaPorCuenta(ws, l, { conBase: true });
  await enviarLibro(res, wb, `libro-${l.libro.toLowerCase()}_${l.filtros.desde}_${l.filtros.hasta}`);
}));

// ─── C6-01 · Ventas por cliente (RPC-01) ─────────────────────────────────────

router.get('/ventas', LEER, asyncHandler(async (req, res) => {
  res.json({ data: await ventasPorCliente(req.query) });
}));

router.get('/ventas/xlsx', LEER, asyncHandler(async (req, res) => {
  const v = await ventasPorCliente(req.query);
  const { wb, ws } = await libroConEncabezado({
    titulo: 'Ventas por cliente', hoja: 'Ventas', desde: v.filtros.desde, hasta: v.filtros.hasta,
    extra: [...(await lineasDeFiltro(v.filtros)), 'Facturas y notas crédito ante la DIAN; las notas restan'],
  });
  titulosDeColumna(ws, ['Cliente', 'Documento', 'Factura / nota', 'Fecha', 'Facturas', 'Notas crédito', 'Subtotal', 'IVA', 'Retenciones', 'Total a pagar'],
    [42, 15, 18, 12, 10, 13, 17, 15, 15, 17]);
  for (const c of v.clientes) {
    subtotal(ws.addRow([c.nombre, c.documento ?? '', '', null, c.facturas, c.notas, c.subtotal, c.total_iva, c.total_retenciones, c.total_a_pagar]), [7, 8, 9, 10]);
    for (const d of c.documentos) {
      const fila = ws.addRow(['', '', `${d.tipo === 'NOTA_CREDITO' ? 'NC ' : ''}${d.numero ?? ''}${d.referencia ? ` (de ${d.referencia})` : ''}`, fechaExcel(d.fecha), null, null, d.subtotal, d.total_iva, d.total_retenciones, d.total_a_pagar]);
      fila.getCell(4).numFmt = 'dd/mm/yyyy';
      pesos(fila, [7, 8, 9, 10]);
    }
  }
  total(ws.addRow(['Total', '', '', null, v.totales.facturas, v.totales.notas, v.totales.subtotal, v.totales.total_iva, v.totales.total_retenciones, v.totales.total_a_pagar]), [7, 8, 9, 10]);
  await enviarLibro(res, wb, `ventas-por-cliente_${v.filtros.desde}_${v.filtros.hasta}`);
}));

// ─── C5-01 · Estados financieros (RPC-04, RPC-05) · formato provisional ─────

// ?corte=AAAA-MM-DD&comparativo=true
router.get('/estado-situacion', LEER, asyncHandler(async (req, res) => {
  res.json({ data: await estadoSituacionFinanciera(req.query) });
}));

router.get('/estado-situacion/xlsx', LEER, asyncHandler(async (req, res) => {
  const e = await estadoSituacionFinanciera(req.query);
  const { wb, ws } = await libroConEncabezado({
    titulo: 'Estado de situación financiera', hoja: 'Situación financiera', desde: e.corte, hasta: e.corte,
    extra: ['Formato provisional: los renglones son los grupos del PUC hasta que la contadora defina los suyos'],
    rangoTexto: `A ${e.corte}`,
  });
  const comp = !!e.corte_anterior;
  hojaEstado(ws, e.secciones, comp, comp ? [`Al ${e.corte}`, `Al ${e.corte_anterior}`] : [`Al ${e.corte}`], [
    ['Resultado del ejercicio', e.resultado_ejercicio, e.resultado_ejercicio_anterior],
    ['Total activo', e.total_activo, e.total_activo_anterior],
    ['Total pasivo + patrimonio + resultado', e.total_pasivo_patrimonio, e.total_pasivo_patrimonio_anterior],
  ]);
  await enviarLibro(res, wb, `estado-situacion-financiera_${e.corte}`);
}));

// ?desde=&hasta=&comparativo=true
router.get('/estado-resultados', LEER, asyncHandler(async (req, res) => {
  res.json({ data: await estadoResultados(req.query) });
}));

router.get('/estado-resultados/xlsx', LEER, asyncHandler(async (req, res) => {
  const e = await estadoResultados(req.query);
  const { wb, ws } = await libroConEncabezado({
    titulo: 'Estado de resultados', hoja: 'Resultados', desde: e.desde, hasta: e.hasta,
    extra: ['Formato provisional: los renglones son los grupos del PUC hasta que la contadora defina los suyos', 'Sin el comprobante de cierre de año'],
  });
  const comp = !!e.desde_anterior;
  // La utilidad bruta (ingresos − costos) va entre los costos y los gastos, no al final.
  hojaEstado(ws, e.secciones, comp, comp ? ['Periodo', 'Mismo periodo del año anterior'] : ['Periodo'], [
    ['Utilidad (pérdida) del periodo', e.utilidad, e.utilidad_anterior],
  ], { COSTOS: ['Utilidad bruta', e.utilidad_bruta, e.utilidad_bruta_anterior] });
  await enviarLibro(res, wb, `estado-resultados_${e.desde}_${e.hasta}`);
}));

/** Secciones con sus renglones y total; al final, las líneas de resultado. */
function hojaEstado(ws, secciones, comparativo, columnas, pie, trasSeccion = {}) {
  titulosDeColumna(ws, ['Concepto', ...columnas], [52, ...columnas.map(() => 22)]);
  const nums = comparativo ? [2, 3] : [2];
  for (const s of secciones) {
    ws.addRow([s.nombre]).font = { bold: true, color: { argb: 'FF000B50' } };
    for (const r of s.renglones) {
      pesos(ws.addRow([`    ${r.grupo ? `${r.grupo} · ` : ''}${r.nombre}`, r.valor, ...(comparativo ? [r.anterior] : [])]), nums);
    }
    subtotal(ws.addRow([`Total ${s.nombre.toLowerCase()}`, s.total, ...(comparativo ? [s.total_anterior] : [])]), nums);
    const extra = trasSeccion[s.clave];
    if (extra) total(ws.addRow([extra[0], extra[1], ...(comparativo ? [extra[2]] : [])]), nums);
  }
  ws.addRow([]);
  for (const [texto, v, ant] of pie) total(ws.addRow([texto, v, ...(comparativo ? [ant] : [])]), nums);
}

// ─── Escritores de hoja comunes ──────────────────────────────────────────────

/**
 * Auxiliar por cuenta: las nueve columnas de Siigo en su orden y después lo que
 * Siigo no trae. `conBase` añade la base gravable (libros de impuestos).
 */
function hojaPorCuenta(ws, a, { conBase = false } = {}) {
  const titulos = ['Código contable', 'Cuenta contable', 'Comprobante', 'Fecha', 'Cliente, Proveedor u Otros', 'Saldo inicial', 'Débito', 'Crédito', 'Saldo final', 'Documento cruce', 'Descripción'];
  const anchos = [14, 30, 13, 12, 40, 17, 17, 17, 17, 16, 40];
  if (conBase) { titulos.push('Base'); anchos.push(17); }
  titulosDeColumna(ws, titulos, anchos);
  for (const c of a.cuentas) {
    let saldoAnterior = c.saldo_inicial;
    for (const m of c.movimientos) {
      const fila = ws.addRow([
        c.codigo, c.nombre, m.comprobante, fechaExcel(m.fecha), m.tercero_nombre ?? '',
        saldoAnterior, m.debito, m.credito, m.saldo, m.documento_cruce ?? '', m.descripcion ?? '',
        ...(conBase ? [m.base ?? null] : []),
      ]);
      fila.getCell(4).numFmt = 'dd/mm/yyyy';
      pesos(fila, conBase ? [6, 7, 8, 9, 12] : [6, 7, 8, 9]);
      saldoAnterior = m.saldo;
    }
    // Total de la cuenta, como la fila sin comprobante con que Siigo cierra cada una.
    subtotal(ws.addRow([c.codigo, c.nombre, '', null, '', c.saldo_inicial, c.debito, c.credito, c.saldo_final]), [6, 7, 8, 9]);
  }
  total(ws.addRow(['', 'Total general', '', null, '', a.totales.saldo_inicial, a.totales.debito, a.totales.credito, a.totales.saldo_final]), [6, 7, 8, 9]);
}

/** Por tercero: en «general» una fila por tercero y cuenta; en «detallado», además, sus movimientos. */
function hojaPorTercero(ws, r, detallado) {
  if (!detallado) {
    titulosDeColumna(ws, ['Tercero', 'Documento', 'Código contable', 'Cuenta contable', 'Saldo inicial', 'Débito', 'Crédito', 'Saldo final'], [40, 15, 14, 34, 17, 17, 17, 17]);
    for (const t of r.terceros) {
      for (const c of t.cuentas) {
        pesos(ws.addRow([t.nombre, t.documento ?? '', c.codigo, c.nombre, c.saldo_inicial, c.debito, c.credito, c.saldo_final]), [5, 6, 7, 8]);
      }
      subtotal(ws.addRow([`Total ${t.nombre}`, t.documento ?? '', '', '', t.totales.saldo_inicial, t.totales.debito, t.totales.credito, t.totales.saldo_final]), [5, 6, 7, 8]);
    }
    total(ws.addRow(['Total general', '', '', '', r.totales.saldo_inicial, r.totales.debito, r.totales.credito, r.totales.saldo_final]), [5, 6, 7, 8]);
    return;
  }
  titulosDeColumna(ws, ['Tercero', 'Documento', 'Código contable', 'Cuenta contable', 'Comprobante', 'Fecha', 'Saldo inicial', 'Débito', 'Crédito', 'Saldo final', 'Documento cruce', 'Descripción'], [36, 15, 14, 30, 13, 12, 17, 17, 17, 17, 16, 40]);
  for (const t of r.terceros) {
    for (const c of t.cuentas) {
      let saldoAnterior = c.saldo_inicial;
      for (const m of c.movimientos) {
        const fila = ws.addRow([t.nombre, t.documento ?? '', c.codigo, c.nombre, m.comprobante, fechaExcel(m.fecha), saldoAnterior, m.debito, m.credito, m.saldo, m.documento_cruce ?? '', m.descripcion ?? '']);
        fila.getCell(6).numFmt = 'dd/mm/yyyy';
        pesos(fila, [7, 8, 9, 10]);
        saldoAnterior = m.saldo;
      }
      pesos(ws.addRow([t.nombre, t.documento ?? '', c.codigo, c.nombre, '', null, c.saldo_inicial, c.debito, c.credito, c.saldo_final]), [7, 8, 9, 10]).font = { italic: true };
    }
    subtotal(ws.addRow([`Total ${t.nombre}`, t.documento ?? '', '', '', '', null, t.totales.saldo_inicial, t.totales.debito, t.totales.credito, t.totales.saldo_final]), [7, 8, 9, 10]);
  }
  total(ws.addRow(['Total general', '', '', '', '', null, r.totales.saldo_inicial, r.totales.debito, r.totales.credito, r.totales.saldo_final]), [7, 8, 9, 10]);
}

function subtotal(fila, columnas) {
  pesos(fila, columnas);
  fila.font = { bold: true };
  fila.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2FB' } };
}

function total(fila, columnas) {
  pesos(fila, columnas);
  fila.font = { bold: true };
  fila.border = { top: { style: 'thin' } };
}

// "2026-09-30" → fecha de Excel sin corrimiento de zona (mediodía UTC).
const fechaExcel = (iso) => (iso ? new Date(`${iso}T12:00:00Z`) : null);

export default router;
