// Smoke del Paso 3: ejercita la función REAL editada runExtraction (extraction.service.js)
// con un PDF real. Verifica que la rama PDF ahora usa OpenAI y respeta el contrato
// { arlNombre, records:[{fields, engine}] }. Sin HTTP, sin DB, sin auth.
// Uso: node --import tsx scripts/smoke-swap.mjs "<ruta.pdf>"
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { runExtraction } from '../src/services/extraction.service.js';

const pdf = process.argv[2];
if (!pdf) { console.error('Falta la ruta del PDF'); process.exit(1); }

const buffer = readFileSync(pdf);
const out = await runExtraction({ buffer, mime: 'application/pdf', arlHint: 'Colmena' });

const rec = out.records?.[0];
const okShape = !!rec && !!rec.fields && typeof rec.engine === 'string';
const okEngine = /gpt/i.test(rec?.engine || '');
console.log('arlNombre:', out.arlNombre);
console.log('records:', out.records?.length);
console.log('engine:', rec?.engine, okEngine ? '✅' : '❌ (¿sigue Gemini/mock?)');
console.log('fields.empresa_nombre:', rec?.fields?.empresa_nombre?.value);
console.log('shape { arlNombre, records:[{fields, engine}] }:', okShape ? '✅' : '❌');

if (!okShape || !okEngine) { console.error('\n❌ El swap no quedó bien cableado'); process.exit(1); }
console.log('\n✅ Paso 3 OK: runExtraction (módulo existente) ahora extrae con OpenAI.');
