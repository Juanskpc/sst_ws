import { Router } from 'express';
import ExcelJS from 'exceljs';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { badRequest } from '../../utils/httpError.js';
import { authRequired, requireRole } from '../../middleware/auth.js';
import { esBolivar, relacionPorFacturar, resolverSeleccion } from './relacion.service.js';
import { actualizarBorrador, crearBorrador, eliminarBorrador, listarBorradores, obtenerBorrador } from './borrador.service.js';
import { corregirDocumento, emitirDocumento, numeroCompleto, reconciliarDocumento } from './emision.service.js';
import { reenviarAlCliente } from './envio.service.js';
import { storage } from '../../services/storage.service.js';
import { actualizarEventosEnLote, consultarEventosDocumento, marcarAceptacionTacita } from './eventos.service.js';
import { CAUSALES_NOTA_CREDITO, crearNotaCredito, emitirNotaCredito, reconciliarNotaCredito } from './notas.service.js';
import { pool } from '../../config/db.js';

const router = Router();
router.use(authRequired);

/**
 * A1-03 · Relación a facturar (FEL-01, FEL-02).
 *
 * Lectura: admin, contador y auditor. Escribir (crear el borrador, A1-04) queda
 * para admin y contador; la vista `facturacion` de la matriz de permisos llega
 * con la pantalla (A1-08).
 */
const LEER = requireRole('admin', 'contador', 'auditor');
const OPERAR = requireRole('admin', 'contador');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOpcional = (v, nombre) => {
  if (v == null || v === '') return null;
  if (!UUID.test(String(v))) throw badRequest(`"${nombre}" no es un identificador válido.`);
  return String(v);
};

// Lo que se puede facturar hoy, por pagador. ?arl_id= (o ?pagador_tercero_id=,
// un cliente particular de A3-01) lo acota a uno.
router.get('/por-facturar', LEER, asyncHandler(async (req, res) => {
  res.json({
    data: await relacionPorFacturar({
      arlId: uuidOpcional(req.query.arl_id, 'arl_id'),
      pagadorTerceroId: uuidOpcional(req.query.pagador_tercero_id, 'pagador_tercero_id'),
    }),
  });
}));

// Comprueba una selección antes de crear la factura: mismo pagador, todo libre.
// Cuerpo: { arl_id, orden_ids? } o, en Bolívar, { arl_id, prefactura_id, fila_ids? }.
router.post('/seleccion/validar', OPERAR, asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (b.orden_ids != null && !Array.isArray(b.orden_ids)) throw badRequest('"orden_ids" debe ser una lista.');
  if (b.fila_ids != null && !Array.isArray(b.fila_ids)) throw badRequest('"fila_ids" debe ser una lista.');
  const r = await resolverSeleccion({
    arlId: uuidOpcional(b.arl_id, 'arl_id'),
    pagadorTerceroId: uuidOpcional(b.pagador_tercero_id, 'pagador_tercero_id'),
    ordenIds: (b.orden_ids ?? []).map((id) => uuidOpcional(id, 'orden_ids')),
    prefacturaId: uuidOpcional(b.prefactura_id, 'prefactura_id'),
    filaIds: b.fila_ids ? b.fila_ids.map((id) => uuidOpcional(id, 'fila_ids')) : null,
  });
  res.json({ data: r });
}));

/**
 * Excel de la relación para radicar, de CUALQUIER pagador (el de T0-08 era solo
 * de Bolívar). Mismas diez columnas que la relación que JD&D arma a mano. Trae
 * las líneas facturables: en Bolívar, las de la prefactura pedida; en los demás,
 * las de `?orden_ids=` (separadas por coma) o, si no se manda, todas las libres.
 */
router.get('/relacion.xlsx', LEER, asyncHandler(async (req, res) => {
  const arlId = uuidOpcional(req.query.arl_id, 'arl_id');
  const pagadorTerceroId = uuidOpcional(req.query.pagador_tercero_id, 'pagador_tercero_id');
  if (!arlId && !pagadorTerceroId) throw badRequest('Indique el pagador (arl_id, o pagador_tercero_id si es un cliente particular).');
  const prefacturaId = uuidOpcional(req.query.prefactura_id, 'prefactura_id');
  const ids = req.query.orden_ids ? String(req.query.orden_ids).split(',').map((s) => uuidOpcional(s.trim(), 'orden_ids')) : null;

  const { pagadores } = await relacionPorFacturar({ arlId, pagadorTerceroId: arlId ? null : pagadorTerceroId });
  const pagador = pagadores[0];
  if (!pagador) throw badRequest('Ese pagador no existe o no tiene nada por facturar.');
  const bolivar = esBolivar(pagador.arl_nombre);
  if (bolivar && !prefacturaId) throw badRequest('Bolívar se factura por prefactura: indique cuál (prefactura_id).');

  let grupos = pagador.grupos;
  if (bolivar) grupos = grupos.filter((g) => g.prefactura?.id === prefacturaId);
  const lineas = grupos.flatMap((g) => g.lineas)
    .filter((l) => l.facturable && (ids ? ids.includes(l.orden_id) : true));
  if (!lineas.length) throw badRequest('No hay líneas facturables para esa relación.');

  const wb = new ExcelJS.Workbook();
  wb.creator = 'JD&D IA-Core';
  wb.created = new Date();
  // Un cliente particular (A3-01) no tiene ARL: la hoja lleva su nombre, sin los
  // caracteres que Excel no admite en el nombre de una hoja.
  const nombreHoja = `Relación ${pagador.arl_nombre ?? pagador.tercero_nombre ?? ''}`.replace(/[\\/?*[\]:]/g, ' ');
  const ws = wb.addWorksheet(nombreHoja.slice(0, 31));

  ws.addRow([
    'Tipo de actividad', 'Cantidad de horas', 'Valor unitario por hora', 'Valor transporte', 'Total',
    bolivar ? 'SIPAB No. De Cronograma' : 'Número de orden', bolivar ? 'secuencia' : '', 'Empresa',
    'Actividad a realizar', bolivar ? 'Prefactura' : 'Estado de facturación',
  ]);
  const cabecera = ws.getRow(1);
  cabecera.font = { bold: true, size: 11 };
  cabecera.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFBFBFBF' } };
  cabecera.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };

  // Sin cifra (ni tarifa ni valor de la ARL) la celda queda vacía y resaltada:
  // se completa a mano antes de radicar, nunca se inventa un valor.
  const SIN_VALOR = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
  let totalGeneral = 0;
  for (const l of lineas) {
    const tieneValor = l.valor_referencia != null;
    if (tieneValor) totalGeneral += l.valor_referencia;
    const row = ws.addRow([
      (l.tipo_actividad ?? '').toLowerCase(), l.horas ?? '', l.valor_unitario ?? '', l.transporte || 0,
      l.valor_referencia ?? '',
      bolivar ? l.codigo_cronograma ?? '' : l.numero_orden ?? l.codigo ?? '',
      bolivar ? l.secuencia ?? '' : '', l.empresa_nombre ?? '',
      l.tema_actividad || l.tipo_actividad || '',
      bolivar ? grupos[0].prefactura.numero : '',
    ]);
    if (!tieneValor) row.getCell(5).fill = SIN_VALOR;
  }
  const filaTotal = ws.addRow(['', '', '', '', totalGeneral, '', '', '', '', '']);
  filaTotal.getCell(5).font = { bold: true };

  [20, 16, 20, 16, 14, 20, 12, 32, 40, 18].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const buffer = await wb.xlsx.writeBuffer();
  const sufijo = bolivar ? `prefactura-${grupos[0].prefactura.numero}` : new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="relacion-${sufijo}.xlsx"`);
  res.send(Buffer.from(buffer));
}));

// ─── A1-04 · Borradores de factura ──────────────────────────────────────────

// Listado de borradores (o, con ?estado=, de cualquier otro estado de la factura).
router.get('/borradores', LEER, asyncHandler(async (req, res) => {
  const estado = req.query.estado ? String(req.query.estado).toUpperCase() : 'BORRADOR';
  res.json({
    data: await listarBorradores({
      estado,
      arlId: uuidOpcional(req.query.arl_id, 'arl_id'),
      pagadorTerceroId: uuidOpcional(req.query.pagador_tercero_id, 'pagador_tercero_id'),
    }),
  });
}));

// Crea el borrador desde una selección de A1-03 (misma forma que /seleccion/validar).
router.post('/borradores', OPERAR, asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (b.orden_ids != null && !Array.isArray(b.orden_ids)) throw badRequest('"orden_ids" debe ser una lista.');
  if (b.fila_ids != null && !Array.isArray(b.fila_ids)) throw badRequest('"fila_ids" debe ser una lista.');
  const data = await crearBorrador({
    arlId: uuidOpcional(b.arl_id, 'arl_id'),
    pagadorTerceroId: uuidOpcional(b.pagador_tercero_id, 'pagador_tercero_id'),
    ordenIds: (b.orden_ids ?? []).map((id) => uuidOpcional(id, 'orden_ids')),
    prefacturaId: uuidOpcional(b.prefactura_id, 'prefactura_id'),
    filaIds: b.fila_ids ? b.fila_ids.map((id) => uuidOpcional(id, 'fila_ids')) : null,
    observaciones: b.observaciones ?? null,
    usuarioId: req.user.sub,
  });
  res.status(201).json({ message: 'Borrador de factura creado.', data });
}));

router.get('/borradores/:id', LEER, asyncHandler(async (req, res) => {
  res.json({ data: await obtenerBorrador(uuidOpcional(req.params.id, 'id')) });
}));

// Reemplaza líneas, descuento/retenciones, fechas y observaciones. Solo en BORRADOR.
router.put('/borradores/:id', OPERAR, asyncHandler(async (req, res) => {
  const data = await actualizarBorrador(uuidOpcional(req.params.id, 'id'), req.body || {}, req.user.sub);
  res.json({ message: 'Borrador actualizado.', data });
}));

router.delete('/borradores/:id', OPERAR, asyncHandler(async (req, res) => {
  await eliminarBorrador(uuidOpcional(req.params.id, 'id'));
  res.json({ message: 'Borrador eliminado.' });
}));

// ─── A1-05 · Emitir y reconciliar ───────────────────────────────────────────

/**
 * Emite el documento contra Factus. Responde 200 cuando quedó VALIDADO o
 * RECHAZADO (el `data.estado` dice cuál) y 202 cuando Factus no decidió
 * todavía o no se pudo contactar: el documento queda ENVIANDO y hay que
 * reintentar con "Consultar estado" más tarde, nunca volviendo a emitir.
 */
/** A2-01 · factura o nota crédito: los mismos botones sirven para los dos tipos. */
async function tipoDeDocumento(id) {
  const r = await pool.query(`SELECT tipo FROM sst.documentos_electronicos WHERE id = $1`, [id]);
  return r.rows[0]?.tipo ?? 'FACTURA';
}

router.post('/documentos/:id/emitir', OPERAR, asyncHandler(async (req, res) => {
  const id = uuidOpcional(req.params.id, 'id');
  const esNota = (await tipoDeDocumento(id)) === 'NOTA_CREDITO';
  const resultado = esNota ? await emitirNotaCredito(id, req.user.sub) : await emitirDocumento(id, req.user.sub);
  if (resultado?.pendiente) {
    return res.status(202).json({ message: resultado.aviso || 'La DIAN no ha decidido todavía; consulte el estado en unos minutos.', data: resultado });
  }
  const mensaje = resultado.estado === 'RECHAZADO'
    ? 'La DIAN rechazó el documento. Corrija el borrador y vuelva a emitir.'
    : `${esNota ? 'Nota crédito validada' : 'Factura validada'}: ${numeroCompleto(resultado.prefijo, resultado.numero) ?? ''} (${esNota ? 'CUDE' : 'CUFE'} ${resultado.cufe ?? '—'}).`;
  res.json({ message: mensaje, data: resultado });
}));

// Reconcilia un documento que quedó ENVIANDO (timeout, corte de red, o Factus tardó en decidir).
router.post('/documentos/:id/consultar-estado', OPERAR, asyncHandler(async (req, res) => {
  const id = uuidOpcional(req.params.id, 'id');
  const resultado = (await tipoDeDocumento(id)) === 'NOTA_CREDITO'
    ? await reconciliarNotaCredito(id, req.user.sub)
    : await reconciliarDocumento(id, req.user.sub);
  if (resultado?.pendiente) {
    return res.status(202).json({ message: 'Sigue en proceso; inténtelo de nuevo en unos minutos.', data: resultado });
  }
  res.json({ message: resultado.estado === 'RECHAZADO' ? 'La DIAN rechazó el documento.' : 'Factura validada.', data: resultado });
}));

// ─── A2-01 · Nota crédito ────────────────────────────────────────────────────

// Causales DIAN (para el selector de la pantalla).
router.get('/notas/causales', LEER, (_req, res) => {
  res.json({ data: Object.entries(CAUSALES_NOTA_CREDITO).map(([codigo, nombre]) => ({ codigo, nombre })) });
});

// Notas crédito por estado (varios separados por coma).
router.get('/notas', LEER, asyncHandler(async (req, res) => {
  const estado = req.query.estado ? String(req.query.estado) : 'BORRADOR,ENVIANDO,VALIDADO,RECHAZADO';
  res.json({ data: await listarBorradores({ estado, tipo: 'NOTA_CREDITO' }) });
}));

/**
 * Crea la nota crédito (en BORRADOR) sobre una factura VALIDADA. Cuerpo:
 * { causal: '1'..'6', lineas?: [{ item_id, cantidad }], observaciones? }.
 * Sin `lineas`, o con causal 2 (anulación), acredita la factura completa.
 */
router.post('/documentos/:id/nota-credito', OPERAR, asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (b.lineas != null && !Array.isArray(b.lineas)) throw badRequest('"lineas" debe ser una lista.');
  const lineas = (b.lineas ?? []).map((l) => ({ item_id: uuidOpcional(l?.item_id, 'item_id'), cantidad: Number(l?.cantidad) }));
  const data = await crearNotaCredito(uuidOpcional(req.params.id, 'id'), {
    causal: b.causal, lineas, observaciones: b.observaciones ?? null,
  }, req.user.sub);
  res.status(201).json({ message: 'Nota crédito creada en borrador.', data });
}));

// ─── A1-08 · Descarga del PDF y del XML ─────────────────────────────────────

/**
 * El PDF (representación gráfica) o el XML (el documento que valida la DIAN) de
 * una factura ya emitida, tal como los devolvió Factus al validarla (A1-05 los
 * guarda en el almacenamiento). Pasa por la API y no por un enlace directo al
 * archivo porque exige sesión: es un documento con datos tributarios.
 */
router.get('/documentos/:id/archivo/:tipo', LEER, asyncHandler(async (req, res) => {
  const tipo = String(req.params.tipo).toLowerCase();
  if (!['pdf', 'xml'].includes(tipo)) throw badRequest('El archivo es "pdf" o "xml".');
  const doc = await obtenerBorrador(uuidOpcional(req.params.id, 'id'));
  const ruta = tipo === 'pdf' ? doc.pdf_path : doc.xml_path;
  if (!ruta) throw badRequest(`Esta factura todavía no tiene ${tipo.toUpperCase()}: solo lo tienen las validadas por la DIAN.`);
  const nombre = `${numeroCompleto(doc.prefijo, doc.numero) ?? doc.reference_code}.${tipo}`;
  res.setHeader('Content-Type', tipo === 'pdf' ? 'application/pdf' : 'application/xml');
  res.setHeader('Content-Disposition', `inline; filename="${nombre}"`);
  res.send(await storage.get(ruta));
}));

// ─── A1-06 · Envío al cliente ────────────────────────────────────────────────

/**
 * "Reenviar al cliente": con el correo propio de Orbita (no el de Factus),
 * PDF + XML adjuntos. `correo` en el cuerpo es opcional — sin él, usa el de
 * facturación del tercero.
 */
router.post('/documentos/:id/reenviar', OPERAR, asyncHandler(async (req, res) => {
  const correo = req.body?.correo ? String(req.body.correo).trim() : undefined;
  const data = await reenviarAlCliente(uuidOpcional(req.params.id, 'id'), req.user.sub, { correo });
  res.json({ message: `Factura reenviada a ${correo || 'el correo de facturación del tercero'}.`, data });
}));

// ─── A1-07 · Rechazos, reenvíos y eventos DIAN ──────────────────────────────

// RECHAZADO → BORRADOR con un reference_code nuevo, para corregir y reemitir.
router.post('/documentos/:id/corregir', OPERAR, asyncHandler(async (req, res) => {
  const data = await corregirDocumento(uuidOpcional(req.params.id, 'id'), req.user.sub);
  res.json({ message: 'El documento vuelve a BORRADOR para corregirse.', data });
}));

// "Consultar eventos" de UN documento (botón en su detalle).
router.post('/documentos/:id/eventos/consultar', OPERAR, asyncHandler(async (req, res) => {
  const r = await consultarEventosDocumento(uuidOpcional(req.params.id, 'id'), req.user.sub);
  res.json({
    message: r.nuevos ? `${r.nuevos} evento(s) nuevo(s) de la DIAN.` : 'Sin eventos nuevos.',
    data: r,
  });
}));

// En lote: "Actualizar eventos de las facturas de los últimos N días" (60 por defecto).
router.post('/eventos/actualizar-lote', OPERAR, asyncHandler(async (req, res) => {
  const dias = req.body?.dias != null ? Number(req.body.dias) : undefined;
  const r = await actualizarEventosEnLote({ dias }, req.user.sub);
  res.json({
    message: `${r.revisadas} factura(s) revisada(s), ${r.nuevos} evento(s) nuevo(s)${r.fallidas.length ? `, ${r.fallidas.length} con error` : ''}.`,
    data: r,
  });
}));

// Apunte interno (nunca llama a Factus: ver eventos.service.js) de aceptación tácita.
router.post('/documentos/:id/aceptacion-tacita', OPERAR, asyncHandler(async (req, res) => {
  const r = await marcarAceptacionTacita(uuidOpcional(req.params.id, 'id'), req.user.sub);
  res.json({ message: 'Factura marcada como aceptada tácitamente (apunte interno de Orbita).', data: r });
}));

export default router;
