import { Router } from 'express';
import { pool, withTransaction } from '../../config/db.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authRequired, requireRole } from '../../middleware/auth.js';
import { badRequest, notFound, conflict } from '../../utils/httpError.js';
import { computeOverallConfidence } from '../../services/extraction.service.js';
import { CAMPOS_BORRADOR } from '../../services/gemini.service.js';
import { resolverEmpresaId } from '../companies/companies.service.js';
// Los mismos parsers los usa la edición de una OS ya materializada
// (`PUT /orders/:id`): viven en utils para que no puedan divergir.
import { parseNumeroCO, parseFechaCO } from '../../utils/parseo.js';
import {
  esBolivar, normalizarModalidadEjecucion, normalizarTipoActividadBolivar,
} from '../../utils/bolivar.js';

const router = Router();
router.use(authRequired);

// SELECT base con nombres legibles (ARL, archivo del lote y profesional asignado).
//
// Se trae también el estado de la OS materializada (`os_estado`/`os_codigo`): la
// vista Órdenes muestra en la misma fila el borrador y, una vez validado, el
// ciclo de vida real de la orden (SIN PROGRAMAR → … → EJECUTADA). Es NULL
// mientras el borrador siga pendiente de validar.
// La asignación real (M5) vive en la OS, no en el borrador: por eso se traen
// también su profesional y su fecha programada, que son los que valen una vez
// materializada la orden.
const DRAFT_SELECT = `
  SELECT d.*, a.nombre AS arl_nombre, b.nombre_archivo, b.tipo_mime,
         p.nombre AS profesional_nombre,
         o.estado::text AS os_estado, o.codigo AS os_codigo,
         o.fecha_programada AS os_fecha_programada,
         o.profesional_asignado_id AS os_profesional_id,
         po.nombre AS os_profesional_nombre,
         -- Con la OS ya materializada, la empresa que vale es la suya: es la que
         -- se corrige desde el detalle (PUT /orders/:id) y la que sale en los
         -- formatos y los correos. El nombre del borrador es lo que leyó la IA
         -- del documento, y tras una corrección deja de ser cierto.
         o.empresa_nombre AS os_empresa_nombre,
         -- CFG-04 · La categoría con la que se cobra. Manda la de la OS cuando
         -- existe: el borrador es lo que se eligió al importar, y la orden pudo
         -- corregirse después.
         COALESCE(o.tipo_orden_id, d.tipo_orden_id) AS tipo_orden_id,
         tp.nombre AS tipo_orden,
         o.valor_hora_cobro, o.valor_hora_origen, o.valor_cobro_total,
         -- Viáticos: la categoría elegida (NULL = "No aplica") y su valor. Manda
         -- la de la OS cuando existe, igual que con el tipo de orden. El importe
         -- que se enseña es el CONGELADO en la orden, no el vigente del
         -- catálogo: si mañana sube la categoría, la orden ya cargada no cambia.
         COALESCE(o.viaticos_tipo_id, d.tipo_viatico_id) AS tipo_viatico_id,
         tv.nombre AS tipo_viatico,
         tv.valor  AS tipo_viatico_valor,
         o.viaticos_valor AS os_viaticos_valor,
         -- ASG · A nombre de quién salen los formatos cuando no es el ejecutor.
         -- La vista Órdenes lo enseña en la fila para que la suplencia no sea
         -- invisible: es un dato que hay que poder ver sin abrir la orden.
         o.profesional_formatos_id AS os_profesional_formatos_id,
         pfo.nombre AS os_profesional_formatos_nombre,
         -- Eje de facturación (ago-2026): columna, pastilla y filtro de Órdenes.
         o.estado_cobro::text AS os_estado_cobro,
         o.cobro_numero_factura AS os_cobro_numero_factura
  FROM sst.borradores_extraccion d
  LEFT JOIN sst.arls a ON a.id = d.arl_id
  LEFT JOIN sst.lotes_importacion b ON b.id = d.lote_importacion_id
  LEFT JOIN sst.profesionales p ON p.id = d.profesional_asignado_id
  LEFT JOIN sst.ordenes_servicio o ON o.id = d.orden_servicio_id
  LEFT JOIN sst.profesionales po ON po.id = o.profesional_asignado_id
  LEFT JOIN sst.profesionales pfo ON pfo.id = o.profesional_formatos_id
  LEFT JOIN sst.tipos_orden tp ON tp.id = COALESCE(o.tipo_orden_id, d.tipo_orden_id)
  LEFT JOIN sst.tipos_viatico tv ON tv.id = COALESCE(o.viaticos_tipo_id, d.tipo_viatico_id)`;

// Vista "Órdenes" (M3). Filtrable por estado y por soft-delete.
//   ?estado=PENDIENTE_VALIDACION | VALIDADA | ... | ALL
//   Admite varios separados por coma: ?estado=PENDIENTE_VALIDACION,VALIDADA.
//   La vista Órdenes los necesita juntos: una orden validada ya no está
//   pendiente, pero sigue viviendo en la bandeja con otro estado.
//   ?deshabilitado=false (por defecto) | true | all
router.get('/', asyncHandler(async (req, res) => {
  const estado = req.query.estado || req.query.status || 'PENDIENTE_VALIDACION';
  const desh = String(req.query.deshabilitado ?? 'false').toLowerCase();

  const estados = String(estado).split(',').map((s) => s.trim()).filter(Boolean);
  const params = [estados];
  let filtroDesh = 'AND d.deshabilitado = false';
  if (desh === 'true') filtroDesh = 'AND d.deshabilitado = true';
  else if (desh === 'all') filtroDesh = '';

  // Comparación como texto (no como enum): un estado inexistente simplemente no
  // devuelve filas, en vez de romper la consulta con un error de casteo.
  const r = await pool.query(
    `${DRAFT_SELECT}
     WHERE ('ALL' = ANY($1::text[]) OR d.estado::text = ANY($1::text[]))
     ${filtroDesh}
     ORDER BY d.creado_en DESC`,
    params
  );
  res.json({ data: r.rows });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const r = await pool.query(`${DRAFT_SELECT} WHERE d.id=$1`, [req.params.id]);
  if (!r.rows[0]) throw notFound('Borrador no encontrado');
  res.json({ data: r.rows[0] });
}));

/** Recarga un borrador expandido (helper para respuestas tras un cambio). */
async function loadDraftExpanded(id, client = pool) {
  const r = await client.query(`${DRAFT_SELECT} WHERE d.id=$1`, [id]);
  return r.rows[0] || null;
}

// ASG · Asignar profesional al borrador (asignación ligera antes de materializar).
router.post('/:id/assign', requireRole('admin'), asyncHandler(async (req, res) => {
  const profesionalId = req.body?.profesional_id || req.body?.professional_id;
  const fechaProgramada = req.body?.fecha_programada || req.body?.scheduled_at || null;
  if (!profesionalId) throw badRequest('profesional_id es obligatorio');

  const prof = await pool.query(`SELECT id, estado FROM sst.profesionales WHERE id=$1`, [profesionalId]);
  if (!prof.rows[0]) throw badRequest('Profesional no existe');
  if (prof.rows[0].estado !== 'Activo') throw badRequest('El profesional está Inactivo');

  const upd = await pool.query(
    `UPDATE sst.borradores_extraccion
       SET profesional_asignado_id=$2, fecha_programada=$3
     WHERE id=$1 AND deshabilitado=false
     RETURNING id`,
    [req.params.id, profesionalId, fechaProgramada]
  );
  if (!upd.rows[0]) throw notFound('Borrador no encontrado o deshabilitado');

  res.json({ message: 'Profesional asignado a la orden.', data: await loadDraftExpanded(req.params.id) });
}));

// SOFT-DELETE · Deshabilitar (inactivar) el borrador sin borrarlo físicamente.
router.patch('/:id/disable', requireRole('admin'), asyncHandler(async (req, res) => {
  const r = await pool.query(
    `UPDATE sst.borradores_extraccion
       SET deshabilitado=true, deshabilitado_en=now(), deshabilitado_por=$2
     WHERE id=$1 AND deshabilitado=false
     RETURNING id`,
    [req.params.id, req.user.sub]
  );
  if (!r.rows[0]) throw notFound('Borrador no encontrado o ya deshabilitado');
  res.json({ message: 'Orden deshabilitada.', data: await loadDraftExpanded(req.params.id) });
}));

// Restaurar un borrador deshabilitado.
router.patch('/:id/enable', requireRole('admin'), asyncHandler(async (req, res) => {
  const r = await pool.query(
    `UPDATE sst.borradores_extraccion
       SET deshabilitado=false, deshabilitado_en=NULL, deshabilitado_por=NULL
     WHERE id=$1 AND deshabilitado=true
     RETURNING id`,
    [req.params.id]
  );
  if (!r.rows[0]) throw notFound('Borrador no encontrado o ya activo');
  res.json({ message: 'Orden restaurada.', data: await loadDraftExpanded(req.params.id) });
}));

// IMP-03/04 · Guardar correcciones manuales del split-view (sin validar aún).
router.put('/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const { fields } = req.body || {}; // { codigo_cronograma: {value, confidence}, ... }
  // CFG-04 · El tipo de orden viaja aparte de `fields`: no lo dice el documento
  // de la ARL, lo decide quien revisa, y por eso vive en su propia columna y no
  // en el JSON de la extracción.
  const tipoOrdenId = req.body?.tipo_orden_id === undefined
    ? undefined
    : (String(req.body.tipo_orden_id ?? '').trim() || null);
  // Los viáticos, igual: se ELIGEN de un catálogo (`sst.tipos_viatico`), no se
  // escriben. null es "No aplica" y es un valor legítimo —el más frecuente—, por
  // eso se distingue de "no vino en el cuerpo" con undefined.
  const tipoViaticoId = req.body?.tipo_viatico_id === undefined
    ? undefined
    : (String(req.body.tipo_viatico_id ?? '').trim() || null);
  if (!fields && tipoOrdenId === undefined && tipoViaticoId === undefined) {
    throw badRequest('Envía "fields" con los campos editados, "tipo_orden_id" o "tipo_viatico_id".');
  }
  if (tipoViaticoId) {
    const tv = await pool.query(`SELECT id FROM sst.tipos_viatico WHERE id=$1 AND activo`, [tipoViaticoId]);
    if (!tv.rows[0]) throw badRequest('El tipo de viático no existe o fue retirado del catálogo.');
  }
  if (fields && typeof fields !== 'object') throw badRequest('"fields" debe ser un objeto');
  const cur = await pool.query(
    `SELECT d.metadatos_extraccion, d.estado::text AS estado, o.codigo AS os_codigo
       FROM sst.borradores_extraccion d
       LEFT JOIN sst.ordenes_servicio o ON o.id = d.orden_servicio_id
      WHERE d.id=$1`,
    [req.params.id]
  );
  if (!cur.rows[0]) throw notFound('Borrador no encontrado');

  // Un borrador YA VALIDADO no se edita: su OS existe y es la que manda. Antes
  // el UPDATE se aceptaba y escribía en un JSON que ya no lee nadie, así que la
  // corrección se "guardaba" sin efecto y el usuario se quedaba creyendo que el
  // cambio estaba hecho. Caso real: se corrigió el correo del contacto SST
  // sobre un borrador ya validado y la OS conservó el anterior.
  if (cur.rows[0].estado === 'VALIDADA') {
    throw conflict(
      `Esta orden ya se guardó en Órdenes${cur.rows[0].os_codigo ? ` como ${cur.rows[0].os_codigo}` : ''}. ` +
      'Los cambios ya no se hacen aquí: ábrala en Órdenes para editarla.'
    );
  }

  const merged = { ...cur.rows[0].metadatos_extraccion };
  for (const f of fields ? CAMPOS_BORRADOR : []) {
    if (fields[f]) {
      merged[f] = {
        value: fields[f].value ?? merged[f]?.value ?? '',
        // Corregido a mano ⇒ confianza 100 salvo que se envíe otra.
        confidence: fields[f].confidence ?? 100,
      };
    }
  }
  merged.overall_confidence = computeOverallConfidence(merged);
  const r = await pool.query(
    `UPDATE sst.borradores_extraccion
       SET metadatos_extraccion=$2, confianza_general=$3,
           tipo_orden_id   = CASE WHEN $4::boolean THEN $5::uuid ELSE tipo_orden_id END,
           tipo_viatico_id = CASE WHEN $6::boolean THEN $7::uuid ELSE tipo_viatico_id END,
           actualizado_en=now()
     WHERE id=$1 RETURNING id`,
    [req.params.id, merged, merged.overall_confidence,
      tipoOrdenId !== undefined, tipoOrdenId ?? null,
      tipoViaticoId !== undefined, tipoViaticoId ?? null]
  );
  if (!r.rows[0]) throw notFound('Borrador no encontrado');
  // Se devuelve expandido (arl_nombre, archivo, profesional) para que el cliente
  // pueda reemplazar la fila sin perder los campos derivados del JOIN.
  res.json({ data: await loadDraftExpanded(req.params.id) });
}));

/**
 * Clave del cerrojo con el que se reparte el código legible de la OS. Es un
 * número arbitrario: lo único que importa es que nadie más use el mismo par
 * (clave, año) en `pg_advisory_xact_lock`.
 */
const CERROJO_CODIGO_OS = 8471;

/**
 * Siguiente código legible OS-YYYY-NNNN.
 *
 * Se calculaba con `count(*) + 1` y sin cerrojo, y eso fallaba de dos maneras,
 * las dos con el mismo síntoma: *duplicate key value violates unique constraint
 * "ordenes_servicio_codigo_key"*, media tanda guardada y la otra media no.
 *
 *  1. **Dos confirmaciones a la vez.** La vista de Importar manda una petición
 *     por ARCHIVO, así que una tanda de dos archivos confirma en paralelo: las
 *     dos transacciones contaban lo mismo —ninguna ve las filas sin confirmar de
 *     la otra—, sacaban el mismo número y la segunda moría contra el índice
 *     único. Nada que ver con el NIT ni con la empresa: dos órdenes de la misma
 *     empresa siempre se han podido guardar.
 *  2. **Contar no es numerar.** `count(*)` da el número de filas, no el último
 *     número usado: basta con que se borre una orden —o con que convivan las
 *     sembradas de demostración (OS-2026-1001…)— para que el conteo apunte a un
 *     código que ya existe, y entonces el choque es permanente.
 *
 * Ahora el reparto va bajo un cerrojo por año (se libera solo al terminar la
 * transacción) y se parte del MÁXIMO ya usado, nunca del conteo: los códigos no
 * se repiten ni se reutilizan aunque se borre una orden.
 */
async function siguienteCodigoOS(client) {
  const year = new Date().getFullYear();
  await client.query(`SELECT pg_advisory_xact_lock($1, $2)`, [CERROJO_CODIGO_OS, year]);
  const r = await client.query(
    `SELECT COALESCE(MAX(split_part(codigo, '-', 3)::int), 0) AS n
       FROM sst.ordenes_servicio
      WHERE codigo ~ ('^OS-' || $1 || '-[0-9]+$')`,
    [String(year)]
  );
  return `OS-${year}-${String(r.rows[0].n + 1).padStart(4, '0')}`;
}

/**
 * M3 · Materializa la OS a partir de un borrador: la crea con estado
 * SIN PROGRAMAR (IMP-07) y escribe la primera entrada de auditoría.
 *
 * Vive aparte de la ruta porque tiene DOS llamadores: la validación manual
 * (`POST /drafts/:id/validate`) y la confirmación desde Importar, que desde
 * ago-2026 valida sola. La revisión de fondo ya se hizo en la vista previa —
 * campo por campo, contra el documento original—, así que volver a pedir un
 * "validar" en la bandeja era pedir dos veces lo mismo.
 */
export async function materializarOrden(draftId, userId, client) {
  const dr = await client.query(
    `SELECT * FROM sst.borradores_extraccion WHERE id=$1 FOR UPDATE`, [draftId]
  );
  const draft = dr.rows[0];
  if (!draft) throw notFound('Borrador no encontrado');
  if (draft.estado === 'VALIDADA') throw conflict('El borrador ya fue validado');
  if (!draft.arl_id) throw badRequest('El borrador no tiene ARL detectada');
  // CFG-04 · Sin tipo de orden no se puede crear: es lo que decide el valor hora
  // con el que se le pagará al profesional, y descubrirlo al generar la cuenta
  // de cobro —tres pantallas más adelante— es demasiado tarde.
  if (!draft.tipo_orden_id) {
    throw badRequest(
      'Falta el tipo de orden. Elíjalo en la vista previa: de él sale el valor hora con el que se cobra la visita.',
    );
  }

  const m = draft.metadatos_extraccion || {};
  const val = (f) => (m[f]?.value ?? null) || null;
  const numeroOrden = val('numero_orden');
  const cron = val('codigo_cronograma');
  const sec = val('secuencia');

  // FOR · Los dos enumerados del AT-031 de Bolívar. La letra la trae el SIPAB;
  // la modalidad la escribe quien revisa y es OBLIGATORIA en esa ARL, porque de
  // ella depende qué formatos se adjuntan: el comunicado de la ARL admite el
  // AT-031 en presencial y en virtual, pero el AT-028 solo en presencial.
  // Descubrirlo al asignar —cuando el correo ya va camino del profesional— es
  // demasiado tarde, así que se exige aquí, igual que el tipo de orden.
  // Viáticos (ago-2026): la cifra ya NO se escribe a mano. Sale de la categoría
  // elegida en la vista previa (`sst.tipos_viatico`), y se congela en la orden
  // para que un cambio posterior del catálogo no reescriba lo ya cargado.
  //
  // Sin categoría —"No aplica"— la orden queda sin viáticos, que es el caso de
  // casi todas. Lo que el SIPAB de Bolívar traía se conserva igualmente en
  // `viaticos_detalle`: es el desglose con el que se justifica la cifra ante la
  // ARL, y perderlo dejaría el importe sin explicación.
  const tipoViatico = draft.tipo_viatico_id
    ? (await client.query(
        `SELECT id, nombre, valor FROM sst.tipos_viatico WHERE id=$1`, [draft.tipo_viatico_id]
      )).rows[0]
    : null;
  const viaticos = tipoViatico ? Number(tipoViatico.valor) : null;
  const detalleViaticos = m.sipab?.viaticos?.detalle ?? null;

  const tipoServicioArl = normalizarTipoActividadBolivar(val('tipo_servicio_arl'));
  const modalidadEjecucion = normalizarModalidadEjecucion(val('modalidad_ejecucion'));
  const arl = await client.query(`SELECT nombre FROM sst.arls WHERE id=$1`, [draft.arl_id]);
  if (esBolivar(arl.rows[0]?.nombre) && !modalidadEjecucion) {
    throw badRequest(
      'Falta indicar si la actividad es presencial o virtual. Elíjalo en la vista previa: ' +
      'de ello depende qué formatos de Bolívar se le envían al profesional.',
    );
  }

  // Identidad por ARL: Bolívar usa cronograma+secuencia; AXA/Colmena, numero_orden.
  if (!numeroOrden && !(cron && sec)) {
    throw badRequest('La OS necesita numero_orden, o bien codigo_cronograma + secuencia');
  }

  // Dedup IMP-09 según la identidad disponible (defensa adicional al índice UNIQUE).
  if (numeroOrden) {
    const dup = await client.query(
      `SELECT id FROM sst.ordenes_servicio WHERE arl_id=$1 AND numero_orden=$2`,
      [draft.arl_id, numeroOrden]
    );
    if (dup.rows[0]) throw conflict('OS duplicada por (ARL + número de orden)');
  } else {
    const dup = await client.query(
      `SELECT id FROM sst.ordenes_servicio WHERE arl_id=$1 AND codigo_cronograma=$2 AND secuencia=$3`,
      [draft.arl_id, cron, sec]
    );
    if (dup.rows[0]) throw conflict('OS duplicada por (ARL + cronograma + secuencia)');
  }

  const codigo = await siguienteCodigoOS(client);

  // CFG-02 · La OS queda enlazada al maestro de empresas, creando la ficha si
  // la empresa es nueva. Los textos (nit_nic / empresa_nombre) se conservan
  // igual: son el dato histórico de lo que decía el documento de la ARL.
  const empresaId = await resolverEmpresaId({
    nit: val('nit_nic'),
    nombre: val('empresa_nombre'),
    actividad_economica: val('actividad_economica'),
    ciudad: val('ciudad_ejecucion'),
    direccion: val('direccion'),
    contacto_nombre: val('contacto_empresa_nombre'),
    contacto_cargo: val('contacto_empresa_cargo'),
    contacto_telefono: val('contacto_empresa_telefono'),
    contacto_sst_nombre: val('contacto_sst_nombre'),
    contacto_sst_telefono: val('contacto_sst_telefono'),
    contacto_sst_correo: val('contacto_sst_correo'),
  }, client);

  const ord = await client.query(
    `INSERT INTO sst.ordenes_servicio (
       codigo, arl_id, numero_orden, codigo_cronograma, secuencia, nro_afiliacion,
       nit_nic, empresa_nombre, empresa_id, actividad_economica, tipo_actividad, tipo_orden_id, modalidad,
       tipo_servicio_arl, modalidad_ejecucion, viaticos_valor, viaticos_detalle,
       horas_asignadas, valor_unitario, valor_total,
       fecha_orden, fecha_vencimiento, ciudad_ejecucion, direccion, descripcion,
       contacto_empresa_nombre, contacto_empresa_cargo, contacto_empresa_telefono,
       contacto_sst_nombre, contacto_sst_telefono, contacto_sst_correo,
       lote_importacion_id, url_archivo_original, metadatos_extraccion, viaticos_tipo_id, estado)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
             $20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,'SIN PROGRAMAR')
     RETURNING *`,
    [
      codigo, draft.arl_id, numeroOrden, cron, sec, val('nro_afiliacion'),
      val('nit_nic'), val('empresa_nombre'), empresaId, val('actividad_economica'),
      val('tipo_actividad'), draft.tipo_orden_id, val('modalidad'),
      tipoServicioArl, modalidadEjecucion,
      // Sin categoría queda NULL; con categoría se guarda su valor tal cual,
      // aunque sea 0: la orden apunta al tipo y el importe tiene que cuadrar con
      // él, no desaparecer por ser cero.
      viaticos,
      detalleViaticos ? JSON.stringify(detalleViaticos) : null,
      parseNumeroCO(val('horas_asignadas')), parseNumeroCO(val('valor_unitario')),
      parseNumeroCO(val('valor_total')),
      parseFechaCO(val('fecha_orden')), parseFechaCO(val('fecha_vencimiento')),
      val('ciudad_ejecucion'), val('direccion'), val('descripcion'),
      val('contacto_empresa_nombre'), val('contacto_empresa_cargo'), val('contacto_empresa_telefono'),
      val('contacto_sst_nombre'), val('contacto_sst_telefono'), val('contacto_sst_correo'),
      draft.lote_importacion_id, draft.url_archivo_original, m,
      tipoViatico ? tipoViatico.id : null,
    ]
  );
  const orden = ord.rows[0];

  // Primera entrada de auditoría (EST-03): creación → SIN PROGRAMAR.
  await client.query(
    `INSERT INTO sst.historial_estados_orden (orden_id, estado_anterior, estado_nuevo, cambiado_por, motivo)
     VALUES ($1, NULL, 'SIN PROGRAMAR', $2, 'Validación IA — creación de OS')`,
    [orden.id, userId]
  );

  await client.query(
    `UPDATE sst.borradores_extraccion SET estado='VALIDADA', orden_servicio_id=$2 WHERE id=$1`,
    [draft.id, orden.id]
  );
  return orden;
}

// M3 · "Validar y Guardar" manual. Se conserva para las órdenes que ya estaban
// en la bandeja como PENDIENTE_VALIDACION antes del cambio de ago-2026; las
// nuevas llegan validadas desde Importar y nunca pasan por aquí.
router.post('/:id/validate', requireRole('admin'), asyncHandler(async (req, res) => {
  const result = await withTransaction((client) => materializarOrden(req.params.id, req.user.sub, client));
  res.status(201).json({ message: 'OS validada y guardada', data: result });
}));

// IMP-04 · Enviar a Órdenes UN solo borrador revisado, sin arrastrar el resto
// del lote. Un SIPAB trae decenas de órdenes y revisarlas todas antes de poder
// guardar cualquiera obliga a hacerlo de una sentada; así se van cerrando de a
// una y lo que quede a medias sigue en la vista previa.
//
// Confirmar YA VALIDA: la OS se materializa aquí mismo y entra a la bandeja
// como SIN PROGRAMAR (IMP-07), lista para asignarle profesional y horario.
// Antes quedaba PENDIENTE_VALIDACION y había que volver a "validarla" en
// Órdenes, un segundo repaso de lo mismo que se acababa de revisar campo por
// campo en la vista previa. Sin fecha de vencimiento no entra: después ya no se
// vuelve a pedir y la orden quedaría sin fecha de control.
router.post('/:id/confirm', requireRole('admin'), asyncHandler(async (req, res) => {
  const orden = await withTransaction(async (client) => {
    const cur = await client.query(
      `SELECT estado::text AS estado, metadatos_extraccion, orden_servicio_id
         FROM sst.borradores_extraccion WHERE id=$1 FOR UPDATE`,
      [req.params.id]
    );
    const draft = cur.rows[0];
    if (!draft) throw notFound('Borrador no encontrado');
    if (draft.estado === 'DUPLICADA') throw conflict('La orden ya existe: no se puede enviar a Órdenes');
    // Ya guardada (doble clic, reintento tras un error de red, o el usuario que
    // no vio el aviso de éxito): NO es un fallo. Se responde con la OS que se
    // creó para que la vista quite la fila igual que en el camino normal. Antes
    // devolvía 400 "ya no está pendiente de revisión", que sonaba a que algo
    // había ido mal cuando en realidad estaba hecho.
    if (draft.estado === 'VALIDADA') {
      const os = await client.query(
        `SELECT * FROM sst.ordenes_servicio WHERE id=$1`, [draft.orden_servicio_id]
      );
      return { orden: os.rows[0], yaEstaba: true };
    }
    if (draft.estado !== 'PENDIENTE_REVISION') {
      throw badRequest(
        `Esta orden está en estado ${draft.estado} y ya no se puede enviar a Órdenes.`
      );
    }
    if (!String(draft.metadatos_extraccion?.fecha_vencimiento?.value ?? '').trim()) {
      throw badRequest('La orden no tiene fecha de vencimiento. Diligénciela antes de guardar.');
    }
    return { orden: await materializarOrden(req.params.id, req.user.sub, client), yaEstaba: false };
  });

  res.status(orden.yaEstaba ? 200 : 201).json({
    message: orden.yaEstaba
      ? `${orden.orden?.codigo ?? 'Esta orden'} ya estaba guardada en Órdenes.`
      : `${orden.orden.codigo} entró a Órdenes como SIN PROGRAMAR.`,
    ya_estaba: orden.yaEstaba,
    data: orden.orden,
  });
}));

// Descartar un borrador
router.post('/:id/discard', requireRole('admin'), asyncHandler(async (req, res) => {
  const r = await pool.query(
    `UPDATE sst.borradores_extraccion SET estado='DESCARTADA'
     WHERE id=$1 AND estado <> 'VALIDADA' RETURNING id, estado`,
    [req.params.id]
  );
  if (!r.rows[0]) throw notFound('Borrador no encontrado o ya validado');
  res.json({ data: r.rows[0] });
}));

export default router;
