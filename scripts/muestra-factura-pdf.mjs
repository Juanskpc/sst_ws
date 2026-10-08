// 7-oct-2026 · Muestra del PDF propio de la factura (propuesta de diseño para JD&D).
// No toca nada: lee una factura VALIDADA de la base y escribe el PDF en la carpeta dada.
//   node scripts/muestra-factura-pdf.mjs <documentoId> <carpetaSalida> [itemsDeRelleno]
import fs from 'node:fs';
import { pool } from '../src/config/db.js';
import { obtenerBorrador } from '../src/modules/facturacion/borrador.service.js';
import { pdfFactura } from '../src/modules/facturacion/representacion.service.js';

const [id, dir, relleno] = process.argv.slice(2);
if (!id || !dir) { console.error('Uso: node scripts/muestra-factura-pdf.mjs <documentoId> <carpetaSalida> [itemsDeRelleno]'); process.exit(1); }
const doc = await obtenerBorrador(id);

const e = (await pool.query(
  `SELECT e.*, m.nombre AS municipio FROM sst.emisor e LEFT JOIN sst.municipios m ON m.id = e.municipio_id LIMIT 1`,
)).rows[0];
// Sin empresa emisora parametrizada (jdd_dev): los datos del membrete de JD&D.
const emisor = e
  ? { razon_social: e.razon_social, nit: `${Number(e.nit).toLocaleString('es-CO')}-${e.dv}`, direccion: e.direccion, ciudad: `${e.municipio ?? ''} - Colombia`, telefono: e.telefono, correo: e.correo }
  : { razon_social: 'J D Y D CONSULTORES EN SISTEMAS DE GESTION SAS', nit: '901.203.812-4', direccion: 'Carrera 26 No 19-03 Oficina 103', ciudad: 'Pasto - Colombia', telefono: '3144768516', correo: 'gerencia.djdconsultores@gmail.com' };

const t = (await pool.query(
  `SELECT COALESCE(t.razon_social, btrim(concat_ws(' ', t.nombres, t.apellidos))) AS nombre, t.numero_documento, t.dv, t.direccion, t.telefono, m.nombre AS municipio
     FROM sst.terceros t LEFT JOIN sst.municipios m ON m.id = t.municipio_id WHERE t.id = $1`, [doc.tercero_id],
)).rows[0];
const cliente = { nombre: t.nombre, documento: `${Number(t.numero_documento).toLocaleString('es-CO')}${t.dv != null ? `-${t.dv}` : ''}`, direccion: t.direccion, telefono: t.telefono, ciudad: t.municipio ? `${t.municipio} - Colombia` : null };

const resolucion = (await pool.query(
  `SELECT numero_resolucion, fecha_desde::text, fecha_hasta::text, prefijo, desde, hasta FROM sst.resoluciones_numeracion
    WHERE tipo_documento = 'FACTURA' AND prefijo = $1 ORDER BY activa DESC LIMIT 1`, [doc.prefijo],
)).rows[0] ?? null;

// Para ver cómo se comporta con muchas líneas (una factura de Bolívar trae 30 órdenes).
if (Number(relleno) > 0) {
  const base = doc.items[0];
  doc.items = Array.from({ length: Number(relleno) }, (_, i) => ({ ...base, descripcion: i % 3 ? base.descripcion : `${base.descripcion} · SEC ${20 + i} · PROGRAMA DE VIGILANCIA EPIDEMIOLOGICA` }));
}

fs.mkdirSync(dir, { recursive: true });
const salida = `${dir}/muestra-${doc.numero}${relleno ? `-${relleno}-items` : ''}.pdf`;
fs.writeFileSync(salida, await pdfFactura({ doc, emisor, cliente, resolucion, enlaceQr: doc.respuesta_proveedor?.data?.links?.qr ?? doc.qr_url }));
console.log(salida);
process.exit(0);
