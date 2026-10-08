// 7-oct-2026 · Muestra del PDF propio de la factura (mismo formato del software contable anterior).
// No toca nada: lee una factura VALIDADA de la base y escribe el PDF en la carpeta dada.
//   node scripts/muestra-factura-pdf.mjs <documentoId> <carpetaSalida> [itemsDeRelleno | modelo]
// Con «modelo» se pinta con los datos de la FE 816 del cliente, para compararla lado a lado con la original.
import fs from 'node:fs';
import { pool } from '../src/config/db.js';
import { obtenerBorrador } from '../src/modules/facturacion/borrador.service.js';
import { pdfFactura } from '../src/modules/facturacion/representacion.service.js';

const [id, dir, opcion] = process.argv.slice(2);
if (!id || !dir) { console.error('Uso: node scripts/muestra-factura-pdf.mjs <documentoId> <carpetaSalida> [itemsDeRelleno | modelo]'); process.exit(1); }
const doc = await obtenerBorrador(id);

const e = (await pool.query(
  `SELECT e.*, m.nombre AS municipio FROM sst.emisor e LEFT JOIN sst.municipios m ON m.id = e.municipio_id LIMIT 1`,
)).rows[0];
// Sin empresa emisora parametrizada (jdd_dev): los datos de la factura modelo de JD&D.
const emisor = e
  ? { razon_social: e.razon_social, nit: `${Number(e.nit).toLocaleString('es-CO')}-${e.dv}`, direccion: e.direccion, ciudad: `${e.municipio ?? ''} - Colombia`, telefono: e.telefono, correo: e.correo,
    regimen: 'Responsable de IVA', actividad: e.ciiu_principal }
  : { razon_social: 'J D Y D CONSULTORES EN SISTEMAS DE GESTION SAS', nit: '901.203.812-4', direccion: 'Carrera 26 No 19-03 Oficina 103', ciudad: 'Pasto - Colombia', telefono: '3144768516', correo: 'gerencia.djdconsultores@gmail.com',
    regimen: 'Responsable de IVA', actividad: '7020 Actividades de consultoria de gestión Tarifa' };

const t = (await pool.query(
  `SELECT COALESCE(t.razon_social, btrim(concat_ws(' ', t.nombres, t.apellidos))) AS nombre, t.numero_documento, t.dv, t.direccion, t.telefono, m.nombre AS municipio
     FROM sst.terceros t LEFT JOIN sst.municipios m ON m.id = t.municipio_id WHERE t.id = $1`, [doc.tercero_id],
)).rows[0];
let cliente = { nombre: t.nombre, documento: `${Number(t.numero_documento).toLocaleString('es-CO')}${t.dv != null ? `-${t.dv}` : ''}`, direccion: t.direccion, telefono: t.telefono, ciudad: t.municipio ? `${t.municipio} - Colombia` : null };

let resolucion = (await pool.query(
  `SELECT numero_resolucion, fecha_desde::text, fecha_hasta::text, prefijo, desde, hasta FROM sst.resoluciones_numeracion
    WHERE tipo_documento = 'FACTURA' AND prefijo = $1 ORDER BY activa DESC LIMIT 1`, [doc.prefijo],
)).rows[0] ?? null;

if (opcion === 'modelo') {
  Object.assign(doc, {
    prefijo: 'FE', numero: 'FE816', fecha_emision: '2026-10-02', fecha_vencimiento: '2026-10-02', actualizado_en: '2026-10-02T19:15:00Z',
    forma_pago_nombre: 'Crédito', medio_pago_nombre: 'Otro', observaciones: null,
    cufe: '6ecc491ddfd16c41b76462ba862ecde5b6e3b8fcd19dcf67401f04be26748df9fb6940bfb2d8cc580bb724033a6964bf',
    items: [{ codigo: '2', descripcion: 'Servicios de promoción y prevención de riesgos laborales prestados a las empresas afiliadas a la compañía según pre facturas:161417\n-161501-161282', cantidad: '1', valor_unitario: '8981902', base: '8981902', total_linea: '8981902', iva_valor: '0' }],
    retenciones: [{ codigo: 'RF-HON', tipo: 'RETEFUENTE', tarifa: '11', valor: '988009.22' }],
    totales: { total_bruto: '8981902', total_descuento: '0', subtotal: '8981902', total_iva: '0', total_retenciones: '988009.22', total_a_pagar: '7993892.78' },
  });
  cliente = { nombre: 'COMPAÑIA DE SEGUROS BOLIVAR S A TAMBIEN PODRA GIRAR BAJO LA DENOMINACION SEGUROS BOLIVAR S A', documento: '860.002.503-2', direccion: 'AV EL DORADO 68B 31', telefono: '(000) 3410077', ciudad: 'Bogotá - Colombia' };
  resolucion = { numero_resolucion: '18764081426622', fecha_desde: '2024-10-11', fecha_hasta: '2026-10-11', prefijo: 'FE', desde: 401, hasta: 1000 };
} else if (Number(opcion) > 0) {
  // Para ver cómo se comporta con muchas líneas (una factura de Bolívar puede traer 30 órdenes).
  const base = doc.items[0];
  doc.items = Array.from({ length: Number(opcion) }, (_, i) => ({ ...base, descripcion: i % 3 ? base.descripcion : `${base.descripcion} · SEC ${20 + i} · PROGRAMA DE VIGILANCIA EPIDEMIOLOGICA` }));
}

fs.mkdirSync(dir, { recursive: true });
const salida = `${dir}/muestra-${doc.numero}${opcion ? `-${opcion}` : ''}.pdf`;
fs.writeFileSync(salida, await pdfFactura({
  doc, emisor, cliente, resolucion,
  enlaceQr: doc.respuesta_proveedor?.data?.links?.qr ?? doc.qr_url,
  lateral: 'Software: ORBITA. Documento validado por la DIAN a través de proveedor tecnológico autorizado. Firma electrónica: ver en el XML.',
}));
console.log(salida);
process.exit(0);
