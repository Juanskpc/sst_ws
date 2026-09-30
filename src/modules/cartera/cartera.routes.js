import { Router } from 'express';
import ExcelJS from 'exceljs';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authRequired, requireRole } from '../../middleware/auth.js';
import { hoyCO } from '../../utils/formato.js';
import {
  anularRecibo, antiguedad, conciliacion, crearReciboCaja, EDADES, estadoCuenta, listarCartera, listarRecibos,
  obtenerRecibo, propuestaRecibo, sincronizarCartera,
} from './cartera.service.js';
import {
  anularAnticipo, anularEgreso, crearAnticipo, crearEgreso, listarAnticipos, listarEgresos, obtenerEgreso, propuestaEgreso,
} from './pagos.service.js';

const router = Router();
router.use(authRequired);

/** B3-01 · Cartera (CXC-01..04, CNT-05). Admin y contador operan; el auditor consulta. */
const LEER = requireRole('admin', 'contador', 'auditor');
const OPERAR = requireRole('admin', 'contador');

/** ?tipo=CXP da lo mismo para las cuentas por pagar (B4-01); por defecto, por cobrar. */
const tipoDe = (req) => (String(req.query.tipo ?? '').toUpperCase() === 'CXP' ? 'CXP' : 'CXC');

const ETIQUETA_EDAD = {
  POR_VENCER: 'Por vencer', D1_30: '1 a 30 días', D31_60: '31 a 60 días', D61_90: '61 a 90 días', MAS_90: 'Más de 90 días',
};

/** Hoja con formato de pesos en las columnas indicadas. */
async function enviarExcel(res, nombre, titulo, columnas, filas, columnasPesos) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(titulo.slice(0, 31));
  ws.columns = columnas.map((c) => ({ header: c.titulo, key: c.clave, width: c.ancho ?? 16 }));
  ws.getRow(1).font = { bold: true };
  for (const f of filas) ws.addRow(f);
  for (const k of columnasPesos) ws.getColumn(k).numFmt = '#,##0.00';
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
  await wb.xlsx.write(res);
  res.end();
}

// Documentos por cobrar (?tercero_id=, ?todos=true incluye los ya pagados, ?corte=AAAA-MM-DD).
router.get('/documentos', LEER, asyncHandler(async (req, res) => {
  const data = await listarCartera({ terceroId: req.query.tercero_id || null, soloAbiertos: req.query.todos !== 'true', corte: req.query.corte || null, tipo: tipoDe(req) });
  res.json({ data, total: data.length });
}));

// CXC-03 · Antigüedad por edades, a una fecha de corte.
router.get('/antiguedad', LEER, asyncHandler(async (req, res) => {
  res.json({ data: { ...(await antiguedad(req.query.corte || null, undefined, tipoDe(req))), edades: EDADES } });
}));

router.get('/antiguedad.xlsx', LEER, asyncHandler(async (req, res) => {
  const tipo = tipoDe(req);
  const a = await antiguedad(req.query.corte || null, undefined, tipo);
  const columnas = [{ titulo: tipo === 'CXP' ? 'Proveedor' : 'Cliente', clave: 'tercero_nombre', ancho: 44 }, { titulo: 'Facturas', clave: 'documentos', ancho: 10 },
    ...EDADES.map((e) => ({ titulo: ETIQUETA_EDAD[e], clave: e })), { titulo: 'Total', clave: 'TOTAL' }];
  const num = (o) => ({ ...o, ...Object.fromEntries([...EDADES, 'TOTAL'].map((e) => [e, Number(o[e])])) });
  await enviarExcel(res, `antiguedad-${tipo === 'CXP' ? 'por-pagar' : 'cartera'}-${a.corte}.xlsx`, tipo === 'CXP' ? 'Cuentas por pagar' : 'Antigüedad de cartera', columnas,
    [...a.clientes.map(num), num({ tercero_nombre: 'TOTAL', documentos: '', ...a.total })], [...EDADES, 'TOTAL']);
}));

// CXC-04 · Estado de cuenta de un cliente. El Excel va ANTES: si no, «/:terceroId»
// capturaría «<id>.xlsx» como si fuera el id.
router.get('/estado-cuenta/:terceroId.xlsx', LEER, asyncHandler(async (req, res) => {
  const tipo = tipoDe(req);
  const e = await estadoCuenta(req.params.terceroId, undefined, tipo);
  const filas = [];
  for (const d of e.documentos) {
    filas.push({ fecha: d.fecha, concepto: `${tipo === 'CXP' ? 'Obligación' : 'Factura'} ${d.numero}`, vence: d.vencimiento, cargo: Number(d.valor), abono: null, saldo: Number(d.saldo) });
    for (const m of d.movimientos) {
      const origen = { NOTA_CREDITO: 'Nota crédito', RECIBO_CAJA: 'Recibo de caja', EGRESO: 'Egreso' }[m.origen_tipo] ?? m.origen_tipo;
      filas.push({ fecha: m.fecha, concepto: `   ${origen} ${m.soporte ?? ''}${Number(m.valor_retenciones) ? ` (retenido ${m.valor_retenciones})` : ''}${Number(m.valor_anticipo) ? ` (anticipo ${m.valor_anticipo})` : ''}`,
        vence: null, cargo: null, abono: Number(m.valor_pagado) + Number(m.valor_retenciones) + Number(m.valor_anticipo ?? 0), saldo: null });
    }
  }
  filas.push({ fecha: hoyCO(), concepto: 'SALDO', vence: null, cargo: null, abono: null, saldo: Number(e.saldo) });
  await enviarExcel(res, `estado-cuenta-${e.tercero.numero_documento}.xlsx`, 'Estado de cuenta', [
    { titulo: 'Fecha', clave: 'fecha', ancho: 12 }, { titulo: 'Concepto', clave: 'concepto', ancho: 48 },
    { titulo: 'Vence', clave: 'vence', ancho: 12 }, { titulo: 'Cargo', clave: 'cargo' }, { titulo: 'Abono', clave: 'abono' },
    { titulo: 'Saldo', clave: 'saldo' },
  ], filas, ['cargo', 'abono', 'saldo']);
}));

router.get('/estado-cuenta/:terceroId', LEER, asyncHandler(async (req, res) => {
  res.json({ data: await estadoCuenta(req.params.terceroId, undefined, tipoDe(req)) });
}));

// Cartera contra libro (§5.1): deben cuadrar.
router.get('/conciliacion', LEER, asyncHandler(async (req, res) => {
  res.json({ data: await conciliacion(undefined, tipoDe(req)) });
}));

// Facturas abiertas del cliente con la ReteICA sugerida, para armar un recibo.
router.get('/propuesta/:terceroId', LEER, asyncHandler(async (req, res) => {
  res.json({ data: await propuestaRecibo(req.params.terceroId) });
}));

router.get('/recibos', LEER, asyncHandler(async (req, res) => {
  const data = await listarRecibos({ terceroId: req.query.tercero_id || null, desde: req.query.desde || null, hasta: req.query.hasta || null });
  res.json({ data, total: data.length });
}));

router.get('/recibos/:id', LEER, asyncHandler(async (req, res) => {
  res.json({ data: await obtenerRecibo(req.params.id) });
}));

router.post('/recibos', OPERAR, asyncHandler(async (req, res) => {
  res.status(201).json({ data: await crearReciboCaja(req.body, req.user.sub) });
}));

router.post('/recibos/:id/anular', OPERAR, asyncHandler(async (req, res) => {
  res.json({ data: await anularRecibo(req.params.id, req.body?.motivo, req.user.sub) });
}));

// Backfill: abre la cartera de lo contabilizado antes de B3-01.
router.post('/sincronizar', OPERAR, asyncHandler(async (_req, res) => {
  res.json({ data: await sincronizarCartera() });
}));

// ─── B4-01 · Anticipos a proveedores y egresos ───────────────────────────────

router.get('/anticipos', LEER, asyncHandler(async (req, res) => {
  const data = await listarAnticipos({ terceroId: req.query.tercero_id || null, conSaldo: req.query.con_saldo === 'true' });
  res.json({ data, total: data.length });
}));

router.post('/anticipos', OPERAR, asyncHandler(async (req, res) => {
  res.status(201).json({ data: await crearAnticipo(req.body, req.user.sub) });
}));

router.post('/anticipos/:id/anular', OPERAR, asyncHandler(async (req, res) => {
  res.json({ data: await anularAnticipo(req.params.id, req.body?.motivo, req.user.sub) });
}));

// Obligaciones abiertas del proveedor y anticipo disponible, para armar un egreso.
router.get('/propuesta-egreso/:terceroId', LEER, asyncHandler(async (req, res) => {
  res.json({ data: await propuestaEgreso(req.params.terceroId) });
}));

router.get('/egresos', LEER, asyncHandler(async (req, res) => {
  const data = await listarEgresos({ terceroId: req.query.tercero_id || null });
  res.json({ data, total: data.length });
}));

router.get('/egresos/:id', LEER, asyncHandler(async (req, res) => {
  res.json({ data: await obtenerEgreso(req.params.id) });
}));

router.post('/egresos', OPERAR, asyncHandler(async (req, res) => {
  res.status(201).json({ data: await crearEgreso(req.body, req.user.sub) });
}));

router.post('/egresos/:id/anular', OPERAR, asyncHandler(async (req, res) => {
  res.json({ data: await anularEgreso(req.params.id, req.body?.motivo, req.user.sub) });
}));

export default router;
