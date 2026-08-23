import { Router } from 'express';
import { pool, withTransaction } from '../../config/db.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { uploadSupports } from '../../middleware/upload.js';
import { badRequest, notFound } from '../../utils/httpError.js';
import { storage } from '../../services/storage.service.js';
import { changeStatus } from '../orders/orders.service.js';
import { notifyAdmins } from '../../services/notification.service.js';
import { registrarRespuesta, resolverToken as resolverEncuesta } from '../surveys/surveys.service.js';
import {
  enPesos, periodoLargo, resolverToken as resolverPrecuenta, responderPrecuenta,
} from '../billing/billing.service.js';
import { notify } from '../../services/notification.service.js';
import { comprimirSoporte } from '../../services/compress.service.js';
import {
  casillasDeOrden, etiquetaCategoria, listaEtiquetas, normalizarCategoria,
  nombreCanonico, nombreOriginalLegible,
} from '../../services/soportes.service.js';

const router = Router();

// Resuelve un token de enlace público activo → OS asociada.
async function resolveToken(token, client = pool) {
  const r = await client.query(
    `SELECT pl.id AS enlace_id, pl.activo, pl.expira_en, o.*
     FROM sst.enlaces_publicos pl JOIN sst.ordenes_servicio o ON o.id = pl.orden_id
     WHERE pl.token=$1`, [token]
  );
  const row = r.rows[0];
  // Quien lee esto es el profesional en el móvil, sin nadie a quien preguntar:
  // el mensaje tiene que decirle qué pasó y a quién acudir, no solo que falló.
  if (!row) {
    throw notFound('Este enlace no corresponde a ninguna orden. Compruebe que lo abrió completo desde el correo.');
  }
  if (!row.activo) {
    throw badRequest(
      'Este enlace ya se cerró: los soportes de esta visita ya fueron revisados. ' +
      'Si necesita enviar algo más, pídale al equipo administrativo que lo reabra.',
    );
  }
  if (row.expira_en && new Date(row.expira_en) < new Date()) {
    throw badRequest('Este enlace venció. Pídale uno nuevo al equipo administrativo.');
  }
  return row;
}

// M6 · Resumen de la OS para el portal público (SIN login).
//
// SUP-07 / VER-04 · Viaja también lo que YA subió y, si hubo rechazo, qué
// documentos se le devolvieron. El profesional abría el enlace del correo de
// rechazo y encontraba las casillas vacías, sin rastro de lo que había mandado:
// no podía comparar lo que envió con lo que le piden, que es justamente lo que
// necesita para corregirlo.
router.get('/support/:token', asyncHandler(async (req, res) => {
  const row = await resolveToken(req.params.token);
  const arl = await pool.query(`SELECT nombre FROM sst.arls WHERE id=$1`, [row.arl_id]);
  const files = await pool.query(
    `SELECT id, nombre_archivo, nombre_original, categoria, mime, tamano_bytes, subido_en
       FROM sst.archivos_soporte WHERE orden_id=$1 ORDER BY subido_en`,
    [row.id]
  );
  const rechazados = row.soportes_rechazados || null;
  res.json({
    data: {
      codigo: row.codigo,
      empresa_nombre: row.empresa_nombre,
      arl_nombre: arl.rows[0]?.nombre,
      actividad_economica: row.actividad_economica,
      horas_asignadas: row.horas_asignadas,
      fecha_programada: row.fecha_programada,
      estado: row.estado,
      // SUP · Las casillas de ESTA orden, no las tres de siempre: dependen de la
      // ARL y del tipo de actividad, y quedaron congeladas al asignarla. Una
      // asesoría de Bolívar no pide registro fotográfico; una asistencia
      // técnica pide informe.
      casillas: casillasDeOrden(row.soportes_requeridos),
      // Qué se puede subir hoy: todo, o solo lo devuelto si hay un rechazo
      // pendiente. La regla la fija el servidor, no la pantalla.
      soportes_rechazados: rechazados,
      soportes_rechazo_motivo: rechazados ? row.soportes_rechazo_motivo : null,
      soportes_rechazados_en: rechazados ? row.soportes_rechazados_en : null,
      soportes_cargados: files.rows.map((f) => ({
        ...f,
        categoria: normalizarCategoria(f.categoria),
        etiqueta: etiquetaCategoria(f.categoria),
      })),
    },
  });
}));

/**
 * SUP-07 · Ver un soporte ya cargado desde el portal, SIN login.
 *
 * El profesional no tiene cuenta: sin esta ruta, "puedes ver lo que subiste" se
 * queda en un nombre de archivo. El token es la credencial, y por eso el
 * archivo se busca SIEMPRE acotado a la orden de ese token — un id de otro
 * expediente no se sirve aunque se adivine.
 */
router.get('/support/:token/files/:fileId', asyncHandler(async (req, res) => {
  const row = await resolveToken(req.params.token);
  const r = await pool.query(
    `SELECT * FROM sst.archivos_soporte WHERE id=$1 AND orden_id=$2`,
    [req.params.fileId, row.id]
  );
  const file = r.rows[0];
  if (!file) throw notFound('El archivo no pertenece a esta orden');
  const nombre = (file.nombre_archivo || file.nombre_original || 'soporte').replace(/"/g, '');
  let buffer;
  try {
    buffer = await storage.get(file.url_archivo);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.name === 'NoSuchKey') {
      throw notFound(`El archivo "${nombre}" ya no está disponible.`);
    }
    throw err;
  }
  res.setHeader('Content-Type', file.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${nombre}"`);
  res.send(buffer);
}));

// M6 · Subir soportes firmados (SIN login). Múltiples archivos. → EJECUTADA.
//
// SUP-05 hablaba de EN VERIFICACIÓN, un estado intermedio que se eliminó: la
// visita ya se hizo y los soportes están, así que la orden queda EJECUTADA y la
// revisión del administrador (VER-01/02) se hace sobre ese estado. Si los
// rechaza, la OS vuelve a PROGRAMADA y el enlace se reabre para corregir.
router.post('/support/:token/files', uploadSupports, asyncHandler(async (req, res) => {
  // `.fields()` entrega un objeto { casilla: [archivos] }; se aplana
  // conservando de qué casilla vino cada uno.
  const entrantes = Object.entries(req.files || {}).flatMap(([campo, archivos]) =>
    (archivos || []).map((archivo) => ({ archivo, categoria: normalizarCategoria(campo) })),
  );
  if (!entrantes.length) throw badRequest('Adjunta al menos un archivo');

  const result = await withTransaction(async (client) => {
    const row = await resolveToken(req.params.token, client);

    const rechazados = (row.soportes_rechazados || []).map((c) => normalizarCategoria(c));
    const hayRechazo = rechazados.length > 0;
    const subidas = [...new Set(entrantes.map((e) => e.categoria))];
    // Lo que se le pidió a ESTA orden. Es lo que decide tanto qué falta como qué
    // sobra: mandar un informe en una capacitación que no lo lleva no es un
    // extra inofensivo, es un documento que nadie va a revisar.
    const deLaOrden = casillasDeOrden(row.soportes_requeridos).map((c) => c.clave);

    // SUP-05 · El enlace solo admite carga en DOS momentos: la entrega inicial y
    // la corrección de lo que se devolvió. Entre medias está en revisión y se
    // cierra.
    //
    // Antes EJECUTADA seguía aceptando archivos "por si el profesional olvidó
    // uno", y eso dejaba el enlace abierto para siempre: se podía volver a
    // entrar y seguir añadiendo documentos sobre una visita que el
    // administrador ya estaba revisando, sin que nadie se enterara.
    if (row.estado === 'FINALIZADA') {
      throw badRequest(
        'Esta visita ya se cerró: el equipo administrativo revisó y aceptó los soportes. ' +
        'Si necesita cambiar algo, pídaselo a ellos.',
      );
    }
    if (!['PROGRAMADA', 'EJECUTADA'].includes(row.estado)) {
      throw badRequest(`Esta orden está en estado ${row.estado} y todavía no admite soportes.`);
    }
    if (!hayRechazo && row.estado === 'EJECUTADA') {
      throw badRequest(
        'Ya envió los soportes de esta visita y están en revisión. Si hay que corregir ' +
        'algo, el equipo administrativo se lo devolverá y este enlace volverá a abrirse.',
      );
    }
    // Con un rechazo pendiente solo se aceptan las casillas devueltas: lo demás
    // ya lo dio por bueno el administrador, y volver a recibirlo sería pedirle
    // que revise otra vez lo que aprobó.
    if (hayRechazo) {
      const fuera = subidas.filter((c) => !rechazados.includes(c));
      if (fuera.length) {
        throw badRequest(
          `De esta visita solo hay que volver a subir: ${listaEtiquetas(rechazados)}. ` +
          `${listaEtiquetas(fuera)} ya fue aceptado y no se puede reemplazar.`,
        );
      }
    } else {
      // Y en la entrega inicial, solo las casillas que esta orden pide. El
      // formulario ya no las enseña, pero el campo viaja en un multipart y el
      // servidor no puede fiarse de que el navegador mandara lo que se pintó.
      const sobran = subidas.filter((c) => c !== 'otros' && !deLaOrden.includes(c));
      if (sobran.length) {
        throw badRequest(
          `Esta visita no pide ${listaEtiquetas(sobran)}. Los documentos de esta orden son: ` +
          `${listaEtiquetas(deLaOrden)}.`,
        );
      }
    }

    // Y el envío va COMPLETO, tanto en la entrega inicial como en la corrección.
    //
    // Aceptar uno de los tres documentos dejaba la orden en tierra de nadie: el
    // administrador la ve EJECUTADA, la abre para revisar y se encuentra con que
    // faltan dos, sin nadie a quien reclamárselos porque el enlace ya se cerró.
    // Se entrega todo de una vez o no se entrega.
    const requeridas = hayRechazo ? rechazados : deLaOrden;
    const faltan = requeridas.filter((c) => !subidas.includes(c));
    if (faltan.length) {
      throw badRequest(
        hayRechazo
          ? `Falta adjuntar: ${listaEtiquetas(faltan)}. Los documentos devueltos se envían ` +
            `todos juntos: adjunte los ${requeridas.length} y vuelva a enviar.`
          : `Falta adjuntar: ${listaEtiquetas(faltan)}. Los ${requeridas.length} documentos de la ` +
            'visita se envían juntos, en un solo envío.',
      );
    }

    // El anterior se va en cuanto llega el nuevo, SIEMPRE: cada casilla guarda
    // un documento, no un historial. Conservar las dos versiones deja al
    // administrador eligiendo a ojo cuál es la buena y ocupa espacio para
    // siempre. Las filas se borran dentro de la transacción; los binarios,
    // DESPUÉS de confirmarla — si algo falla y se deshace, el archivo antiguo
    // tiene que seguir estando.
    let reemplazados = [];
    if (subidas.length) {
      const del = await client.query(
        `DELETE FROM sst.archivos_soporte
          WHERE orden_id=$1 AND COALESCE(categoria,'otros') = ANY($2::text[])
          RETURNING id, url_archivo, nombre_archivo, categoria`,
        [row.id, subidas]
      );
      reemplazados = del.rows;
    }

    // Cuántos hay ya de cada categoría en esta OS. Tras el borrado de arriba
    // siempre es cero para las casillas que se están subiendo, así que el
    // reemplazo vuelve a empezar en 'acta.pdf'; el contador sigue haciendo
    // falta para cuando en UN mismo envío llegan dos fotos a 'evidencias'
    // (la segunda es 'evidencias-2.jpg').
    const previos = new Map(
      (await client.query(
        `SELECT categoria, count(*)::int AS n FROM sst.archivos_soporte
          WHERE orden_id=$1 GROUP BY categoria`, [row.id]
      )).rows.map((r) => [normalizarCategoria(r.categoria), r.n]),
    );

    const saved = [];
    for (const { archivo, categoria } of entrantes) {
      // Comprimir ANTES de decidir el nombre: la extensión tiene que
      // corresponder al contenido que de verdad se guarda (un PNG que sale
      // como JPEG deja de llamarse .png).
      const comprimido = await comprimirSoporte({ buffer: archivo.buffer, mime: archivo.mimetype });
      const indice = previos.get(categoria) ?? 0;
      previos.set(categoria, indice + 1);
      const nombre = nombreCanonico(categoria, comprimido.mime, indice);

      if (comprimido.ahorro > 0) {
        console.log(
          `[soportes] ${row.codigo} · ${nombre} · ${comprimido.via} · ` +
          `${(comprimido.original / 1024).toFixed(0)} KB → ${(comprimido.buffer.length / 1024).toFixed(0)} KB ` +
          `(${(comprimido.ahorro * 100).toFixed(0)} % menos)`
        );
      }

      // El nombre del usuario NO llega a la clave del objeto: se guarda bajo el
      // nombre canónico, así que ni los espacios ni los símbolos raros de un
      // nombre de móvil acaban en S3.
      const key = await storage.put(`supports/${row.id}`, nombre, comprimido.buffer);
      const sf = await client.query(
        `INSERT INTO sst.archivos_soporte
           (orden_id, enlace_publico_id, url_archivo, nombre_original, nombre_archivo,
            categoria, mime, tamano_bytes, tamano_original_bytes, via_enlace_publico)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)
         RETURNING id, nombre_archivo, nombre_original, categoria, mime, tamano_bytes`,
        [row.id, row.enlace_id, key, nombreOriginalLegible(archivo.originalname), nombre,
         categoria, comprimido.mime, comprimido.buffer.length, comprimido.original]
      );
      saved.push(sf.rows[0]);
    }
    // La devolución queda cerrada: por la comprobación de arriba, si se llegó
    // hasta aquí es porque llegaron TODOS los documentos devueltos.
    if (hayRechazo) {
      await client.query(
        `UPDATE sst.ordenes_servicio
            SET soportes_rechazados     = NULL,
                soportes_rechazo_motivo = NULL,
                soportes_rechazados_en  = NULL,
                actualizado_en = now()
          WHERE id = $1`,
        [row.id]
      );
    }

    // SUP-05 · al subir, la OS queda EJECUTADA (si estaba PROGRAMADA).
    if (row.estado === 'PROGRAMADA') {
      await changeStatus(
        { orderId: row.id, newStatus: 'EJECUTADA', userId: null, motivo: 'Soportes cargados por el profesional' },
        client
      );
    }
    return { orden: row, saved, reemplazados, hayRechazo };
  });

  // Fuera de la transacción: los binarios sustituidos. Un fallo aquí no puede
  // tumbar una carga que ya está guardada — deja un huérfano en el
  // almacenamiento, que es mucho menos grave que perder el soporte nuevo.
  for (const viejo of result.reemplazados) {
    await storage.remove(viejo.url_archivo)
      .catch((e) => console.error('[soportes] no se pudo borrar el archivo reemplazado:', viejo.url_archivo, e?.message));
  }
  if (result.reemplazados.length) {
    console.log(`[soportes] ${result.orden.codigo} · reemplazados ${result.reemplazados.length} archivo(s): ` +
      result.reemplazados.map((v) => v.nombre_archivo).join(', '));
  }

  // SUP-06 · avisar a administradores. El aviso sigue siendo necesario aunque ya
  // no haya estado intermedio: alguien tiene que mirar los soportes.
  await notifyAdmins({
    tipo: 'SOPORTE_CARGADO',
    titulo: result.hayRechazo ? 'Soportes corregidos' : 'Soportes recibidos',
    mensaje: result.hayRechazo
      ? `${result.orden.codigo} · ${result.orden.empresa_nombre || ''} volvió a enviar lo que se le devolvió · revíselo`
      : `${result.orden.codigo} · ${result.orden.empresa_nombre || ''} quedó EJECUTADA · revise los soportes`,
    datos: { orden_id: result.orden.id },
  });

  res.status(201).json({
    message: result.hayRechazo
      ? 'Corrección enviada. La OS vuelve a quedar ejecutada.'
      : 'Soportes cargados. La OS quedó ejecutada.',
    data: result.saved,
  });
}));

// ---------------------------------------------------------------------------
// M8 · Encuesta de satisfacción (ENC-02/03/06) — formulario público, SIN login.
// ---------------------------------------------------------------------------

/**
 * Datos del formulario. Devuelve también `respondida` para que la vista muestre
 * el agradecimiento en vez del formulario cuando el cliente ya contestó
 * (ENC-06); no se responde 404/409 porque volver a abrir el enlace del correo
 * es un gesto normal, no un error.
 */
router.get('/survey/:token', asyncHandler(async (req, res) => {
  const e = await resolverEncuesta(req.params.token);
  res.json({
    data: {
      orden_codigo: e.orden_codigo,
      empresa_nombre: e.empresa_nombre,
      arl_nombre: e.arl_nombre,
      profesional_nombre: e.profesional_nombre,
      actividad_economica: e.actividad_economica,
      fecha_programada: e.fecha_programada,
      contacto_nombre: e.contacto_nombre,
      preguntas: e.preguntas,
      respondida: e.respondida,
      respondido_en: e.respondido_en,
    },
  });
}));

// ENC-04 · Registrar la respuesta del cliente.
router.post('/survey/:token', asyncHandler(async (req, res) => {
  const { satisfaccion, calificacion_profesional, recomendacion, comentarios } = req.body || {};
  const e = await registrarRespuesta(req.params.token, {
    satisfaccion, calificacion_profesional, recomendacion, comentarios,
  });

  // El administrador se entera de la calificación sin tener que ir a buscarla;
  // una nota baja es justamente lo que conviene ver temprano.
  await notifyAdmins({
    tipo: 'ENCUESTA_RESPONDIDA',
    titulo: 'Encuesta respondida',
    mensaje: `${e.orden_codigo} · ${e.empresa_nombre || ''} calificó la actividad ${e.satisfaccion}/5` +
      (e.calificacion_profesional ? ` y a ${e.profesional_nombre || 'el profesional'} ${e.calificacion_profesional}/5` : ''),
    // El aviso lleva al profesional, no a la orden: lo que se quiere ver al
    // pulsarlo es cómo va calificado quien dictó la actividad, y eso vive en su
    // ficha (Profesionales), no en el expediente de la OS.
    datos: { orden_id: e.orden_id, profesional_id: e.profesional_id || null },
  }).catch((err) => console.error('[encuesta] notificación interna no creada:', err?.message));

  res.status(201).json({
    message: '¡Gracias! Su respuesta quedó registrada.',
    data: { respondido_en: e.respondido_en },
  });
}));

// ---------------------------------------------------------------------------
// M9 · Pre-cuenta de cobro (PRE-05/06/07) — el profesional acepta o rechaza
// desde el enlace del correo, SIN login.
// ---------------------------------------------------------------------------

/** Detalle de la pre-cuenta para revisarla antes de decidir. */
router.get('/precuenta/:token', asyncHandler(async (req, res) => {
  const pc = await resolverPrecuenta(req.params.token);
  res.json({
    data: {
      periodo: pc.periodo,
      periodo_largo: periodoLargo(pc.periodo),
      profesional_nombre: pc.profesional_nombre,
      total_horas: pc.total_horas,
      total_monto: pc.total_monto,
      // Con viáticos, el total ya no es horas × tarifa. El profesional está a
      // punto de ACEPTAR esta cifra, así que tiene que poder cuadrarla.
      total_viaticos: pc.total_viaticos,
      total_ordenes: pc.total_ordenes,
      estado: pc.estado,
      observaciones: pc.observaciones,
      respondido_en: pc.respondido_en,
      items: pc.items.map((i) => ({
        orden_codigo: i.orden_codigo,
        empresa_nombre: i.empresa_nombre,
        arl_nombre: i.arl_nombre,
        actividad: i.actividad,
        fecha_ejecucion: i.fecha_ejecucion,
        horas: i.horas,
        viaticos: i.viaticos,
        valor_hora: i.valor_hora_snapshot,
        monto: i.monto,
      })),
    },
  });
}));

/** PRE-06/07 · Aceptar o rechazar (con observaciones obligatorias al rechazar). */
router.post('/precuenta/:token/responder', asyncHandler(async (req, res) => {
  const { decision, observaciones } = req.body || {};
  const pc = await responderPrecuenta(req.params.token, { decision, observaciones });

  // PRE-06 · Enterar a quien tiene que actuar: administradores y contadores.
  // Un rechazo abre trabajo manual, así que se marca como tal en el mensaje.
  const aceptada = pc.estado === 'aceptada';
  const destinatarios = await pool.query(
    `SELECT id FROM sst.usuarios WHERE activo AND rol IN ('admin','contador')`
  );
  await Promise.all(destinatarios.rows.map((u) => notify({
    userId: u.id,
    tipo: aceptada ? 'PRECUENTA_ACEPTADA' : 'PRECUENTA_RECHAZADA',
    titulo: aceptada ? 'Pre-cuenta aceptada' : 'Pre-cuenta rechazada',
    mensaje: aceptada
      ? `${pc.profesional_nombre} aceptó su pre-cuenta de ${periodoLargo(pc.periodo)} por ${enPesos(pc.total_monto)}`
      : `${pc.profesional_nombre} rechazó su pre-cuenta de ${periodoLargo(pc.periodo)}: ${pc.observaciones || 'sin detalle'}`,
    datos: { precuenta_id: pc.id },
  }))).catch((err) => console.error('[precuenta] notificación interna no creada:', err?.message));

  res.json({
    message: aceptada
      ? 'Pre-cuenta aceptada. Gracias por confirmar.'
      : 'Pre-cuenta rechazada. Un administrador revisará sus observaciones.',
    data: { estado: pc.estado, respondido_en: pc.respondido_en },
  });
}));

export default router;
