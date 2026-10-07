// Crea en Factus el rango de DOCUMENTO SOPORTE de JD&D (resolución 18764090152350,
// DS 1001-2000) a partir de lo que la DIAN tiene asociado al software. Siigo
// llegó al DS-1333 (confirmado con la contadora el 7-oct): ORBITA sigue en el 1334.
// Uso (en el servidor):
//   node factus-rango-crear-ds.mjs              → simulación: verifica y muestra lo que enviaría
//   node factus-rango-crear-ds.mjs --confirmar  → hace el POST /v2/numbering-ranges
//
// Antes de crear comprueba que la DIAN muestre esa resolución con ese prefijo y que
// Factus no tenga ya un rango con ella (correr dos veces no duplica). Igual que
// factus-rangos-consultar.mjs, no importa nada del repo ni imprime credenciales.
import fs from 'node:fs';

const RANGO = {
  document: '24', // Documento Soporte (tabla de referencia de Factus; se confirma en la simulación)
  prefix: 'DS',
  resolution_number: '18764090152350',
  current: '1334', // Siigo mostraba el 1334 como SIGUIENTE en «Nuevo documento soporte» (7-oct): sin hueco
};

const confirmar = process.argv.includes('--confirmar');
const rutaEnv = process.argv.slice(2).find((a) => !a.startsWith('--')) || '/opt/orbita/sst_ws/.env';
const env = Object.fromEntries(
  fs.readFileSync(rutaEnv, 'utf8').split(/\r?\n/)
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/))
    .filter(Boolean)
    .map(([, k, v]) => [k, v.replace(/^(['"])(.*)\1$/, '$2')]),
);
const base = String(env.FACTUS_URL || '').replace(/\/+$/, '');
if (!base) {
  console.error(`✗ Falta FACTUS_URL en ${rutaEnv}`);
  process.exit(1);
}
console.log(`Factus: ${base} (${base.includes('sandbox') ? 'SANDBOX' : 'PRODUCCIÓN'}) · ${confirmar ? 'CREAR' : 'SIMULACIÓN'}\n`);

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

  // 1. La DIAN tiene que mostrar la resolución con ese prefijo.
  const dian = await llamar(at, 'GET', '/v2/numbering-ranges/dian');
  const listaDian = Array.isArray(dian.data) ? dian.data : (dian.data?.data ?? []);
  const enDian = listaDian.find((x) => String(x.resolution_number) === RANGO.resolution_number && x.prefix === RANGO.prefix);
  if (!enDian) throw new Error(`La DIAN no muestra ${RANGO.prefix} con resolución ${RANGO.resolution_number} asociada al software.`);
  if (Number(RANGO.current) < Number(enDian.from) || Number(RANGO.current) > Number(enDian.to)) {
    throw new Error(`current ${RANGO.current} está fuera del rango autorizado ${enDian.from}–${enDian.to}.`);
  }
  console.log(`✓ DIAN: ${enDian.prefix} ${enDian.from}–${enDian.to} · ${enDian.start_date} → ${enDian.end_date}`);
  console.log(`  registro DIAN: ${JSON.stringify(enDian)}`);

  // 2. Factus no debe tener ya un rango con esa resolución.
  const rangos = [];
  for (let pagina = 1, ultima = 1; pagina <= ultima; pagina++) {
    const r = await llamar(at, 'GET', '/v2/numbering-ranges', { query: { page: pagina } });
    rangos.push(...(r.data?.data ?? []));
    ultima = r.data?.pagination?.last_page ?? 1;
  }
  const yaExiste = rangos.find((x) => String(x.resolution_number) === RANGO.resolution_number);
  if (yaExiste) {
    console.log(`= Ya existe en Factus: id ${yaExiste.id} · ${yaExiste.document} · ${yaExiste.prefix} · siguiente ${yaExiste.current}. No se crea nada.`);
    process.exit(0);
  }
  console.log(`✓ Factus no tiene aún un rango con esa resolución (${rangos.length} rangos en total)`);
  for (const x of rangos) console.log(`  · id ${x.id} · document ${x.document} (${x.document_name ?? '?'}) · ${x.prefix} · siguiente ${x.current}`);

  // 3. Crear (o mostrar lo que se enviaría).
  console.log(`\nPOST /v2/numbering-ranges ${JSON.stringify(RANGO)}`);
  if (!confirmar) {
    console.log('\nSimulación: no se envió nada. Repetir con --confirmar para crearlo.');
    process.exit(0);
  }
  const creado = await llamar(at, 'POST', '/v2/numbering-ranges', { cuerpo: RANGO });
  const x = creado.data ?? creado;
  console.log(`\n✓ Creado: id ${x.id} · ${x.document_name ?? x.document} · ${x.prefix} ${x.from}–${x.to} · siguiente ${x.current} · ${x.start_date} → ${x.end_date}${x.is_active === false ? ' · INACTIVO' : ''}`);
  console.log('  Siguiente paso: «Sincronizar rangos» en ORBITA para que tome este id.');
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  process.exitCode = 1;
}
