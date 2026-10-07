// Consulta de SOLO LECTURA de los rangos de numeración en Factus (producción o sandbox).
// Uso (en el servidor): node scripts/factus-rangos-consultar.mjs [ruta/al/.env]
//
// Muestra dos listas:
//  1. GET /v2/numbering-ranges/dian → lo que la DIAN tiene asociado al software
//     (aquí debe salir FE 1001-1500 tras asociar el prefijo en el portal DIAN).
//  2. GET /v2/numbering-ranges      → los rangos ya creados en Factus.
//
// No importa nada del repo a propósito: lee el .env por su cuenta para poder correr
// desde cualquier carpeta sin depender del código desplegado. No hace POST ni
// imprime credenciales; la clave técnica se muestra recortada.
import fs from 'node:fs';

const rutaEnv = process.argv[2] || '/opt/orbita/sst_ws/.env';
const env = Object.fromEntries(
  fs.readFileSync(rutaEnv, 'utf8').split(/\r?\n/)
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/))
    .filter(Boolean)
    .map(([, k, v]) => [k, v.replace(/^(['"])(.*)\1$/, '$2')]),
);

const faltan = ['FACTUS_URL', 'FACTUS_CLIENT_ID', 'FACTUS_CLIENT_SECRET', 'FACTUS_USERNAME', 'FACTUS_PASSWORD']
  .filter((k) => !env[k]);
if (faltan.length) {
  console.error(`✗ Faltan en ${rutaEnv}: ${faltan.join(', ')}`);
  process.exit(1);
}
const base = env.FACTUS_URL.replace(/\/+$/, '');
console.log(`Factus: ${base} (${base.includes('sandbox') ? 'SANDBOX' : 'PRODUCCIÓN'})\n`);

const recortar = (s) => (s ? `${String(s).slice(0, 6)}…${String(s).slice(-4)}` : '—');

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

async function get(at, ruta, query = {}) {
  const url = new URL(`${base}${ruta}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const r = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${at}` } });
  const texto = await r.text();
  let d;
  try { d = JSON.parse(texto); } catch { d = { crudo: texto.slice(0, 300) }; }
  if (!r.ok) throw new Error(`${ruta}: HTTP ${r.status} ${JSON.stringify(d).slice(0, 400)}`);
  return d;
}

try {
  const at = await token();
  console.log('✓ Token obtenido\n');

  console.log('1. Rangos que la DIAN tiene asociados al software (GET /v2/numbering-ranges/dian)');
  const dian = await get(at, '/v2/numbering-ranges/dian');
  const listaDian = Array.isArray(dian.data) ? dian.data : (dian.data?.data ?? []);
  if (!listaDian.length) console.log('   (vacío)  respuesta:', JSON.stringify(dian).slice(0, 400));
  for (const x of listaDian) {
    console.log(`   · ${x.prefix} ${x.from}–${x.to} · resolución ${x.resolution_number} · ${x.start_date} → ${x.end_date} · clave técnica ${recortar(x.technical_key)}`);
  }

  console.log('\n2. Rangos creados en Factus (GET /v2/numbering-ranges)');
  const rangos = [];
  for (let pagina = 1, ultima = 1; pagina <= ultima; pagina++) {
    const r = await get(at, '/v2/numbering-ranges', { page: pagina });
    rangos.push(...(r.data?.data ?? []));
    ultima = r.data?.pagination?.last_page ?? 1;
  }
  if (!rangos.length) console.log('   (vacío)');
  for (const x of rangos) {
    console.log(`   · id ${x.id} · ${x.document} · ${x.prefix} ${x.from ?? '?'}–${x.to ?? '?'} · siguiente ${x.current} · resolución ${x.resolution_number ?? '—'}${x.is_active ? '' : ' · INACTIVO'}${x.is_expired ? ' · VENCIDO' : ''}`);
  }
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  process.exitCode = 1;
}
