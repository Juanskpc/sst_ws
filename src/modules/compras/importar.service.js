import XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import { pool } from '../../config/db.js';
import { badRequest } from '../../utils/httpError.js';
import { crearCompra } from './compras.service.js';

/**
 * B5-01 · Carga masiva de compras y gastos por Excel.
 *
 * Una fila por ítem; las filas con el mismo NIT de proveedor y el mismo número de
 * factura forman una sola compra (varios ítems). Se procesa TODO O NADA: primero
 * se simula (cada compra dentro de un SAVEPOINT de una transacción que se deshace)
 * y se informa, fila por fila, qué entra y qué no; se importa solo si no hay
 * errores, para no dejar una carga a medias que luego hay que cuadrar a mano.
 *
 * Cada compra pasa por `crearCompra`, así que valida y contabiliza exactamente
 * igual que una registrada por la pantalla.
 */

const COLUMNAS = [
  { clave: 'tipo', titulo: 'Tipo', ancho: 22, ayuda: 'COMPRA, SERVICIO, SERVICIO_PROFESIONAL o GASTO_INTERNO' },
  { clave: 'nit', titulo: 'NIT o documento del proveedor', ancho: 22, ayuda: 'Sin dígito de verificación; el proveedor debe existir en Terceros' },
  { clave: 'factura', titulo: 'Factura del proveedor', ancho: 18, ayuda: 'Obligatoria salvo en un gasto interno' },
  { clave: 'fecha', titulo: 'Fecha', ancho: 12, ayuda: 'AAAA-MM-DD o DD/MM/AAAA' },
  { clave: 'forma', titulo: 'Forma de pago', ancho: 14, ayuda: 'CREDITO o CONTADO' },
  { clave: 'vence', titulo: 'Vence', ancho: 12, ayuda: 'Solo a crédito; vacío = la misma fecha' },
  { clave: 'cuenta_pago', titulo: 'Cuenta de pago', ancho: 14, ayuda: 'Solo de contado: código del banco o la caja (p. ej. 11050501)' },
  { clave: 'cuenta', titulo: 'Cuenta de gasto', ancho: 14, ayuda: 'Código de la cuenta auxiliar (p. ej. 51953501)' },
  { clave: 'descripcion', titulo: 'Detalle', ancho: 34, ayuda: 'Lo que se compró' },
  { clave: 'valor', titulo: 'Valor sin IVA', ancho: 14, ayuda: 'Número, sin puntos de miles' },
  { clave: 'iva', titulo: 'IVA %', ancho: 8, ayuda: '0, 5 o 19' },
  { clave: 'retencion', titulo: 'Retención (código)', ancho: 16, ayuda: 'Opcional: código de una retención de COMPRA' },
  { clave: 'centro', titulo: 'Centro de costo (código)', ancho: 18, ayuda: 'Opcional' },
];

const normalizar = (s) => String(s ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Plantilla con los encabezados, una fila de ayuda y un ejemplo (FC-1-10 de Siigo). */
export async function plantillaExcel() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Compras');
  ws.columns = COLUMNAS.map((c) => ({ header: c.titulo, key: c.clave, width: c.ancho }));
  ws.getRow(1).font = { bold: true };
  const ayuda = ws.addRow(Object.fromEntries(COLUMNAS.map((c) => [c.clave, c.ayuda])));
  ayuda.font = { italic: true, color: { argb: 'FF7F8C8D' } };
  ayuda.alignment = { wrapText: true, vertical: 'top' };
  ws.addRow({ tipo: 'COMPRA', nit: '900123456', factura: 'FE-4411', fecha: '2026-09-12', forma: 'CREDITO', vence: '2026-10-12',
    cuenta: '51953501', descripcion: 'Combustible', valor: 10024, iva: 0 });
  return wb.xlsx.writeBuffer();
}

/** Fecha de una celda (Date, número de serie de Excel, AAAA-MM-DD o DD/MM/AAAA) → AAAA-MM-DD. */
function fechaCelda(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  if (typeof v === 'number') {
    const d = XLSX.SSF.parse_date_code(v);
    return d ? `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}` : '';
  }
  const t = String(v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return t; // lo rechaza la validación de la compra con su mensaje
}

/** Número de una celda: acepta 1250000, "1250000.50" o "1.250.000,50". */
function numeroCelda(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number') return String(v);
  const t = String(v).trim().replace(/\s|\$/g, '');
  return t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
}

/** Lee el Excel y devuelve las filas con su número de fila de Excel. */
function leerFilas(buffer) {
  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  } catch {
    throw badRequest('No se pudo leer el archivo. Use la plantilla en Excel (.xlsx).');
  }
  const hoja = wb.Sheets[wb.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json(hoja, { header: 1, defval: null, raw: true });
  const encabezado = (filas[0] ?? []).map(normalizar);
  const indice = Object.fromEntries(COLUMNAS.map((c) => [c.clave, encabezado.indexOf(normalizar(c.titulo))]));
  const faltan = COLUMNAS.filter((c) => ['tipo', 'nit', 'fecha', 'cuenta', 'valor'].includes(c.clave) && indice[c.clave] < 0);
  if (faltan.length) throw badRequest(`Al Excel le faltan columnas de la plantilla: ${faltan.map((c) => c.titulo).join(', ')}.`);
  const salida = [];
  for (let i = 1; i < filas.length; i++) {
    const f = filas[i] ?? [];
    const v = (k) => (indice[k] >= 0 ? f[indice[k]] : null);
    const tipo = String(v('tipo') ?? '').trim().toUpperCase();
    // Se saltan las filas vacías y la de ayuda de la plantilla.
    if (!tipo && !v('nit') && !v('valor')) continue;
    if (/^COMPRA, SERVICIO/.test(tipo)) continue;
    salida.push({
      fila: i + 1, tipo,
      nitCrudo: String(v('nit') ?? '').trim(), factura: String(v('factura') ?? '').trim(),
      fecha: fechaCelda(v('fecha')), forma: String(v('forma') ?? 'CREDITO').trim().toUpperCase() || 'CREDITO', vence: fechaCelda(v('vence')),
      cuenta_pago: String(v('cuenta_pago') ?? '').trim(), cuenta: String(v('cuenta') ?? '').trim(),
      descripcion: String(v('descripcion') ?? '').trim(), valor: numeroCelda(v('valor')), iva: numeroCelda(v('iva')) || '0',
      retencion: String(v('retencion') ?? '').trim().toUpperCase(), centro: String(v('centro') ?? '').trim().toUpperCase(),
    });
  }
  if (!salida.length) throw badRequest('El Excel no trae ninguna compra.');
  return salida;
}

/**
 * Simula o importa. Devuelve el resumen por compra: sus filas, el proveedor, el
 * total y el error (si lo hay). `simular` = nunca guarda; si no, guarda solo si
 * ninguna compra falla.
 */
export async function importarCompras(buffer, { usuarioId = null, simular = true } = {}) {
  const filas = leerFilas(buffer);
  const client = await pool.connect();
  const resultados = [];
  try {
    await client.query('BEGIN');
    // Catálogos, una sola vez.
    const terceros = (await client.query(
      `SELECT id, numero_documento, COALESCE(razon_social, btrim(concat_ws(' ', nombres, apellidos))) AS nombre FROM sst.terceros WHERE activo`,
    )).rows;
    const porDocumento = new Map(terceros.map((t) => [t.numero_documento.replace(/[^0-9A-Za-z]/g, ''), t]));
    const cuentas = new Map((await client.query(`SELECT id, codigo FROM sst.cuentas_contables`)).rows.map((c) => [c.codigo, c.id]));
    const retenciones = new Map((await client.query(`SELECT id, codigo FROM sst.retenciones WHERE aplica_a = 'COMPRA' AND activa`)).rows.map((r) => [r.codigo.toUpperCase(), r.id]));
    const centros = new Map((await client.query(`SELECT id, upper(codigo) AS codigo FROM sst.centros_costo WHERE activo`)).rows.map((c) => [c.codigo, c.id]));

    // Filas → compras: mismo proveedor + misma factura (o, sin factura, la misma fila).
    const grupos = new Map();
    for (const f of filas) {
      // El documento sin el DV: "900.123.456-7" → "900123456".
      const doc = f.nitCrudo.replace(/-\s*\d\s*$/, '').replace(/[^0-9A-Za-z]/g, '');
      const clave = f.factura ? `${doc}|${f.factura.toUpperCase()}` : `fila|${f.fila}`;
      if (!grupos.has(clave)) grupos.set(clave, { doc, filas: [] });
      grupos.get(clave).filas.push(f);
    }

    let n = 0;
    for (const { doc, filas: fs } of grupos.values()) {
      const cab = fs[0];
      const r = { filas: fs.map((f) => f.fila), proveedor: null, factura: cab.factura || null, items: fs.length, total: null, error: null };
      const sp = `imp_${++n}`;
      await client.query(`SAVEPOINT ${sp}`);
      try {
        const tercero = porDocumento.get(doc);
        if (!tercero) throw badRequest(`el proveedor ${cab.nitCrudo || '(sin documento)'} no existe en Terceros`);
        r.proveedor = tercero.nombre;
        const distinta = fs.find((f) => f.tipo !== cab.tipo || f.fecha !== cab.fecha || f.forma !== cab.forma);
        if (distinta) throw badRequest(`la fila ${distinta.fila} tiene otro tipo, fecha o forma de pago que la fila ${cab.fila} de la misma factura`);
        const cuentaPago = cab.forma === 'CONTADO' ? cuentas.get(cab.cuenta_pago) : null;
        if (cab.forma === 'CONTADO' && !cuentaPago) throw badRequest(`la cuenta de pago ${cab.cuenta_pago || '(vacía)'} no existe`);
        const items = fs.map((f) => {
          const cuentaId = cuentas.get(f.cuenta);
          if (!cuentaId) throw badRequest(`fila ${f.fila}: la cuenta ${f.cuenta || '(vacía)'} no existe en el plan de cuentas`);
          return { cuenta_id: cuentaId, descripcion: f.descripcion, valor: f.valor, iva_pct: f.iva };
        });
        const rets = [...new Set(fs.map((f) => f.retencion).filter(Boolean))].map((codigo) => {
          const id = retenciones.get(codigo);
          if (!id) throw badRequest(`la retención ${codigo} no existe o no es de compra`);
          return { retencion_id: id };
        });
        const centro = cab.centro ? centros.get(cab.centro) : null;
        if (cab.centro && !centro) throw badRequest(`el centro de costo ${cab.centro} no existe o está inactivo`);
        const compra = await crearCompra({
          tipo: cab.tipo, tercero_id: tercero.id, numero_proveedor: cab.factura, fecha: cab.fecha, forma_pago: cab.forma,
          vencimiento: cab.forma === 'CREDITO' ? (cab.vence || cab.fecha) : null, cuenta_pago_id: cuentaPago,
          centro_costo_id: centro, items, retenciones: rets,
        }, usuarioId, { client });
        r.total = compra.total_a_pagar;
        r.comprobante = simular ? null : compra.comprobante_numero;
        await client.query(`RELEASE SAVEPOINT ${sp}`);
      } catch (e) {
        await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        r.error = e.message;
      }
      resultados.push(r);
    }
    const errores = resultados.filter((r) => r.error).length;
    // Todo o nada: con un solo error no se guarda ninguna.
    await client.query(!simular && !errores ? 'COMMIT' : 'ROLLBACK');
    const totalCentavos = resultados.filter((r) => !r.error).reduce((s, r) => s + Math.round(Number(r.total) * 100), 0);
    return {
      simulado: simular || errores > 0,
      importadas: !simular && !errores ? resultados.length : 0,
      compras: resultados.length, filas: filas.length, errores,
      total: (totalCentavos / 100).toFixed(2),
      resultados,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
