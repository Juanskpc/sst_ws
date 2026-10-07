import { createApp } from './app.js';
import { env } from './config/env.js';
import { pool } from './config/db.js';

const app = createApp();

const server = app.listen(env.port, () => {
  console.log(`\n🚀 JD&D IA-Core backend (Fase 1)`);
  console.log(`   → http://localhost:${env.port}/api/health`);
  console.log(`   → entorno: ${env.nodeEnv}`);
  console.log(`   → IA extracción (motor principal): OpenAI (${process.env.OPENAI_MODEL || 'gpt-4o-mini'})`);
  console.log(`   → IA auxiliar (clasificación/resumen/búsqueda · PENDIENTE DE MIGRACIÓN): ${env.gemini.enabled ? 'Gemini (' + env.gemini.modelPro + ')' : 'MOCK (sin GEMINI_API_KEY)'}`);
  console.log(`   → correo: ${env.email.driver} · storage: ${env.storage.driver}\n`);
});

// 7-oct-2026 · Conexiones reutilizadas. Node cierra una conexión keep-alive a los
// 5 s de estar quieta, y el navegador (o nginx) puede estar justo reutilizándola
// para la petición siguiente: esa petición muere con un corte de conexión. Un GET
// se reintenta solo y nadie lo nota; una SUBIDA de archivo no, y es justo la que
// llega después de varios segundos de pausa (lo que se tarda en elegir el
// archivo). De ahí el «a veces falla y al reintentar funciona» en todas las
// pantallas que cargan documentos. Con 65 s el servidor nunca cierra antes que el
// cliente (los navegadores y nginx sueltan las suyas a los 60 s o antes).
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

async function shutdown(signal) {
  console.log(`\n${signal} recibido, cerrando…`);
  server.close(async () => {
    await pool.end().catch(() => {});
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
