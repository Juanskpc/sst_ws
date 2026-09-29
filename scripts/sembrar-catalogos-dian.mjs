// Siembra los catálogos DIAN (A0-04, más responsabilidades fiscales de A0-05): países,
// departamentos, municipios, formas y medios de pago, tipos de documento de identidad,
// unidades de medida, tributos y responsabilidades fiscales. Idempotente: upsert por
// `codigo_dian`, se puede repetir.
//
// Uso:
//   node scripts/sembrar-catalogos-dian.mjs                # descarga → cruza con el sandbox → vuelca el JSON → upsert
//   node scripts/sembrar-catalogos-dian.mjs --desde-json   # sin red: usa db/semillas/catalogos-dian.json
//   node scripts/sembrar-catalogos-dian.mjs --solo-volcar  # descarga y vuelca el JSON, sin tocar la base
//
// ⚠️ De dónde salen los datos, y por qué NO del API del sandbox: la cuenta de
// Factus es solo v2, y la v2 no expone endpoints de catálogos (`/v2/municipalities`,
// `/v2/measurement-units`… responden 404; `/v1/*` responde 403 "Versión de API no
// disponible para esta empresa"). Los catálogos v2 son las tablas PÚBLICAS de su
// documentación (developers.factus.com.co › Tablas de referencia), y traen solo
// `code` + `name`: no hay ids propios. Por eso `factus_id` = el código que Factus
// espera en el payload (`municipality_code`, `unit_measure_code`…), que es lo que
// el sandbox validó en las facturas de prueba.
//
// Como red de seguridad la descarga se cruza contra el sandbox: el municipio, el
// tributo y el tipo de organización con que Factus describe a SU empresa de
// pruebas (`GET /v2/companies`) tienen que existir en lo descargado.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../src/config/env.js';
import { pool } from '../src/config/db.js';
import { request, esSandbox, estaConfigurado } from '../src/modules/facturacion/adaptadores/factus.cliente.js';

const DOCS = 'https://developers.factus.com.co/tablas-de-referencia';
const VOLCADO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'semillas', 'catalogos-dian.json');

const args = process.argv.slice(2);
const desdeJson = args.includes('--desde-json');
const soloVolcar = args.includes('--solo-volcar');

// ─── Descarga y lectura de las páginas de la documentación ─────────────────────────────────

const ENTIDADES = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", nbsp: ' ' };
function decodificar(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTIDADES[n.toLowerCase()] ?? m);
}
const sinEtiquetas = (s) => decodificar(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

async function bajar(ruta) {
  const r = await fetch(`${DOCS}/${ruta}/`, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`No se pudo bajar ${DOCS}/${ruta}/ (HTTP ${r.status})`);
  return r.text();
}

/** Las listas largas (municipios, unidades, países) vienen completas como JSON en el bloque de código. */
function jsonDelBloque(html, clave) {
  const pre = /<pre[\s\S]*?<\/pre>/.exec(html)?.[0];
  if (!pre) throw new Error(`La página no trae el bloque de código de "${clave}": ¿cambió la documentación?`);
  const texto = decodificar(pre.replace(/<div class="ec-line">/g, '\n').replace(/<[^>]+>/g, ''));
  const lista = JSON.parse(texto)[clave];
  if (!Array.isArray(lista) || lista.length === 0) throw new Error(`El JSON de "${clave}" viene vacío`);
  return lista;
}

/** Las tablas cortas: la primera <table> que sigue al encabezado con ese id → [[código, nombre], …]. */
function tablaDeSeccion(html, id) {
  const inicio = html.indexOf(`id="${id}"`);
  if (inicio < 0) throw new Error(`No está la sección "${id}": ¿cambió la documentación?`);
  const resto = html.slice(inicio);
  const tabla = /<table[\s\S]*?<\/table>/.exec(resto)?.[0];
  if (!tabla) throw new Error(`La sección "${id}" no trae tabla`);
  const filas = [...tabla.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map((m) => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => sinEtiquetas(c[1])))
    .filter((celdas) => celdas.length >= 2 && celdas[0]);
  if (filas.length === 0) throw new Error(`La tabla de "${id}" no trae filas`);
  return filas.map(([codigo, nombre]) => ({ codigo, nombre: nombre.replace(/\s*\*$/, '') }));
}

/**
 * Factus repite 4 códigos de unidad de medida en su propia tabla (MGM, ONZ, PD,
 * SO: dos nombres distintos cada uno). El código es la clave, así que se
 * conserva la PRIMERA aparición y se avisa; ninguno de esos lo usa JD&D.
 */
function sinRepetidos(lista, que) {
  const vistos = new Map();
  for (const x of lista) {
    if (vistos.has(x.codigo)) {
      console.log(`  ⚠ ${que}: el código ${x.codigo} viene repetido en Factus ("${vistos.get(x.codigo).nombre}" / "${x.nombre}"); se conserva el primero.`);
    } else {
      vistos.set(x.codigo, x);
    }
  }
  return [...vistos.values()];
}

async function descargar() {
  console.log('Descargando las tablas de referencia de Factus v2…');
  const [htmlMunicipios, htmlUnidades, htmlPaises, htmlTablas] = await Promise.all([
    bajar('municipios'), bajar('unit-measures'), bajar('countries'), bajar('tablas'),
  ]);

  const municipiosCrudos = jsonDelBloque(htmlMunicipios, 'municipalities');
  const departamentos = new Map();
  for (const m of municipiosCrudos) departamentos.set(m.department.code, m.department.name);

  // Los tributos son los impuestos de línea más el 'ZZ' del cliente; las retenciones
  // ('05', '06') son de A0-07. El '01' sale en las dos tablas: gana el nombre de impuesto.
  const tributos = new Map();
  for (const t of tablaDeSeccion(htmlTablas, 'códigos-de-tributos-clientes')) tributos.set(t.codigo, t.nombre);
  for (const t of tablaDeSeccion(htmlTablas, 'códigos-de-impuestos')) tributos.set(t.codigo, t.nombre);

  return {
    generado_en: new Date().toISOString(),
    fuente: `${DOCS}/ (Factus API v2; la v2 no expone catálogos por API)`,
    paises: jsonDelBloque(htmlPaises, 'countries').map(({ code, name }) => ({ codigo: code, nombre: name })),
    departamentos: [...departamentos].map(([codigo, nombre]) => ({ codigo, nombre })),
    municipios: municipiosCrudos.map((m) => ({ codigo: m.code, nombre: m.name, departamento: m.department.code })),
    formas_pago: tablaDeSeccion(htmlTablas, 'códigos-de-formas-de-pago'),
    medios_pago: tablaDeSeccion(htmlTablas, 'códigos-de-métodos-de-pago'),
    tipos_documento_identidad: tablaDeSeccion(htmlTablas, 'códigos-de-tipos-de-documentos-de-identidad'),
    unidades_medida: sinRepetidos(
      jsonDelBloque(htmlUnidades, 'unitMeasures').map(({ code, name }) => ({ codigo: code, nombre: name })),
      'unidades_medida',
    ),
    tributos: [...tributos].map(([codigo, nombre]) => ({ codigo, nombre })),
    // A0-05: lo que Factus acepta en customer.responsibilities.
    responsabilidades_fiscales: tablaDeSeccion(htmlTablas, 'responsabilidades-fiscales'),
  };
}

/** Red de seguridad: lo que el sandbox usa para su propia empresa tiene que estar en lo descargado. */
async function cruzarConSandbox(datos) {
  if (!estaConfigurado()) throw new Error('Faltan las variables FACTUS_* en .env: no se puede cruzar con el sandbox.');
  if (!esSandbox()) throw new Error(`FACTUS_URL apunta a ${env.factus.url}: este script solo corre contra el sandbox.`);

  const { data: empresa } = await request('GET', '/v2/companies');
  const comprobaciones = [
    ['municipio', empresa.municipality?.code, datos.municipios],
    ['tributo', empresa.tribute?.code, datos.tributos],
  ];
  for (const [que, codigo, lista] of comprobaciones) {
    if (!lista.some((x) => x.codigo === codigo)) {
      throw new Error(`El sandbox usa el ${que} "${codigo}" y no está en la tabla descargada: la documentación y la API no coinciden.`);
    }
    console.log(`  ✓ sandbox ↔ tabla: ${que} ${codigo}`);
  }
}

function volcar(datos) {
  fs.mkdirSync(path.dirname(VOLCADO), { recursive: true });
  // Un registro por línea: el volcado se lee y se compara en git sin ruido.
  const bloques = Object.entries(datos).map(([k, v]) =>
    Array.isArray(v) ? `  ${JSON.stringify(k)}: [\n${v.map((x) => `    ${JSON.stringify(x)}`).join(',\n')}\n  ]` : `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  fs.writeFileSync(VOLCADO, `{\n${bloques.join(',\n')}\n}\n`);
  console.log(`✓ Volcado en ${path.relative(process.cwd(), VOLCADO)}`);
}

// ─── Upsert ─────────────────────────────────────────────────────────────────────────────────

/** Upsert por codigo_dian. Devuelve cuántas filas nacieron y cuántas cambiaron. */
async function upsert(client, tabla, filas) {
  const r = await client.query(
    `INSERT INTO sst.${tabla} (codigo_dian, nombre, factus_id)
     SELECT c, n, c FROM unnest($1::text[], $2::text[]) AS u(c, n)
     ON CONFLICT (codigo_dian) DO UPDATE
        SET nombre = EXCLUDED.nombre, factus_id = EXCLUDED.factus_id, actualizado_en = now()
      WHERE (sst.${tabla}.nombre, sst.${tabla}.factus_id) IS DISTINCT FROM (EXCLUDED.nombre, EXCLUDED.factus_id)
     RETURNING (xmax = 0) AS nuevo`,
    [filas.map((f) => f.codigo), filas.map((f) => f.nombre)],
  );
  const nuevas = r.rows.filter((x) => x.nuevo).length;
  return { nuevas, cambiadas: r.rowCount - nuevas };
}

async function upsertMunicipios(client, municipios) {
  const r = await client.query(
    `INSERT INTO sst.municipios (codigo_dian, nombre, departamento_id, factus_id)
     SELECT u.c, u.n, d.id, u.c
       FROM unnest($1::text[], $2::text[], $3::text[]) AS u(c, n, dep)
       JOIN sst.departamentos d ON d.codigo_dian = u.dep
     ON CONFLICT (codigo_dian) DO UPDATE
        SET nombre = EXCLUDED.nombre, departamento_id = EXCLUDED.departamento_id,
            factus_id = EXCLUDED.factus_id, actualizado_en = now()
      WHERE (sst.municipios.nombre, sst.municipios.departamento_id, sst.municipios.factus_id)
            IS DISTINCT FROM (EXCLUDED.nombre, EXCLUDED.departamento_id, EXCLUDED.factus_id)
     RETURNING (xmax = 0) AS nuevo`,
    [municipios.map((m) => m.codigo), municipios.map((m) => m.nombre), municipios.map((m) => m.departamento)],
  );
  const nuevas = r.rows.filter((x) => x.nuevo).length;
  return { nuevas, cambiadas: r.rowCount - nuevas };
}

async function sembrar(datos) {
  const destino = new URL(env.databaseUrl);
  console.log(`Base de datos: ${destino.hostname}:${destino.port}${destino.pathname}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const resumen = {};
    // Orden: los departamentos antes que los municipios que cuelgan de ellos.
    for (const tabla of ['paises', 'departamentos']) resumen[tabla] = await upsert(client, tabla, datos[tabla]);
    resumen.municipios = await upsertMunicipios(client, datos.municipios);
    for (const tabla of ['formas_pago', 'medios_pago', 'tipos_documento_identidad', 'unidades_medida', 'tributos', 'responsabilidades_fiscales']) {
      resumen[tabla] = await upsert(client, tabla, datos[tabla]);
    }
    if (resumen.municipios.nuevas + resumen.municipios.cambiadas < datos.municipios.length) {
      // Solo pasa si el volcado tiene municipios de un departamento que no está: mejor romper que sembrar a medias.
      const { rows } = await client.query('SELECT count(*)::int AS n FROM sst.municipios');
      if (rows[0].n < datos.municipios.length) throw new Error('Quedaron municipios sin sembrar: revisar los departamentos del volcado.');
    }
    await client.query('COMMIT');
    for (const [tabla, { nuevas, cambiadas }] of Object.entries(resumen)) {
      console.log(`  ${tabla.padEnd(28)} ${String(datos[tabla].length).padStart(5)} en el volcado · ${nuevas} nuevas · ${cambiadas} actualizadas`);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Flujo ──────────────────────────────────────────────────────────────────────────────────

try {
  let datos;
  if (desdeJson) {
    datos = JSON.parse(fs.readFileSync(VOLCADO, 'utf8'));
    console.log(`Usando ${path.relative(process.cwd(), VOLCADO)} (generado ${datos.generado_en}).`);
  } else {
    datos = await descargar();
    await cruzarConSandbox(datos);
    volcar(datos);
  }
  if (!soloVolcar) await sembrar(datos);
} catch (err) {
  console.error(`\n✗ ${err.mensaje || err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
