import { Router } from 'express';
import { pool, withTransaction } from '../../config/db.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authRequired, requireRole } from '../../middleware/auth.js';
import { uploadImport } from '../../middleware/upload.js';
import { badRequest, notFound } from '../../utils/httpError.js';
import { storage } from '../../services/storage.service.js';
import { readSheetPreview } from '../../services/extraction.service.js';
import { enqueueImport } from '../../queue/importQueue.js';
import { detectarOrdenExistente, hashArchivo, identidadDeOrden } from '../../services/dedup.service.js';
import { materializarOrden } from './drafts.routes.js';

const router = Router();
router.use(authRequired);

/**
 * IMP-09 · Traduce lo que devuelve el detector a lo que la vista necesita pintar.
 * El identificador se calcula aquí y no en el cliente: es el mismo criterio con
 * el que el pipeline decide qué es un duplicado.
 */
function avisoDeDuplicado({ archivo, deteccion }) {
  return {
    archivo,
    via: deteccion.via,
    ordenes: deteccion.ordenes.map((o) => ({
      id: o.id,
      identidad: identidadDeOrden(o),
      codigo: o.codigo,
      estado: o.estado,
      empresa_nombre: o.empresa_nombre,
      arl_nombre: o.arl_nombre,
      profesional_nombre: o.profesional_nombre,
      fecha_programada: o.fecha_programada,
      deshabilitado: o.deshabilitado,
    })),
  };
}

/**
 * IMP-09 · Comprobación PREVIA, sin IA: ¿este archivo trae una orden que ya
 * está en el sistema?
 *
 * Se llama al elegir los archivos, antes de "Procesar con IA". Nada se guarda:
 * ni lote, ni borrador, ni el archivo en disco — la respuesta es solo un
 * dictamen. Existe porque la comprobación equivalente se hacía DESPUÉS de la
 * extracción, y para entonces la petición de IA ya estaba gastada.
 */
router.post('/precheck', requireRole('admin'), uploadImport.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('Adjunta un archivo en el campo "file"');
  const { originalname, mimetype, buffer } = req.file;
  const deteccion = await detectarOrdenExistente({ buffer, mime: mimetype, filename: originalname });
  res.json({
    data: {
      existe: deteccion.existe,
      ...avisoDeDuplicado({ archivo: originalname, deteccion }),
    },
  });
}));

// IMP-01/02 · Subir archivo (Excel SIPAB o PDF). Responde de inmediato (NFR<2s).
router.post('/', requireRole('admin'), uploadImport.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('Adjunta un archivo en el campo "file"');
  const { originalname, mimetype, buffer } = req.file;

  // IMP-09 · Última barrera antes de gastar la petición de IA. La vista ya hace
  // esta comprobación al elegir el archivo, pero el gasto se decide aquí: un
  // cliente que no la haya hecho —o una pestaña abierta desde antes— no puede
  // colar un documento ya procesado.
  const deteccion = await detectarOrdenExistente({ buffer, mime: mimetype, filename: originalname });
  if (deteccion.existe) {
    return res.status(409).json({
      error: deteccion.ordenes.length === 1
        ? `Esta orden ya está en el sistema como ${deteccion.ordenes[0].codigo} (${deteccion.ordenes[0].estado}).`
        : `Las ${deteccion.ordenes.length} órdenes de este archivo ya están en el sistema.`,
      duplicado: avisoDeDuplicado({ archivo: originalname, deteccion }),
    });
  }

  const fileKey = await storage.put('imports', originalname, buffer);
  const batch = await pool.query(
    `INSERT INTO sst.lotes_importacion (subido_por, nombre_archivo, url_archivo, tipo_mime, estado, hash_archivo)
     VALUES ($1,$2,$3,$4,'PROCESANDO',$5) RETURNING *`,
    [req.user.sub, originalname, fileKey, mimetype, hashArchivo(buffer)]
  );
  const batchId = batch.rows[0].id;

  // Encola el pipeline IA (clasificación + extracción + dedup) en background.
  enqueueImport({ batchId, buffer, mime: mimetype, filename: originalname, arlHint: req.body?.arl || null });

  res.status(202).json({
    message: 'Archivo recibido. Procesando con IA…',
    batch: batch.rows[0],
  });
}));

// Lista de lotes de importación
router.get('/', asyncHandler(async (req, res) => {
  const r = await pool.query(
    `SELECT b.*, a.nombre AS arl_nombre, u.nombre AS subido_por_nombre
     FROM sst.lotes_importacion b
     LEFT JOIN sst.arls a ON a.id = b.arl_detectada
     LEFT JOIN sst.usuarios u ON u.id = b.subido_por
     ORDER BY b.creado_en DESC LIMIT 100`
  );
  res.json({ data: r.rows });
}));

// Estado del lote (para polling del frontend)
router.get('/:id/status', asyncHandler(async (req, res) => {
  const r = await pool.query(
    `SELECT id, estado, total_ordenes, mensaje_error FROM sst.lotes_importacion WHERE id=$1`,
    [req.params.id]
  );
  if (!r.rows[0]) throw notFound('Lote no encontrado');
  res.json({ data: r.rows[0] });
}));

// IMP-03 · Archivo ORIGINAL del lote, servido en línea (inline) para la vista
// previa del modal de revisión. El navegador renderiza los PDF de forma nativa;
// para Excel se usa /:id/sheet (abajo), que sí es legible en HTML.
router.get('/:id/file', asyncHandler(async (req, res) => {
  const r = await pool.query(
    `SELECT nombre_archivo, url_archivo, tipo_mime FROM sst.lotes_importacion WHERE id=$1`,
    [req.params.id]
  );
  const lote = r.rows[0];
  if (!lote) throw notFound('Lote no encontrado');
  if (!lote.url_archivo) throw notFound('El lote no conserva el archivo original');

  const buffer = await storage.get(lote.url_archivo);
  res.setHeader('Content-Type', lote.tipo_mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${lote.nombre_archivo || 'documento'}"`);
  res.send(buffer);
}));

// IMP-03 · Hoja del Excel original como texto plano, para pintarla al lado de
// los campos extraídos. Solo aplica a lotes de Excel (Bolívar / SIPAB).
router.get('/:id/sheet', asyncHandler(async (req, res) => {
  const r = await pool.query(
    `SELECT nombre_archivo, url_archivo, tipo_mime FROM sst.lotes_importacion WHERE id=$1`,
    [req.params.id]
  );
  const lote = r.rows[0];
  if (!lote) throw notFound('Lote no encontrado');
  if (!lote.url_archivo) throw notFound('El lote no conserva el archivo original');

  const esExcel = /sheet|excel/.test(lote.tipo_mime || '') || /\.(xlsx|xls)$/i.test(lote.nombre_archivo || '');
  if (!esExcel) throw badRequest('El archivo del lote no es una hoja de cálculo');

  const buffer = await storage.get(lote.url_archivo);
  const preview = await readSheetPreview(buffer);
  res.json({ data: { nombre_archivo: lote.nombre_archivo, ...preview } });
}));

// Detalle del lote + borradores extraídos.
//
// IMP-07/09 · Un borrador DUPLICADA viaja con la ficha de la OS que ya existe
// (código, estado, profesional y si está deshabilitada). Decir solo "duplicada"
// obliga a quien importa a ir a Órdenes a buscarla para entender por qué su
// archivo no entra; con el estado a la vista decide en el momento. El
// `deshabilitado` vive en el BORRADOR que materializó la OS, no en la OS: por
// eso se lee aparte, y con LIMIT 1 porque nada impide que dos borradores
// apunten a la misma orden.
router.get('/:id', asyncHandler(async (req, res) => {
  const b = await pool.query(`SELECT * FROM sst.lotes_importacion WHERE id=$1`, [req.params.id]);
  if (!b.rows[0]) throw notFound('Lote no encontrado');
  const borradores = await pool.query(
    `SELECT d.*, a.nombre AS arl_nombre,
            od.codigo             AS duplicado_codigo,
            od.estado::text       AS duplicado_estado,
            od.fecha_programada   AS duplicado_fecha_programada,
            od.fecha_carga        AS duplicado_fecha_carga,
            pd.nombre             AS duplicado_profesional,
            COALESCE((SELECT bd.deshabilitado
                        FROM sst.borradores_extraccion bd
                       WHERE bd.orden_servicio_id = od.id
                       ORDER BY bd.creado_en LIMIT 1), false) AS duplicado_deshabilitado
       FROM sst.borradores_extraccion d
       LEFT JOIN sst.arls a ON a.id = d.arl_id
       LEFT JOIN sst.ordenes_servicio od ON od.id = d.duplicado_de
       LEFT JOIN sst.profesionales pd ON pd.id = od.profesional_asignado_id
      WHERE d.lote_importacion_id=$1 ORDER BY d.creado_en`,
    [req.params.id]
  );
  res.json({ data: { ...b.rows[0], borradores: borradores.rows } });
}));

// IMP-04 · Confirmar el lote tras la revisión humana en la vista previa.
// Cada borrador se MATERIALIZA como OS en estado SIN PROGRAMAR (IMP-07): la
// revisión ya se hizo aquí, campo por campo contra el documento, así que la
// orden entra a la bandeja lista para asignar y no vuelve a pedir un "validar".
// Los DUPLICADA no se tocan.
router.post('/:id/confirm', requireRole('admin'), asyncHandler(async (req, res) => {
  const lote = await pool.query(`SELECT id FROM sst.lotes_importacion WHERE id=$1`, [req.params.id]);
  if (!lote.rows[0]) throw notFound('Lote no encontrado');

  // La fecha de vencimiento es obligatoria: es el dato con el que se prioriza la
  // orden en la bandeja, y una vez confirmada ya no se vuelve a pedir. Si la IA
  // no la encontró, se diligencia en la vista previa antes de confirmar.
  const sinVencimiento = await pool.query(
    `SELECT coalesce(metadatos_extraccion->'empresa_nombre'->>'value', 'Sin nombre') AS empresa
       FROM sst.borradores_extraccion
      WHERE lote_importacion_id=$1
        AND estado='PENDIENTE_REVISION'
        AND btrim(coalesce(metadatos_extraccion->'fecha_vencimiento'->>'value', '')) = ''`,
    [req.params.id]
  );
  if (sinVencimiento.rowCount) {
    const nombres = sinVencimiento.rows.slice(0, 3).map((x) => x.empresa).join(', ');
    const resto = sinVencimiento.rowCount > 3 ? ` y ${sinVencimiento.rowCount - 3} más` : '';
    throw badRequest(
      `${sinVencimiento.rowCount} orden(es) no tienen fecha de vencimiento: ${nombres}${resto}. Diligénciela antes de guardar.`
    );
  }

  // CFG-04 · Y el tipo de orden, por lo mismo: es obligatorio y sin él la OS no
  // sabría con qué valor hora se cobra.
  const sinTipo = await pool.query(
    `SELECT coalesce(metadatos_extraccion->'empresa_nombre'->>'value', 'Sin nombre') AS empresa
       FROM sst.borradores_extraccion
      WHERE lote_importacion_id=$1 AND estado='PENDIENTE_REVISION' AND tipo_orden_id IS NULL`,
    [req.params.id]
  );
  if (sinTipo.rowCount) {
    const nombres = sinTipo.rows.slice(0, 3).map((x) => x.empresa).join(', ');
    const resto = sinTipo.rowCount > 3 ? ` y ${sinTipo.rowCount - 3} más` : '';
    throw badRequest(
      `${sinTipo.rowCount} orden(es) no tienen tipo de orden: ${nombres}${resto}. ` +
      'Elíjalo antes de guardar: de él sale el valor hora con el que se cobra la visita.'
    );
  }

  const pendientes = await pool.query(
    `SELECT id FROM sst.borradores_extraccion
      WHERE lote_importacion_id=$1 AND estado='PENDIENTE_REVISION'
      ORDER BY creado_en`,
    [req.params.id]
  );
  // Sin pendientes NO es un error: significa que las órdenes de este archivo ya
  // se guardaron (de a una, con el botón de la fila, o en un intento anterior).
  // Antes esto respondía 400 y hacía fracasar el "Guardar todo" completo aunque
  // el resto de archivos estuviera bien; el usuario veía un fallo donde en
  // realidad no quedaba nada por hacer.
  if (!pendientes.rowCount) {
    const ya = await pool.query(
      `SELECT count(*)::int AS n FROM sst.borradores_extraccion
        WHERE lote_importacion_id=$1 AND estado='VALIDADA'`,
      [req.params.id]
    );
    return res.json({
      message: ya.rows[0].n
        ? `Las ${ya.rows[0].n} orden(es) de este archivo ya estaban guardadas.`
        : 'Este archivo no tiene órdenes por guardar.',
      data: { confirmadas: 0, ya_guardadas: ya.rows[0].n, codigos: [], fallidas: [] },
    });
  }

  // Cada orden se materializa en SU PROPIA transacción, no todas en una.
  // Un lote SIPAB trae decenas: si una sola choca (una identidad que se coló
  // duplicada entre la extracción y ahora), con una transacción única se caerían
  // las cuarenta. Así entran las que puedan y se informa de las que no.
  const creadas = [];
  const fallidas = [];
  for (const { id } of pendientes.rows) {
    try {
      const orden = await withTransaction((client) => materializarOrden(id, req.user.sub, client));
      creadas.push(orden.codigo);
    } catch (e) {
      fallidas.push(e?.message || 'No se pudo crear la OS');
    }
  }

  if (!creadas.length) {
    throw badRequest(`Ninguna orden pudo guardarse. ${fallidas[0] ?? ''}`.trim());
  }
  res.json({
    message: fallidas.length
      ? `${creadas.length} orden(es) guardada(s) en Órdenes; ${fallidas.length} no se pudieron guardar.`
      : `${creadas.length} orden(es) guardada(s) en Órdenes como SIN PROGRAMAR.`,
    data: { confirmadas: creadas.length, codigos: creadas, fallidas },
  });
}));

// Descartar el lote completo sin enviarlo a Órdenes (los borradores quedan
// DESCARTADA; el archivo original se conserva para auditoría).
router.post('/:id/discard', requireRole('admin'), asyncHandler(async (req, res) => {
  const lote = await pool.query(`SELECT id FROM sst.lotes_importacion WHERE id=$1`, [req.params.id]);
  if (!lote.rows[0]) throw notFound('Lote no encontrado');

  const r = await pool.query(
    `UPDATE sst.borradores_extraccion
        SET estado='DESCARTADA', actualizado_en=now()
      WHERE lote_importacion_id=$1 AND estado='PENDIENTE_REVISION'
      RETURNING id`,
    [req.params.id]
  );
  res.json({
    message: `${r.rowCount} orden(es) descartada(s).`,
    data: { descartadas: r.rowCount },
  });
}));

export default router;
