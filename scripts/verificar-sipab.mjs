/**
 * Verificación del camino Excel de Bolívar (SIPAB) sin tocar la base de datos.
 *
 *   node --import tsx scripts/verificar-sipab.mjs "<ruta al .xlsx>"
 *
 * Lee el archivo con el MISMO parser que usa el pipeline (`runExtraction`) y
 * comprueba, campo por campo, lo que quedaría guardado en `ordenes_servicio`:
 * identidad, fechas parseables, la descripción real (no el estado de la
 * empresa), la ciudad separada del bloque de ubicación y la fila de la hoja a la
 * que apunta cada orden. Sale con código 1 si alguna comprobación falla, así que
 * sirve tal cual para revisar un SIPAB nuevo antes de subirlo.
 *
 * Los SIPAB reales no viajan por git (ver HANDOFF §2): para probar sin ellos,
 * `node --import tsx scripts/generar-ordenes-ejemplo.mjs` escribe dos con datos
 * inventados en `docs/BasesDatosEjemplo/`.
 */
import fs from 'node:fs';
import { parseExcelSipab, readSheetPreview, runExtraction } from '../src/services/extraction.service.js';
import { parseFechaCO, parseNumeroCO } from '../src/utils/parseo.js';

const archivo = process.argv[2];
const buffer = fs.readFileSync(archivo);

const { arlNombre, arlConfidence, records } = await runExtraction({
  buffer, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: archivo,
});

console.log(`\nARCHIVO: ${archivo.split(/[\\/]/).pop()}`);
console.log(`ARL: ${arlNombre} (${arlConfidence}%) · órdenes extraídas: ${records.length}`);

const primera = records[0];
console.log('\n--- Orden 1 (fila %d) tal como quedaría guardada ---', primera.sourceRow);
for (const [k, v] of Object.entries(primera.fields)) {
  if (v.value) console.log(`  ${k.padEnd(28)} ${String(v.value).slice(0, 90)}   [${v.confidence}%]`);
}
console.log('  sipab:', JSON.stringify(primera.sipab));

// --- Comprobaciones -------------------------------------------------------
const fallos = [];
const check = (nombre, ok, detalle = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLA'} ${nombre}${detalle ? ' · ' + detalle : ''}`);
  if (!ok) fallos.push(nombre);
};

console.log('\n--- Comprobaciones sobre las %d órdenes ---', records.length);

const cuenta = (p) => records.filter(p).length;

check('identidad Bolívar (cronograma + secuencia) en todas',
  cuenta((r) => r.fields.codigo_cronograma.value && r.fields.secuencia.value) === records.length);
check('numero_orden vacío (identidad excluyente por ARL)',
  cuenta((r) => r.fields.numero_orden.value) === 0);
check('NIT y razón social en todas',
  cuenta((r) => r.fields.nit_nic.value && r.fields.empresa_nombre.value) === records.length);
// Las horas solo se dan por buenas cuando el SIPAB mide la actividad en HORAS.
// Lo que viene en UNIDADES es una cantidad de actividades, no una duración, y
// debe llegar VACÍO para que lo diligencie quien revisa (ver extraction.service).
// Las dos comprobaciones se saltan las hojas que no declaran unidad de medida
// (una exportación propia, por ejemplo): sin esa columna no hay nada que decidir.
const conUnidad = records.filter((r) => r.sipab?.unidad_medida);
const enHoras = (r) => /hora/i.test(r.sipab?.unidad_medida ?? '');
check('horas en todas las órdenes medidas en HORAS',
  conUnidad.filter(enHoras).every((r) => parseNumeroCO(r.fields.horas_asignadas.value) > 0));
check('las órdenes que NO se miden en horas llegan sin horas (las pone quien revisa)',
  conUnidad.filter((r) => !enHoras(r)).every((r) => !r.fields.horas_asignadas.value));

const sinFecha = cuenta((r) => !parseFechaCO(r.fields.fecha_orden.value));
check('fecha_orden parseable a ISO en todas', sinFecha === 0, `${sinFecha} sin fecha`);

const descEstado = cuenta((r) => /^(activa|inactiva|en mora)$/i.test(r.fields.descripcion.value));
check('descripción NO es el estado de la empresa', descEstado === 0, `${descEstado} con "Activa"`);
check('tipo_actividad (título real) en todas',
  cuenta((r) => r.fields.tipo_actividad.value) === records.length);
check('descripción con contenido en todas',
  cuenta((r) => r.fields.descripcion.value.length > 10) === records.length);

const ciudadSucia = cuenta((r) => /departamento:|direcci|tel[eé]fono:/i.test(r.fields.ciudad_ejecucion.value));
check('ciudad limpia (sin el bloque de ubicación)', ciudadSucia === 0, `${ciudadSucia} sucias`);
check('ciudad en todas', cuenta((r) => r.fields.ciudad_ejecucion.value) === records.length);
check('dirección en todas', cuenta((r) => r.fields.direccion.value) === records.length);
check('contacto de la empresa (nombre y teléfono) en todas',
  cuenta((r) => r.fields.contacto_empresa_nombre.value && r.fields.contacto_empresa_telefono.value) === records.length);

const correos = cuenta((r) => r.fields.contacto_sst_correo.value);
const celulares = cuenta((r) => r.fields.contacto_sst_telefono.value);
console.log(`INFO  correo SST rescatado de observaciones: ${correos}/${records.length}; celular: ${celulares}/${records.length} (confianza 60 → marcados para revisión)`);

const correosMalos = records.filter((r) => r.fields.contacto_sst_correo.value)
  .filter((r) => !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(r.fields.contacto_sst_correo.value));
check('los correos rescatados son direcciones válidas', correosMalos.length === 0);

const horasFlag = conUnidad.filter((r) => !enHoras(r)).length;
console.log(`INFO  órdenes cuya cantidad NO está en horas (van sin horas, a diligenciar): ${horasFlag}/${records.length}`);

// "Hora Programada" es la hora de INICIO de la visita, no una duración. Excel la
// guarda en su día cero, así que un 1899-12-30 aquí sería el fallo de formato.
const horasRaras = records.filter((r) => r.sipab?.hora_programada)
  .filter((r) => !/^\d{2}:\d{2}$/.test(r.sipab.hora_programada));
check('la hora programada se lee como hora (HH:mm), no como fecha', horasRaras.length === 0);

const venc = cuenta((r) => r.fields.fecha_vencimiento.value);
console.log(`INFO  con fecha de vencimiento: ${venc}/${records.length}`);

// Duplicados dentro del propio archivo (el dedup de BD no los vería entre sí).
const ids = records.map((r) => `${r.fields.codigo_cronograma.value}·${r.fields.secuencia.value}`);
check('sin identidades repetidas dentro del archivo', new Set(ids).size === ids.length,
  `${ids.length - new Set(ids).size} repetidas`);

// La fila resaltada en la vista previa debe ser la fila real de la hoja.
const hoja = await readSheetPreview(buffer);
const desalineadas = records.filter((r) => {
  const fila = hoja.filas.find((f) => f.n === r.sourceRow);
  return !fila || !fila.celdas.includes(r.fields.codigo_cronograma.value);
});
check('source_row apunta a la fila real de la hoja', desalineadas.length === 0);

// Hoja y campo extraído se leen igual (fechas normalizadas en ambos lados).
const fechasDesalineadas = records.filter((r) => {
  const fila = hoja.filas.find((f) => f.n === r.sourceRow);
  return fila && r.fields.fecha_orden.value && !fila.celdas.includes(r.fields.fecha_orden.value);
});
check('la fecha se lee igual en la hoja y en el campo', fechasDesalineadas.length === 0,
  `${fechasDesalineadas.length} desalineadas`);

console.log(fallos.length ? `\nRESULTADO: ${fallos.length} comprobación(es) FALLIDA(S)` : '\nRESULTADO: todo OK');
process.exit(fallos.length ? 1 : 0);
