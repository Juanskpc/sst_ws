import { pool } from '../../config/db.js';
import { aCentavos, deCentavos } from '../../utils/dinero.js';
import { leerFiltros } from './balance.service.js';

/**
 * C6-01 (RPC-01) · Ventas por cliente.
 *
 * Sale de los documentos electrónicos, no del libro: es lo que se FACTURÓ a cada
 * cliente en el rango (por fecha de emisión), con sus notas crédito restando. Una
 * factura que una nota crédito anuló queda ANULADA pero sí se emitió, así que
 * cuenta, y su nota la resta: el neto da lo mismo que si nunca hubiera existido
 * y el informe deja ver las dos.
 *
 * Solo documentos ante la DIAN (VALIDADO o ANULADO): un borrador o un rechazo no
 * es una venta.
 */

const NOMBRE_TERCERO = `COALESCE(t.razon_social, NULLIF(btrim(concat_ws(' ', t.nombres, t.apellidos)), ''))`;
const CAMPOS = ['subtotal', 'total_iva', 'total_retenciones', 'total_a_pagar'];

export async function ventasPorCliente(q = {}, db = pool) {
  const f = leerFiltros(q);
  const params = [f.desde, f.hasta];
  let filtroTercero = '';
  if (f.terceroId) { params.push(f.terceroId); filtroTercero = `AND d.tercero_id = $${params.length}`; }

  const docs = (await db.query(
    `SELECT d.id, d.tipo, d.estado, d.numero, d.fecha_emision::text AS fecha, d.tercero_id,
            ${NOMBRE_TERCERO} AS tercero_nombre, t.numero_documento AS tercero_documento,
            d.subtotal, d.total_iva, d.total_retenciones, d.total_a_pagar,
            ref.numero AS referencia
       FROM sst.documentos_electronicos d
       JOIN sst.terceros t ON t.id = d.tercero_id
       LEFT JOIN sst.documentos_electronicos ref ON ref.id = d.documento_referencia_id
      WHERE d.tipo IN ('FACTURA', 'NOTA_CREDITO')
        AND d.estado IN ('VALIDADO', 'ANULADO')
        AND d.fecha_emision BETWEEN $1 AND $2
        ${filtroTercero}
      ORDER BY d.fecha_emision, d.tipo, d.numero`,
    params,
  )).rows;

  const vacio = () => Object.fromEntries(CAMPOS.map((c) => [c, 0]));
  const clientes = new Map();
  const total = vacio();
  for (const d of docs) {
    let c = clientes.get(d.tercero_id);
    if (!c) {
      c = { tercero_id: d.tercero_id, nombre: d.tercero_nombre, documento: d.tercero_documento, facturas: 0, notas: 0, ...vacio(), documentos: [] };
      clientes.set(d.tercero_id, c);
    }
    // La nota crédito resta en todas las columnas.
    const signo = d.tipo === 'NOTA_CREDITO' ? -1 : 1;
    if (signo > 0) c.facturas++; else c.notas++;
    for (const campo of CAMPOS) {
      const v = signo * aCentavos(d[campo]);
      c[campo] += v;
      total[campo] += v;
    }
    c.documentos.push({
      id: d.id, tipo: d.tipo, estado: d.estado, numero: d.numero, fecha: d.fecha, referencia: d.referencia,
      ...Object.fromEntries(CAMPOS.map((campo) => [campo, deCentavos(signo * aCentavos(d[campo]))])),
    });
  }
  const pesos = (o) => Object.fromEntries(CAMPOS.map((campo) => [campo, deCentavos(o[campo])]));

  return {
    filtros: { desde: f.desde, hasta: f.hasta, terceroId: f.terceroId },
    // De mayor a menor venta neta: es la pregunta que responde este informe.
    clientes: [...clientes.values()]
      .sort((a, b) => b.subtotal - a.subtotal || a.nombre.localeCompare(b.nombre, 'es'))
      .map((c) => ({ ...c, ...pesos(c) })),
    totales: { ...pesos(total), facturas: docs.filter((d) => d.tipo === 'FACTURA').length, notas: docs.filter((d) => d.tipo === 'NOTA_CREDITO').length },
  };
}
