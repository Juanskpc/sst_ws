import { pool } from '../config/db.js';
import { runExtraction, computeOverallConfidence } from '../services/extraction.service.js';

/**
 * Cola de importación en memoria (Fase 1). Procesa el lote de forma asíncrona
 * para que el request de subida responda de inmediato (NFR < 2s).
 * En producción se reemplaza por una cola real (BullMQ/SQS) sin tocar los llamadores.
 */
export function enqueueImport(job) {
  setImmediate(() => processBatch(job).catch((err) => {
    console.error('[importQueue] fallo procesando lote', job.batchId, err);
    pool.query(
      `UPDATE sst.lotes_importacion SET estado='ERROR', mensaje_error=$2 WHERE id=$1`,
      [job.batchId, err.message]
    ).catch(() => {});
  }));
}

/**
 * CFG-04 · Tipo de orden deducido del título de la actividad.
 *
 * La ARL no manda una categoría: manda un título ("CAP SEGURIDAD VIAL",
 * "Asesoría en SG-SST"). Cuando ese texto dice claramente de qué se trata se
 * preselecciona el tipo, y si no, se deja vacío y lo elige quien revisa —
 * adivinar mal aquí sale caro: de esta categoría cuelga el valor hora.
 *
 * Recibe el catálogo ya cargado (nombre en minúsculas → id) porque un SIPAB
 * trae ~100 filas: preguntarle a la base el id en cada una eran 100 idas y
 * vueltas para releer siempre las mismas tres categorías.
 */
function tipoOrdenPorTexto(texto, catalogo) {
  const t = String(texto || '').toLowerCase();
  const nombre = /asesor/.test(t) ? 'asesoría'
    : /inspec/.test(t) ? 'inspección'
    : /(^|\W)(cap|capacit|charla|formaci)/.test(t) ? 'capacitación'
    : null;
  return nombre ? (catalogo.get(nombre) ?? null) : null;
}

/** Catálogo CFG-04 activo: nombre normalizado → id. Una sola consulta por lote. */
async function catalogoTiposOrden() {
  const r = await pool.query(
    `SELECT id, lower(btrim(nombre)) AS nombre FROM sst.tipos_orden WHERE activo`
  );
  return new Map(r.rows.map((x) => [x.nombre, x.id]));
}

async function arlIdByName(nombre) {
  const r = await pool.query(`SELECT id FROM sst.arls WHERE nombre = $1`, [nombre]);
  return r.rows[0]?.id || null;
}

/** Identidad de una orden extraída: número (AXA/Colmena) o cronograma·secuencia (Bolívar). */
function identidadDe(fields) {
  const numeroOrden = fields.numero_orden?.value || null;
  const cron = fields.codigo_cronograma?.value || null;
  const sec = fields.secuencia?.value || null;
  return { numeroOrden, cron, sec, clave: numeroOrden || (cron && sec ? `${cron}·${sec}` : null) };
}

/**
 * IMP-07/09 · Cuáles de las identidades de este lote YA están en
 * `ordenes_servicio`, en UNA sola consulta. Devuelve clave → id de la OS.
 *
 * Antes se preguntaba orden por orden: en el SIPAB real de 99 filas eso eran 99
 * consultas contra una base remota, ~10 s del cuarto de minuto que tardaba el
 * lote entero — tiempo suficiente para que el cliente se cansara de esperar y
 * diera el archivo por fallido cuando en realidad estaba entrando.
 */
async function identidadesRegistradas(arlId, records) {
  const vacio = new Map();
  if (!arlId) return vacio;

  const numeros = [];
  const crons = [];
  const secs = [];
  for (const rec of records) {
    const { numeroOrden, cron, sec } = identidadDe(rec.fields);
    if (numeroOrden) numeros.push(numeroOrden);
    else if (cron && sec) { crons.push(cron); secs.push(sec); }
  }
  if (!numeros.length && !crons.length) return vacio;

  const r = await pool.query(
    `SELECT id, numero_orden, codigo_cronograma, secuencia
       FROM sst.ordenes_servicio
      WHERE arl_id = $1
        AND (numero_orden = ANY($2::text[])
             OR (codigo_cronograma, secuencia)
                 IN (SELECT c, s FROM unnest($3::text[], $4::text[]) AS t(c, s)))`,
    [arlId, numeros, crons, secs]
  );
  const mapa = new Map();
  for (const o of r.rows) {
    if (o.numero_orden) mapa.set(o.numero_orden, o.id);
    if (o.codigo_cronograma && o.secuencia) mapa.set(`${o.codigo_cronograma}·${o.secuencia}`, o.id);
  }
  return mapa;
}

async function processBatch({ batchId, buffer, mime, filename, arlHint }) {
  const { arlNombre, arlConfidence, records } = await runExtraction({ buffer, mime, filename, arlHint });
  const arlId = await arlIdByName(arlNombre);

  // Todo lo que hace falta para el lote entero, resuelto de una vez.
  const [registradas, catalogo] = await Promise.all([
    identidadesRegistradas(arlId, records),
    catalogoTiposOrden(),
  ]);

  const filas = records.map((rec) => {
    const fields = rec.fields;
    const { clave } = identidadDe(fields);
    // Dedup IMP-07/09 contra OS ya persistidas, según la identidad de la ARL:
    // AXA/Colmena por numero_orden; Bolívar por (cronograma + secuencia).
    const duplicadoDe = clave ? (registradas.get(clave) ?? null) : null;

    const metadata = {
      ...fields,
      overall_confidence: computeOverallConfidence(fields),
      engine: rec.engine,
      arl_confidence: arlConfidence,
      // Solo Excel: fila de la hoja de la que salió esta orden. La usa la vista
      // previa del documento para resaltarla junto a los campos extraídos.
      source_row: rec.sourceRow ?? null,
      // Solo Excel SIPAB: columnas que no son campos canónicos pero explican la
      // orden (unidad de medida, hora programada, póliza, departamento…).
      ...(rec.sipab ? { sipab: rec.sipab } : {}),
    };
    // Primero el título de la actividad, que es el dato limpio; si de ahí no
    // sale nada, el detalle. En el SIPAB de Bolívar el título es el nombre del
    // programa ("PROGRAMA DE ORDEN Y LIMPIEZA") y la palabra que dice qué se va
    // a hacer vive en las observaciones ("CAPACITACIÓN EN PELIGRO LOCATIVO"):
    // mirando solo el título, 94 de las 99 órdenes del SIPAB real entraban sin
    // tipo y había que elegirlo a mano una por una.
    const tipoOrdenId = tipoOrdenPorTexto(fields.tipo_actividad?.value, catalogo)
      ?? tipoOrdenPorTexto(fields.descripcion?.value, catalogo);

    // El borrador nace en PENDIENTE_REVISION: se queda en la vista previa de
    // Importar y NO entra a Órdenes hasta que el Admin confirme el lote
    // (POST /imports/:id/confirm). Así la revisión humana es obligatoria.
    return {
      confianza: metadata.overall_confidence,
      metadata,
      estado: duplicadoDe ? 'DUPLICADA' : 'PENDIENTE_REVISION',
      duplicadoDe,
      tipoOrdenId,
    };
  });

  // Un solo INSERT para todo el archivo, en vez de uno por orden.
  if (filas.length) {
    const params = [batchId, arlId];
    const values = filas.map((f) => {
      const i = params.length;
      params.push(f.confianza, f.metadata, f.estado, f.duplicadoDe, f.tipoOrdenId);
      return `($1,$2,$${i + 1},$${i + 2},$${i + 3},$${i + 4},$${i + 5})`;
    });
    await pool.query(
      `INSERT INTO sst.borradores_extraccion
         (lote_importacion_id, arl_id, confianza_general, metadatos_extraccion, estado, duplicado_de, tipo_orden_id)
       VALUES ${values.join(',')}`,
      params
    );
  }

  await pool.query(
    `UPDATE sst.lotes_importacion
       SET estado='PROCESADO', arl_detectada=$2, total_ordenes=$3
     WHERE id=$1`,
    [batchId, arlId, filas.length]
  );
}
