import XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import { pool } from '../../config/db.js';
import { badRequest } from '../../utils/httpError.js';
import { crearSoporteManual } from './soporte.service.js';

/**
 * A4-02 · Carga masiva de documentos soporte por Excel (pedido en la reunión).
 *
 * Una fila por línea; las filas con el mismo documento del proveedor y la misma
 * referencia forman un solo documento soporte. Mismo criterio que la carga de
 * compras: primero se revisa (cada documento en un SAVEPOINT de una transacción
 * que se deshace) y se guarda solo si TODAS las filas están bien. Crea BORRADORES:
 * nada sale a la DIAN sin que alguien lo revise y lo emita.
 */

const COLUMNAS = [
  { clave: 'nit', titulo: 'Documento del proveedor', ancho: 22, ayuda: 'Cédula o NIT sin dígito de verificación; debe existir en Terceros' },
  { clave: 'referencia', titulo: 'Referencia', ancho: 16, ayuda: 'Opcional: agrupa varias filas del mismo proveedor en un solo documento' },
  { clave: 'descripcion', titulo: 'Detalle', ancho: 40, ayuda: 'Lo que se compró o el servicio recibido' },
  { clave: 'cantidad', titulo: 'Cantidad', ancho: 10, ayuda: 'Vacío = 1' },
  { clave: 'valor', titulo: 'Valor unitario', ancho: 14, ayuda: 'Número, sin puntos de miles' },
  { clave: 'cuenta', titulo: 'Cuenta de costo o gasto', ancho: 16, ayuda: 'Código de la cuenta auxiliar (p. ej. 51101001)' },
  { clave: 'observacion', titulo: 'Observación', ancho: 30, ayuda: 'Opcional; va en el documento' },
];

const normalizar = (s) => String(s ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Plantilla con encabezados, una fila de ayuda y un ejemplo (el DS de la contadora, §3.5 del plan). */
export async function plantillaSoportes() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Documentos soporte');
  ws.columns = COLUMNAS.map((c) => ({ header: c.titulo, key: c.clave, width: c.ancho }));
  ws.getRow(1).font = { bold: true };
  const ayuda = ws.addRow(Object.fromEntries(COLUMNAS.map((c) => [c.clave, c.ayuda])));
  ayuda.font = { italic: true, color: { argb: 'FF7F8C8D' } };
  ayuda.alignment = { wrapText: true, vertical: 'top' };
  ws.addRow({ nit: '1085000000', referencia: 'SEP-2026', descripcion: 'Honorarios contabilidad septiembre', cantidad: 1, valor: 1500000, cuenta: '51101001' });
  return wb.xlsx.writeBuffer();
}

/** Número de una celda: acepta 1250000, "1250000.50" o "1.250.000,50". */
function numeroCelda(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number') return String(v);
  const t = String(v).trim().replace(/\s|\$/g, '');
  return t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
}

function leerFilas(buffer) {
  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer' });
  } catch {
    throw badRequest('No se pudo leer el archivo. Use la plantilla en Excel (.xlsx).');
  }
  const hoja = wb.Sheets[wb.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json(hoja, { header: 1, defval: null, raw: true });
  const encabezado = (filas[0] ?? []).map(normalizar);
  const indice = Object.fromEntries(COLUMNAS.map((c) => [c.clave, encabezado.indexOf(normalizar(c.titulo))]));
  const faltan = COLUMNAS.filter((c) => ['nit', 'descripcion', 'valor', 'cuenta'].includes(c.clave) && indice[c.clave] < 0);
  if (faltan.length) throw badRequest(`Al Excel le faltan columnas de la plantilla: ${faltan.map((c) => c.titulo).join(', ')}.`);
  const salida = [];
  for (let i = 1; i < filas.length; i++) {
    const f = filas[i] ?? [];
    const v = (k) => (indice[k] >= 0 ? f[indice[k]] : null);
    const nit = String(v('nit') ?? '').trim();
    // Se saltan las filas vacías y la de ayuda de la plantilla.
    if (!nit && !v('descripcion') && !v('valor')) continue;
    if (/^cedula o nit/i.test(normalizar(nit))) continue;
    salida.push({
      fila: i + 1, nit, referencia: String(v('referencia') ?? '').trim(),
      descripcion: String(v('descripcion') ?? '').trim(), cantidad: numeroCelda(v('cantidad')) || '1',
      valor: numeroCelda(v('valor')), cuenta: String(v('cuenta') ?? '').trim(), observacion: String(v('observacion') ?? '').trim(),
    });
  }
  if (!salida.length) throw badRequest('El Excel no trae ningún documento soporte.');
  return salida;
}

/** Revisa (`simular`) o crea los borradores. Todo o nada: con un error no se guarda ninguno. */
export async function importarSoportes(buffer, { usuarioId = null, simular = true } = {}) {
  const filas = leerFilas(buffer);
  const client = await pool.connect();
  const resultados = [];
  try {
    await client.query('BEGIN');
    const terceros = (await client.query(
      `SELECT id, numero_documento, COALESCE(razon_social, btrim(concat_ws(' ', nombres, apellidos))) AS nombre FROM sst.terceros WHERE activo`,
    )).rows;
    const porDocumento = new Map(terceros.map((t) => [t.numero_documento.replace(/[^0-9A-Za-z]/g, ''), t]));
    const cuentas = new Map((await client.query(`SELECT id, codigo FROM sst.cuentas_contables`)).rows.map((c) => [c.codigo, c.id]));

    // Filas → documentos: mismo proveedor + misma referencia (sin referencia, cada fila es uno).
    const grupos = new Map();
    for (const f of filas) {
      const doc = f.nit.replace(/-\s*\d\s*$/, '').replace(/[^0-9A-Za-z]/g, '');
      const clave = f.referencia ? `${doc}|${f.referencia.toUpperCase()}` : `fila|${f.fila}`;
      if (!grupos.has(clave)) grupos.set(clave, { doc, filas: [] });
      grupos.get(clave).filas.push(f);
    }

    let n = 0;
    for (const { doc, filas: fs } of grupos.values()) {
      const r = { filas: fs.map((f) => f.fila), proveedor: null, referencia: fs[0].referencia || null, lineas: fs.length, total: null, error: null };
      const sp = `ds_${++n}`;
      await client.query(`SAVEPOINT ${sp}`);
      try {
        const tercero = porDocumento.get(doc);
        if (!tercero) throw badRequest(`el proveedor ${fs[0].nit || '(sin documento)'} no existe en Terceros`);
        r.proveedor = tercero.nombre;
        const lineas = fs.map((f) => {
          const cuentaId = cuentas.get(f.cuenta);
          if (!cuentaId) throw badRequest(`fila ${f.fila}: la cuenta ${f.cuenta || '(vacía)'} no existe en el plan de cuentas`);
          return { descripcion: f.descripcion, cantidad: f.cantidad, valor_unitario: f.valor, cuenta_id: cuentaId };
        });
        const observaciones = [...new Set(fs.map((f) => f.observacion).filter(Boolean))].join(' · ');
        const ds = await crearSoporteManual({ tercero_id: tercero.id, observaciones, lineas }, usuarioId, { client });
        r.total = ds.total_a_pagar;
        await client.query(`RELEASE SAVEPOINT ${sp}`);
      } catch (e) {
        await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        r.error = e.message;
      }
      resultados.push(r);
    }
    const errores = resultados.filter((r) => r.error).length;
    await client.query(!simular && !errores ? 'COMMIT' : 'ROLLBACK');
    const totalCentavos = resultados.filter((r) => !r.error).reduce((s, r) => s + Math.round(Number(r.total) * 100), 0);
    return {
      simulado: simular || errores > 0,
      importados: !simular && !errores ? resultados.length : 0,
      documentos: resultados.length, filas: filas.length, errores,
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
