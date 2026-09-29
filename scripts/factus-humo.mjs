// Prueba de humo del cliente de Factus (A0-03), SOLO contra el sandbox.
// Uso: node scripts/factus-humo.mjs
//
// Comprueba, en el orden en que puede fallar: que las credenciales sirven (OAuth2),
// a qué empresa pertenecen, qué rangos de numeración trae el sandbox y que lo que
// Factus usa para describir a esa empresa existe en nuestros catálogos DIAN
// (db/semillas/catalogos-dian.json).
//
// ⚠️ Ni municipios ni unidades de medida se piden al API: la v2 no los expone
// (ver la nota de scripts/sembrar-catalogos-dian.mjs). Por eso se contrastan
// contra el volcado de las tablas oficiales.
//
// Se niega a correr si FACTUS_URL no es el sandbox: una petición a producción
// puede quemar un consecutivo fiscal que no se recupera.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../src/config/env.js';
import {
  request, esSandbox, estaConfigurado, faltanCredenciales, peticionesRestantes,
} from '../src/modules/facturacion/adaptadores/factus.cliente.js';

const VOLCADO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'semillas', 'catalogos-dian.json');

try {
  if (!estaConfigurado()) {
    throw new Error(`Faltan en .env: ${faltanCredenciales().join(', ')} (variables FACTUS_*).`);
  }
  if (!esSandbox()) {
    throw new Error(`FACTUS_URL apunta a ${env.factus.url}. Este script solo corre contra el sandbox (https://api-sandbox.factus.com.co).`);
  }
  console.log(`Factus sandbox: ${env.factus.url}`);

  // 1. Autenticación: la primera llamada pide el token; `request` lo cachea.
  const { data: empresa } = await request('GET', '/v2/companies');
  console.log(`✓ Token OAuth2 obtenido y aceptado`);
  console.log(`✓ Empresa del sandbox: ${empresa.graphic_representation_name || empresa.names} · NIT ${empresa.nit}-${empresa.dv}`);
  console.log(`    municipio ${empresa.municipality?.code} ${empresa.municipality?.name} · tributo ${empresa.tribute?.code} · organización ${empresa.legal_organization?.code}`);

  // 2. Rangos de numeración (paginados de a 10).
  const rangos = [];
  for (let pagina = 1, ultima = 1; pagina <= ultima; pagina++) {
    const r = await request('GET', '/v2/numbering-ranges', undefined, { query: { page: pagina } });
    rangos.push(...r.data.data);
    ultima = r.data.pagination?.last_page ?? 1;
  }
  console.log(`✓ Rangos de numeración: ${rangos.length}`);
  for (const x of rangos) {
    const tramo = x.from != null ? `${x.from}–${x.to}` : 'sin tope';
    console.log(`    id ${x.id} · ${x.document.padEnd(30)} · ${String(x.prefix).padEnd(5)} · ${tramo} · siguiente ${x.current}${x.is_active ? '' : ' · INACTIVO'}${x.is_expired ? ' · VENCIDO' : ''}`);
  }

  // 3. Lo que Factus dice de su empresa tiene que estar en nuestros catálogos.
  if (fs.existsSync(VOLCADO)) {
    const cat = JSON.parse(fs.readFileSync(VOLCADO, 'utf8'));
    const existe = (lista, codigo) => lista.some((x) => x.codigo === codigo);
    console.log(`✓ Catálogos locales (${path.relative(process.cwd(), VOLCADO)}): ${cat.municipios.length} municipios, ${cat.unidades_medida.length} unidades de medida`);
    for (const [que, lista, codigo] of [
      ['municipio', cat.municipios, empresa.municipality?.code],
      ['tributo', cat.tributos, empresa.tribute?.code],
    ]) {
      if (!existe(lista, codigo)) throw new Error(`El ${que} "${codigo}" de la empresa del sandbox no está en nuestros catálogos.`);
      console.log(`    ✓ ${que} ${codigo} presente`);
    }
  } else {
    console.log('… Sin volcado de catálogos: corra scripts/sembrar-catalogos-dian.mjs para generarlo.');
  }

  if (peticionesRestantes !== null) console.log(`Peticiones restantes este minuto: ${peticionesRestantes}`);
  console.log('\nHumo OK.');
} catch (err) {
  console.error(`\n✗ ${err.mensaje || err.message}`);
  if (err.detalle) console.error(`  detalle: ${JSON.stringify(err.detalle).slice(0, 300)}`);
  process.exitCode = 1;
}
