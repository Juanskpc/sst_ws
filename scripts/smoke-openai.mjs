// Smoke del puente OpenAI (Paso 2). Ejecutar con: node --import tsx scripts/smoke-openai.mjs [ruta.pdf]
//  • sin argumento  → 2a LOAD-CHECK: interop tsx + carga de pdfjs + parseo de config (sin llamar a OpenAI)
//  • con un PDF real → 2b HITO #8: extrae texto + llamada real a OpenAI + asserts de contrato
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { cargarConfigOpenAIExtraccion } from '../src/infrastructure/openai/openai-extraction.config.js';
import { extractPdfWithOpenAI } from '../src/services/openai-extraction.bridge.js';

const CANON = [
  'codigo_cronograma', 'secuencia', 'nit_nic', 'empresa_nombre', 'actividad_economica',
  'horas_asignadas', 'contacto_sst_nombre', 'contacto_sst_telefono', 'contacto_sst_correo', 'descripcion',
];

const pdfPath = process.argv[2];

if (!pdfPath) {
  const cfg = cargarConfigOpenAIExtraccion(process.env);
  console.log('✅ 2a LOAD-CHECK OK');
  console.log('   · bridge + pdfjs (pdfjs-dist) importados sin error bajo tsx');
  console.log('   · config OpenAI parseada · modelo:', cfg.modelo, '· timeout:', cfg.timeoutMs, 'ms · retries:', cfg.maxRetries);
  process.exit(0);
}

const buf = readFileSync(pdfPath);
console.log(`→ 2b Enviando PDF real (${buf.length} bytes) a OpenAI…`);
const { fields, engine } = await extractPdfWithOpenAI(buf);

const faltan = CANON.filter((k) => !(k in fields));
const horasEsString = typeof fields.horas_asignadas?.value === 'string';
console.log('engine:', engine);
console.log('claves planas faltantes:', faltan.length ? faltan : 'ninguna ✅');
console.log('horas_asignadas.value es string:', horasEsString ? '✅' : '❌');
console.log('overall NO presente en fields:', !('overall_confidence' in fields) ? '✅' : '❌');
console.log(JSON.stringify(fields, null, 2));

if (faltan.length || !horasEsString) { console.error('\n❌ Asserts de contrato fallaron'); process.exit(1); }
console.log('\n✅ 2b HITO #8 OK: PDF real → respuesta de OpenAI mapeada al contrato del pipeline.');
