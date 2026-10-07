// Crea en el proveedor el rango de NOTAS CRÉDITO (documento 22) o de NOTAS DE AJUSTE
// al documento soporte (documento 25). Estas notas NO llevan resolución de la DIAN:
// el prefijo y el consecutivo los define JD&D, y el rango se crea solo en el proveedor.
//
// Notas crédito de JD&D (7-oct-2026): la contadora indicó que van «en el 90» → prefijo
// NC (el de Siigo, NC-1-87) y siguiente número 90.
//
// Uso (en el servidor; el .env por defecto es el de producción):
//   node factus-rango-crear-nota.mjs nc                 → simulación
//   node factus-rango-crear-nota.mjs nc --confirmar     → crea el rango
//   node factus-rango-crear-nota.mjs na PREFIJO INICIO  → nota de ajuste (cuando se decida)
//   … [--env ruta/al/.env] para otro ambiente (p. ej. el sandbox local)
// No importa nada del repo ni imprime credenciales. Si ya existe un rango activo de ese
// documento con ese prefijo, no crea nada.
import fs from 'node:fs';

const args = process.argv.slice(2);
const confirmar = args.includes('--confirmar');
const iEnv = args.indexOf('--env');
const rutaEnv = iEnv >= 0 ? args[iEnv + 1] : '/opt/orbita/sst_ws/.env';
const libres = args.filter((a, i) => !a.startsWith('--') && (iEnv < 0 || i !== iEnv + 1));
const [tipo, prefijoArg, inicioArg] = libres;

const TIPOS = {
  nc: { document: '22', nombre: 'Nota crédito', prefix: 'NC', current: '90' },
  na: { document: '25', nombre: 'Nota de ajuste al documento soporte', prefix: null, current: null },
};
const def = TIPOS[String(tipo || '').toLowerCase()];
if (!def) {
  console.error('Indique el tipo: nc (nota crédito) o na (nota de ajuste al documento soporte).');
  process.exit(1);
}
const RANGO = {
  document: def.document,
  prefix: (prefijoArg || def.prefix || '').toUpperCase(),
  current: String(inicioArg || def.current || ''),
};
if (!RANGO.prefix || !/^\d+$/.test(RANGO.current)) {
  console.error(`Para ${def.nombre} indique el prefijo y el número de inicio: node factus-rango-crear-nota.mjs ${tipo} PREFIJO INICIO`);
  process.exit(1);
}

const env = Object.fromEntries(
  fs.readFileSync(rutaEnv, 'utf8').split(/\r?\n/)
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/))
    .filter(Boolean)
    // trim antes de quitar comillas: un valor entre comillas con espacio al final las conservaba.
    .map(([, k, v]) => [k, v.trim().replace(/^(['"])(.*)\1$/, '$2')]),
);
const base = String(env.FACTUS_URL || '').replace(/\/+$/, '');
if (!base) {
  console.error(`✗ Falta FACTUS_URL en ${rutaEnv}`);
  process.exit(1);
}
console.log(`Proveedor: ${base} (${base.includes('sandbox') ? 'SANDBOX' : 'PRODUCCIÓN'}) · ${confirmar ? 'CREAR' : 'SIMULACIÓN'}\n`);

async function token() {
  const r = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: env.FACTUS_CLIENT_ID,
      client_secret: env.FACTUS_CLIENT_SECRET,
      username: env.FACTUS_USERNAME,
      password: env.FACTUS_PASSWORD,
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error(`Autenticación rechazada: HTTP ${r.status} ${d.message || d.error || ''}`);
  return d.access_token;
}

async function llamar(at, metodo, ruta, { query, cuerpo } = {}) {
  const url = new URL(`${base}${ruta}`);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));
  const r = await fetch(url, {
    method: metodo,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${at}` },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const texto = await r.text();
  let d;
  try { d = JSON.parse(texto); } catch { d = { crudo: texto.slice(0, 300) }; }
  if (!r.ok) throw new Error(`${metodo} ${ruta}: HTTP ${r.status} ${JSON.stringify(d).slice(0, 600)}`);
  return d;
}

try {
  const at = await token();
  const rangos = [];
  for (let pagina = 1, ultima = 1; pagina <= ultima; pagina++) {
    const r = await llamar(at, 'GET', '/v2/numbering-ranges', { query: { page: pagina } });
    rangos.push(...(r.data?.data ?? []));
    ultima = r.data?.pagination?.last_page ?? 1;
  }
  const delTipo = rangos.filter((x) => /cr[eé]dito/i.test(String(x.document)) === (def.document === '22')
    && /ajuste/i.test(String(x.document)) === (def.document === '25'));
  console.log(`Rangos de ${def.nombre} que ya existen: ${delTipo.map((x) => `id ${x.id} ${x.prefix} sig ${x.current}${x.is_active ? '' : ' (inactivo)'}`).join(' | ') || 'ninguno'}`);
  const yaExiste = rangos.find((x) => x.prefix === RANGO.prefix && x.is_active);
  if (yaExiste) {
    console.log(`= Ya existe un rango activo con prefijo ${RANGO.prefix}: id ${yaExiste.id} · ${yaExiste.document} · siguiente ${yaExiste.current}. No se crea nada.`);
    process.exit(0);
  }
  console.log(`\nPOST /v2/numbering-ranges ${JSON.stringify(RANGO)}`);
  if (!confirmar) {
    console.log('\nSimulación: no se envió nada. Repetir con --confirmar para crearlo.');
    process.exit(0);
  }
  const creado = await llamar(at, 'POST', '/v2/numbering-ranges', { cuerpo: RANGO });
  const x = creado.data ?? creado;
  console.log(`\n✓ Creado: id ${x.id} · ${x.document_name ?? x.document} · ${x.prefix} · siguiente ${x.current}${x.is_active === false ? ' · INACTIVO' : ''}`);
  console.log('  Siguiente paso: Parametrización → Numeración → «Sincronizar con el proveedor» en ORBITA.');
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  process.exitCode = 1;
}
