// Verifica A1-06 (reenviar la factura al cliente) con EMAIL_DRIVER=console: NO
// manda un correo real. Es a propósito — la única cuenta SMTP configurada en
// este repo es la de JD&D (redes.jddconsultores@gmail.com, EMAIL_FROM) y el
// usuario pidió explícitamente no usarla para este tipo de prueba; el driver
// 'console' es el patrón ya establecido en el proyecto para probar flujos de
// correo sin tocar SMTP real (ver CLAUDE.md §5). Crea un documento VALIDADO
// desechable (sin pasar por Factus: aquí no hace falta, ya lo probó
// verificar-emision-factura.mjs) con un PDF/XML de mentira en el storage, y
// comprueba que el "para" que se imprime es el que pidió el usuario
// (escalappsystem@gmail.com, nunca un correo de cliente real).
//
// Uso: EMAIL_DRIVER=console node scripts/verificar-envio-factura.mjs
import { env } from '../src/config/env.js';
import { pool } from '../src/config/db.js';
import { storage } from '../src/services/storage.service.js';
import { reenviarAlCliente } from '../src/modules/facturacion/envio.service.js';

if (env.email.driver !== 'console') {
  throw new Error('Corra este script con EMAIL_DRIVER=console (nunca contra el SMTP real de JD&D para esta prueba).');
}

const DESTINO_PRUEBA = 'escalappsystem@gmail.com'; // nuestro correo de desarrolladores, nunca uno de cliente real
const ADMIN_ID = (await pool.query(`SELECT id FROM sst.usuarios WHERE rol = 'admin' ORDER BY creado_en LIMIT 1`)).rows[0].id;

let fallos = 0;
const igual = (obtenido, esperado, texto) => {
  const ok = JSON.stringify(obtenido) === JSON.stringify(esperado);
  if (!ok) fallos++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${texto} → ${JSON.stringify(obtenido)}${ok ? '' : ` (esperado ${JSON.stringify(esperado)})`}`);
};
const rechaza = async (fn, fragmento, texto) => {
  try { await fn(); fallos++; console.log(`FAIL ${texto} → no lanzó error`); }
  catch (e) {
    const ok = e.message.includes(fragmento);
    if (!ok) fallos++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${texto} → ${e.message.slice(0, 120)}`);
  }
};

const axa = (await pool.query(`SELECT tercero_id FROM sst.arls WHERE nombre = 'AXA Colpatria'`)).rows[0].tercero_id;

let documentoId, pdfPath, xmlPath;
try {
  pdfPath = await storage.put('facturacion/pdf', 'prueba-a106.pdf', Buffer.from('%PDF-1.4 prueba A1-06, no es un documento real'));
  xmlPath = await storage.put('facturacion/xml', 'prueba-a106.xml', Buffer.from('<Invoice>prueba A1-06</Invoice>'));

  documentoId = (await pool.query(
    `INSERT INTO sst.documentos_electronicos
       (tipo, reference_code, estado, tercero_id, numero, prefijo, cufe,
        pdf_path, xml_path, fecha_emision, fecha_vencimiento, total_a_pagar)
     VALUES ('FACTURA', 'ORB-FACTURA-PRUEBA-A106', 'VALIDADO', $1, '999999', 'TEST', 'cufe-de-prueba-a106',
             $2, $3, CURRENT_DATE, CURRENT_DATE, 353136.00)
     RETURNING id`,
    [axa, pdfPath, xmlPath],
  )).rows[0].id;

  // Documento en BORRADOR: reenviar debe rechazarse (paso previo, sin tocar el correo).
  const borradorId = (await pool.query(
    `INSERT INTO sst.documentos_electronicos (tipo, reference_code, estado, tercero_id, total_a_pagar)
     VALUES ('FACTURA', 'ORB-FACTURA-PRUEBA-A106-B', 'BORRADOR', $1, 100000) RETURNING id`,
    [axa],
  )).rows[0].id;
  await rechaza(() => reenviarAlCliente(borradorId, ADMIN_ID, {}), 'ya VALIDADA', 'Rechaza reenviar un documento en BORRADOR');
  await pool.query(`DELETE FROM sst.documentos_electronicos WHERE id = $1`, [borradorId]);

  // Sin correo (AXA no tiene correo_facturacion real) y sin override: rechaza.
  await rechaza(() => reenviarAlCliente(documentoId, ADMIN_ID, {}), 'no tiene correo', 'Rechaza sin correo_facturacion y sin override');

  console.log(`\nEnviando (driver console, no se manda nada de verdad) a ${DESTINO_PRUEBA}…`);
  const resultado = await reenviarAlCliente(documentoId, ADMIN_ID, { correo: DESTINO_PRUEBA });
  igual(resultado.estado, 'VALIDADO', 'El documento sigue VALIDADO tras reenviar');

  const evento = (await pool.query(
    `SELECT codigo, descripcion FROM sst.documento_eventos WHERE documento_id = $1 AND codigo = 'CORREO_ENVIADO' ORDER BY fecha DESC LIMIT 1`,
    [documentoId],
  )).rows[0];
  igual(evento?.descripcion, `Reenviada a ${DESTINO_PRUEBA}.`, 'Queda el evento CORREO_ENVIADO con el destino correcto');
} finally {
  if (documentoId) await pool.query(`DELETE FROM sst.documentos_electronicos WHERE id = $1`, [documentoId]);
  if (pdfPath) await storage.remove(pdfPath).catch(() => {});
  if (xmlPath) await storage.remove(xmlPath).catch(() => {});
  const restos = (await pool.query(`SELECT count(*)::int AS n FROM sst.documentos_electronicos WHERE reference_code LIKE 'ORB-FACTURA-PRUEBA-A106%'`)).rows[0].n;
  console.log(`\nResiduos: ${restos}`);
  if (restos) fallos++;
  await pool.end();
}
console.log(fallos ? `\n${fallos} FALLO(S)` : '\nTodo OK — arriba, en el bloque "📧 [EMAIL · console]", "Para:" debe decir ' + DESTINO_PRUEBA + ' y nada de JD&D ni de un cliente real.');
process.exit(fallos ? 1 : 0);
