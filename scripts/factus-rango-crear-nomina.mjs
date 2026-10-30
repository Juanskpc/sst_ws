// Crea en el proveedor el rango de NÓMINA ELECTRÓNICA (documento 26) o el de NOTA DE
// AJUSTE DE NÓMINA (documento 27). No llevan resolución de la DIAN: el prefijo y el
// consecutivo los define JD&D. En el ambiente de pruebas ya vienen creados (NEF y NAN);
// en producción hay que crearlos (confirmado por el proveedor el 8-oct-2026, y el 8-oct
// producción no tenía ninguno).
//
// ⚠️ El prefijo y el número de inicio los decide la contadora: si JD&D ya emitía nómina
// electrónica desde su software contable anterior, hay que CONTINUAR ese consecutivo.
//
// Uso (en el servidor; el .env por defecto es el de producción):
//   node factus-rango-crear-nomina.mjs nomina PREFIJO INICIO               → simulación
//   node factus-rango-crear-nomina.mjs nomina PREFIJO INICIO --confirmar   → crea el rango
//   node factus-rango-crear-nomina.mjs ajuste PREFIJO INICIO [--confirmar] → nota de ajuste
//   … [--env ruta/al/.env] para otro ambiente
// No importa nada del repo ni imprime credenciales. Si ya existe un rango activo de ese
// documento con ese prefijo, no crea nada.
import fs from 'node:fs';

const args = process.argv.slice(2);
const confirmar = args.includes('--confirmar');
const iEnv = args.indexOf('--env');
const rutaEnv = iEnv >= 0 ? args[iEnv + 1] : '/opt/orbita/sst_ws/.env';
const [tipo, prefijoArg, inicioArg] = args.filter((a, i) => !a.startsWith('--') && (iEnv < 0 || i !== iEnv + 1));

const TIPOS = {
  nomina: { document: '26', nombre: 'Nómina electrónica', esAjuste: false },
  ajuste: { document: '27', nombre: 'Nota de ajuste de nómina', esAjuste: true },
};
const def = TIPOS[String(tipo || '').toLowerCase()];
const RANGO = { document: def?.document, prefix: String(prefijoArg || '').toUpperCase(), current: String(inicioArg || '') };
if (!def || !/^[A-Z0-9]{1,4}$/.test(RANGO.prefix) || !/^\d+$/.test(RANGO.current)) {
  console.error('Uso: node factus-rango-crear-nomina.mjs <nomina|ajuste> PREFIJO INICIO [--confirmar]\n  PREFIJO: hasta 4 letras o números · INICIO: el siguiente número a emitir.');
  process.exit(1);
}

const env = Object.fromEntries(
  fs.readFileSync(rutaEnv, 'utf8').split(/\r?\n/)
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/))
    .filter(Boolean)
    .map(([, k, v]) => [k, v.trim().replace(/^(['"])(.*)\1$/, '$2')]),
);
const base = String(env.FACTUS_URL || '').replace(/\/+$/, '');
if (!base) { console.error(`✗ Falta FACTUS_URL en ${rutaEnv}`); process.exit(1); }
console.log(`Proveedor: ${base} (${base.includes('sandbox') ? 'SANDBOX' : 'PRODUCCIÓN'}) · ${confirmar ? 'CREAR' : 'SIMULACIÓN'}\n`);

async function llamar(at, metodo, ruta, cuerpo) {
  const r = await fetch(`${base}${ruta}`, {
    method: metodo,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(at ? { Authorization: `Bearer ${at}` } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const texto = await r.text();
  let d;
  try { d = JSON.parse(texto); } catch { d = { crudo: texto.slice(0, 300) }; }
  if (!r.ok) throw new Error(`${metodo} ${ruta}: HTTP ${r.status} ${JSON.stringify(d).slice(0, 600)}`);
  return d;
}

try {
  const t = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: env.FACTUS_CLIENT_ID, client_secret: env.FACTUS_CLIENT_SECRET, username: env.FACTUS_USERNAME, password: env.FACTUS_PASSWORD }),
  }).then((r) => r.json());
  if (!t.access_token) throw new Error(`Autenticación rechazada: ${t.message || t.error || ''}`);

  const r = await llamar(t.access_token, 'GET', '/v2/numbering-ranges/payrolls');
  const rangos = Array.isArray(r.data) ? r.data : (r.data?.data ?? []);
  console.log(`Rangos de nómina que ya existen: ${rangos.map((x) => `${x.document} · ${x.prefix} · sig. ${x.current}${x.is_active ? '' : ' (inactivo)'}`).join(' | ') || 'ninguno'}`);
  const yaExiste = rangos.find((x) => x.is_active && x.prefix === RANGO.prefix && /ajuste/i.test(String(x.document)) === def.esAjuste);
  if (yaExiste) {
    console.log(`= Ya existe un rango activo de ${def.nombre} con prefijo ${RANGO.prefix} (siguiente ${yaExiste.current}). No se crea nada.`);
    process.exit(0);
  }
  console.log(`\nPOST /v2/numbering-ranges/payrolls ${JSON.stringify(RANGO)}   (${def.nombre})`);
  if (!confirmar) {
    console.log('\nSimulación: no se envió nada. Repetir con --confirmar para crearlo.');
    process.exit(0);
  }
  const creado = await llamar(t.access_token, 'POST', '/v2/numbering-ranges/payrolls', RANGO);
  const x = creado.data ?? creado;
  console.log(`\n✓ Creado: id ${x.id} · ${x.document_name ?? x.document} · ${x.prefix} · siguiente ${x.current}${x.is_active === false || x.is_active === 0 ? ' · INACTIVO' : ''}`);
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  process.exitCode = 1;
}
