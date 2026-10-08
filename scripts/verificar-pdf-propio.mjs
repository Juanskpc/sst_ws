// 8-oct-2026 · Verifica el PDF propio de la factura tal como lo arma la aplicación
// (`pdfPropioFactura`), no con los datos de muestra de `muestra-factura-pdf.mjs`.
//   node --import tsx scripts/verificar-pdf-propio.mjs <carpetaSalida> [documentoId]
// No deja nada en la base: si no hay empresa emisora (jdd_dev), la crea dentro de una
// transacción que termina en ROLLBACK.
import fs from 'node:fs';
import { pool } from '../src/config/db.js';
import { pdfDeDocumento, pdfPropioFactura } from '../src/modules/facturacion/representacion.service.js';

const [dir, idDado] = process.argv.slice(2);
if (!dir) { console.error('Uso: node --import tsx scripts/verificar-pdf-propio.mjs <carpetaSalida> [documentoId]'); process.exit(1); }

const client = await pool.connect();
let fallos = 0;
const comprobar = (ok, texto) => { console.log(`${ok ? '✓' : '✗'} ${texto}`); if (!ok) fallos += 1; };
try {
  await client.query('BEGIN');
  const f = (await client.query(
    `SELECT id, numero, pdf_path FROM sst.documentos_electronicos
      WHERE tipo = 'FACTURA' AND estado = 'VALIDADO' AND cufe IS NOT NULL ${idDado ? 'AND id = $1' : ''}
      ORDER BY actualizado_en DESC LIMIT 1`, idDado ? [idDado] : [],
  )).rows[0];
  if (!f) throw new Error('No hay ninguna factura VALIDADA para probar.');

  const hayEmisor = (await client.query(`SELECT 1 FROM sst.emisor`)).rowCount > 0;
  if (!hayEmisor) {
    // Sin emisor la aplicación cae al PDF del proveedor: se comprueba antes de crearlo.
    comprobar(await pdfPropioFactura(f.id, client) === null, 'sin empresa emisora no se arma el PDF propio');
    const conRespaldo = await pdfDeDocumento(f.id, f.pdf_path, client);
    comprobar(Boolean(conRespaldo?.length), `sin empresa emisora se entrega el PDF guardado del proveedor (${conRespaldo?.length ?? 0} bytes)`);
    await client.query(
      `INSERT INTO sst.emisor (id, nit, dv, razon_social, direccion, municipio_id, correo, telefono, ciiu_principal, responsabilidades_rut)
       SELECT 1, '901203812', 4, 'J D Y D CONSULTORES EN SISTEMAS DE GESTION SAS', 'CARRERA 24 N. 17-15 CASONA SAN AGUSTIN', m.id,
              'gerencia.djdconsultores@gmail.com', '3144768516', '7020', '{48}'
         FROM sst.municipios m WHERE m.nombre ILIKE 'pasto' LIMIT 1`,
    );
  }

  const pdf = await pdfPropioFactura(f.id, client);
  comprobar(Boolean(pdf?.length) && pdf.subarray(0, 4).toString() === '%PDF', `PDF propio de ${f.numero} armado (${pdf?.length ?? 0} bytes)`);
  const nc = (await client.query(`SELECT id FROM sst.documentos_electronicos WHERE tipo <> 'FACTURA' AND estado = 'VALIDADO' LIMIT 1`)).rows[0];
  if (nc) comprobar(await pdfPropioFactura(nc.id, client) === null, 'una nota crédito o documento soporte no usa el PDF propio');

  fs.mkdirSync(dir, { recursive: true });
  const salida = `${dir}/pdf-propio-${f.numero}.pdf`;
  if (pdf) fs.writeFileSync(salida, pdf);
  console.log(salida);
} catch (err) {
  console.error(`✗ ${err.message}`);
  fallos += 1;
} finally {
  await client.query('ROLLBACK');
  client.release();
  await pool.end();
}
process.exit(fallos ? 1 : 0);
