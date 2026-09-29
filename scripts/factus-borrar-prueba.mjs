// Borra en el SANDBOX una factura de prueba que quedó RECHAZADA (nunca una
// validada: eso sería alterar un documento fiscal). Solo para liberar el
// reference_code y poder reintentar con datos corregidos.
// Uso: node scripts/factus-borrar-prueba.mjs <reference_code>
import { esSandbox, estaConfigurado, request } from '../src/modules/facturacion/adaptadores/factus.cliente.js';
import { env } from '../src/config/env.js';

const referenceCode = process.argv[2];
if (!referenceCode) throw new Error('Uso: node scripts/factus-borrar-prueba.mjs <reference_code>');
if (!estaConfigurado()) throw new Error('Faltan las variables FACTUS_* en .env');
if (!esSandbox()) throw new Error(`FACTUS_URL apunta a ${env.factus.url}. Este script solo corre contra el sandbox.`);

try {
  const r = await request('DELETE', `/v2/bills/destroy/reference/${encodeURIComponent(referenceCode)}`);
  console.log(`✓ Borrada: ${r.message || JSON.stringify(r)}`);
} catch (err) {
  console.error(`✗ ${err.mensaje || err.message}`);
  process.exitCode = 1;
}
