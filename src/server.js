import { createApp } from './app.js';
import { env } from './config/env.js';
import { pool } from './config/db.js';

const app = createApp();

const server = app.listen(env.port, () => {
  console.log(`\n🚀 JD&D IA-Core backend (Fase 1)`);
  console.log(`   → http://localhost:${env.port}/api/health`);
  console.log(`   → entorno: ${env.nodeEnv}`);
  console.log(`   → IA producto: ${env.gemini.enabled ? 'Gemini (' + env.gemini.modelPro + ')' : 'MOCK (sin GEMINI_API_KEY)'}`);
  console.log(`   → correo: ${env.email.driver} · storage: ${env.storage.driver}\n`);
});

async function shutdown(signal) {
  console.log(`\n${signal} recibido, cerrando…`);
  server.close(async () => {
    await pool.end().catch(() => {});
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
