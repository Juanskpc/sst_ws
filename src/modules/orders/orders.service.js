import { pool } from '../../config/db.js';
import { notFound } from '../../utils/httpError.js';
import { storage } from '../../services/storage.service.js';
import { generateFormatoPdf } from '../../services/pdf.service.js';
import {
  ALIADO_POR_DEFECTO, generarFormatosArl, slugArl, tieneFormatosPropios,
} from '../../services/formatos-arl.service.js';

/** Carga una OS expandida (con nombres de ARL/profesional) o lanza 404. */
export async function getOrderExpanded(id, client = pool) {
  const r = await client.query(`SELECT * FROM sst.vw_ordenes_expandidas WHERE id=$1`, [id]);
  if (!r.rows[0]) throw notFound('OS no encontrada');
  return r.rows[0];
}

/**
 * 5-oct-2026 · Asesores ADICIONALES de una orden (`sst.orden_coasesores`), con
 * lo necesario para escribirles y para explicar el reparto de horas.
 *
 * El principal no está aquí: es `profesional_asignado_id`, y sus horas son las
 * de la orden menos la suma de estas.
 */
export async function coasesoresDeOrden(ordenId, client = pool) {
  const r = await client.query(
    `SELECT c.profesional_id, p.nombre, p.correo, p.usuario_id,
            c.horas::float AS horas, c.valor_hora_cobro, c.valor_hora_origen
       FROM sst.orden_coasesores c
       JOIN sst.profesionales p ON p.id = c.profesional_id
      WHERE c.orden_id = $1
      ORDER BY p.nombre`,
    [ordenId]
  );
  return r.rows;
}

/**
 * 7-oct-2026 · Asesores de la orden que todavía NO han entregado sus soportes.
 *
 * Con varios asesores cada uno sube los suyos por su propio enlace
 * (`enlaces_publicos.profesional_id`; NULL = el del principal), y la orden solo
 * pasa a EJECUTADA cuando no falta ninguno. "Entregado" es tener el enlace con
 * `entregado_en` y nada devuelto pendiente: lo devuelto al principal vive en la
 * orden (`soportes_rechazados`); lo de los demás, en su enlace (`rechazados`).
 */
export async function asesoresSinEntregar(ordenId, client = pool) {
  const r = await client.query(
    `SELECT m.profesional_id, p.nombre, m.principal
       FROM (
         SELECT o.profesional_asignado_id AS profesional_id, true AS principal
           FROM sst.ordenes_servicio o WHERE o.id = $1 AND o.profesional_asignado_id IS NOT NULL
         UNION ALL
         SELECT c.profesional_id, false FROM sst.orden_coasesores c WHERE c.orden_id = $1
       ) m
       JOIN sst.profesionales p ON p.id = m.profesional_id
      WHERE NOT EXISTS (
        SELECT 1 FROM sst.enlaces_publicos e
         WHERE e.orden_id = $1 AND e.entregado_en IS NOT NULL
           AND ((m.principal AND e.profesional_id IS NULL
                 AND (SELECT soportes_rechazados FROM sst.ordenes_servicio WHERE id = $1) IS NULL)
             OR (NOT m.principal AND e.profesional_id = m.profesional_id AND e.rechazados IS NULL))
      )
      ORDER BY m.principal DESC, p.nombre`,
    [ordenId]
  );
  return r.rows;
}

/**
 * ASG-08 · Ficha de profesional que corresponde a una cuenta de acceso.
 *
 * Se resuelve primero por `usuario_id` —el enlace explícito, que es el que deja
 * el backfill del seed y el alta desde /profesionales— y solo si no hay, por
 * correo. El segundo intento existe porque las fichas y las cuentas se crearon
 * en pantallas distintas durante meses y nada las cruzaba: sin él, un
 * profesional dado de alta antes que su cuenta vería el dashboard vacío.
 *
 * El respaldo por correo exige correspondencia 1-a-1, igual que el backfill:
 * hay fichas que comparten buzón, y con `LIMIT 1` el profesional acabaría
 * viendo las órdenes de un compañero. Ante ambigüedad se devuelve null y la
 * vista pide que un administrador enlace la ficha.
 */
export async function profesionalDeUsuario(usuario, client = pool) {
  // El JWT trae el id del usuario en `sub`; se acepta `id` también para poder
  // llamar a esta función con una fila de sst.usuarios recién leída.
  const usuarioId = usuario?.sub || usuario?.id;
  if (!usuarioId) return null;
  const porEnlace = await client.query(
    `SELECT * FROM sst.profesionales WHERE usuario_id = $1 LIMIT 1`,
    [usuarioId]
  );
  if (porEnlace.rows[0]) return porEnlace.rows[0];

  if (!usuario.correo) return null;
  const porCorreo = await client.query(
    `SELECT * FROM sst.profesionales
      WHERE lower(btrim(correo)) = lower(btrim($1))`,
    [usuario.correo]
  );
  return porCorreo.rows.length === 1 ? porCorreo.rows[0] : null;
}

/** Cambia el estado usando la función de dominio (valida transición + auditoría). */
export async function changeStatus({ orderId, newStatus, userId, motivo = null }, client = pool) {
  const r = await client.query(
    `SELECT * FROM sst.cambiar_estado_orden($1, $2::sst.estado_orden, $3, $4)`,
    [orderId, newStatus, userId, motivo]
  );
  return r.rows[0];
}

/** Identidad de JD&D ante las ARL, editable desde `sst.configuracion`. */
/**
 * El PDF con el que se importó una orden de Colmena: es su informe de
 * prestación (SPM-F 38) y el formato sale escrito encima de él. Vive en el lote
 * de importación, no en la orden. Solo Colmena lo usa; cualquier fallo (orden
 * cargada a mano, archivo borrado del almacenamiento) devuelve null y el
 * generador vuelve a la plantilla, en vez de dejar la asignación sin formatos.
 */
async function pdfOriginalDeColmena(orderId, arlNombre, client = pool) {
  if (!slugArl(arlNombre).includes('colmena')) return null;
  const r = await client.query(
    `SELECT l.url_archivo, l.tipo_mime
       FROM sst.ordenes_servicio o JOIN sst.lotes_importacion l ON l.id = o.lote_importacion_id
      WHERE o.id = $1`,
    [orderId]
  );
  const lote = r.rows[0];
  if (!lote?.url_archivo || !/pdf/i.test(`${lote.tipo_mime} ${lote.url_archivo}`)) return null;
  try {
    return await storage.get(lote.url_archivo);
  } catch (err) {
    console.warn(`[formatos] no se pudo leer el PDF original de la orden ${orderId}: ${err.message}`);
    return null;
  }
}

async function aliadoEstrategico(client = pool) {
  const r = await client.query(`SELECT valor FROM sst.configuracion WHERE clave='aliado_estrategico'`);
  const guardado = r.rows[0]?.valor;
  return guardado && typeof guardado === 'object' ? { ...ALIADO_POR_DEFECTO, ...guardado } : ALIADO_POR_DEFECTO;
}

/**
 * M4/FOR · Genera los formatos auto-diligenciados de la OS y los archiva en
 * `documentos_generados`. Devuelve la lista, con el contenido en `_buffer` para
 * que el correo de asignación los adjunte sin volver a bajarlos del storage.
 *
 * Hay dos orígenes posibles y NO se mezclan:
 *
 *  1. El formato oficial de la ARL (`assets/formatos-arl/`), cuando existe. Es
 *     el que la ARL acepta radicado, así que manda sobre cualquier otra cosa.
 *  2. Las plantillas genéricas de `sst.plantillas` (CFG-03), para las ARL cuyos
 *     formatos todavía no están cargados.
 *
 * Adjuntar los dos a la vez dejaría al profesional eligiendo entre dos hojas
 * parecidas sin saber cuál vale, así que en cuanto una ARL tiene formato propio
 * sus plantillas genéricas dejan de emitirse.
 *
 * `guardar: false` es la VISTA PREVIA de la asignación: genera los mismos PDF
 * pero no los sube al almacenamiento ni los registra en `documentos_generados`.
 * Las observaciones escritas en la vista previa llegan en
 * `ordenes_servicio.observaciones_formatos` (ya actualizada en la transacción).
 */
/** "María Pérez Gómez" → "Maria-Perez-Gomez", apto para nombre de archivo. */
function nombreDeArchivo(nombre) {
  return String(nombre ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'asesor';
}

export async function generateOrderDocuments(orderId, client = pool, { guardar = true } = {}) {
  const order = await getOrderExpanded(orderId, client);
  // A3-01 · La orden de un cliente particular no lleva formatos: los que hay son
  // de las ARL, y las plantillas genéricas (`arl_id` NULL) saldrían con la casilla
  // "ARL" en blanco. Si JD&D define un formato propio para particulares, entra
  // aquí (pregunta abierta en el §0 del plan de facturación).
  if (!order.arl_id) return [];
  // ASG · El nombre que va IMPRESO es el del profesional registrado ante la ARL
  // cuando la orden lleva suplente (`profesional_formatos_id`), y el del ejecutor
  // en el caso normal. Es el único sitio donde los dos papeles se separan: el
  // correo, el `.ics`, el enlace de soportes, la agenda, la cuenta de cobro y la
  // encuesta siguen apuntando a `profesional_asignado_id`, que es quien trabaja.
  const firmanteId = order.profesional_formatos_id || order.profesional_asignado_id;
  const professional = firmanteId
    ? (await client.query(`SELECT * FROM sst.profesionales WHERE id=$1`, [firmanteId])).rows[0]
    : null;

  // Se leen aquí y no se reciben por parámetro para que el formato salga con lo
  // que quedó guardado en esta misma transacción, no con lo que traía el body.
  const todas = (await client.query(
    `SELECT profesional_id, fecha::text AS fecha, hora_inicio::text AS hora_inicio, hora_fin::text AS hora_fin
       FROM sst.franjas_visita WHERE orden_id=$1 ORDER BY fecha, hora_inicio`,
    [orderId]
  )).rows;

  // 7-oct-2026 · Varios asesores, cada uno con su horario: sale UN JUEGO POR
  // ASESOR, con sus fechas y horas (las de sesión, una hoja por franja SUYA) y a
  // su nombre. La excepción es la suplencia: si la orden lleva
  // `profesional_formatos_id`, todos los juegos van a nombre del registrado ante
  // la ARL, que es lo único que la ARL acepta. Con un solo asesor no cambia nada.
  const coasesores = await coasesoresDeOrden(orderId, client);
  const juegos = [];
  if (!coasesores.length) {
    juegos.push({ profesional: professional, franjas: todas, de: null });
  } else {
    const ejecutores = [
      { id: order.profesional_asignado_id, nombre: order.profesional_nombre },
      ...coasesores.map((c) => ({ id: c.profesional_id, nombre: c.nombre })),
    ];
    for (const e of ejecutores) {
      const ficha = order.profesional_formatos_id
        ? professional
        : (await client.query(`SELECT * FROM sst.profesionales WHERE id=$1`, [e.id])).rows[0];
      juegos.push({
        profesional: ficha,
        franjas: todas.filter((f) => (f.profesional_id ?? order.profesional_asignado_id) === e.id),
        de: { id: e.id, nombre: e.nombre ?? ficha?.nombre ?? '' },
      });
    }
  }

  const created = [];

  if (tieneFormatosPropios(order.arl_nombre)) {
    const aliado = await aliadoEstrategico(client);
    const original = await pdfOriginalDeColmena(orderId, order.arl_nombre, client);
    for (const juego of juegos) {
      const propios = await generarFormatosArl({
        orden: order, profesional: juego.profesional, franjas: juego.franjas, aliado, original,
        observaciones: order.observaciones_formatos || {},
        campos: order.campos_formatos || {},
      });
      // El nombre del asesor va delante del archivo: dos juegos con el mismo
      // nombre se pisarían en el almacenamiento y en el correo no se distinguirían.
      const prefijo = juego.de ? `${nombreDeArchivo(juego.de.nombre)}_` : '';
      for (const formato of propios) {
        const filename = `${prefijo}${formato.filename}`;
        // `_clave` y `_admiteObservaciones` son para la vista previa: con qué clave
        // se guardan las observaciones de este formato y si tiene dónde escribirlas.
        const extra = {
          _buffer: formato.buffer, _filename: filename,
          _etiqueta: formato.etiqueta, _prediligenciado: formato.prediligenciado,
          _clave: formato.clave, _admiteObservaciones: !!formato.admiteObservaciones,
          _editables: formato.editables || [],
          _profesionalId: juego.de?.id ?? null, _profesionalNombre: juego.de?.nombre ?? null,
        };
        if (!guardar) {
          created.push({ tipo: formato.tipo, ...extra });
          continue;
        }
        const key = await storage.put('documents', `${order.codigo || order.id}_${filename}`, formato.buffer);
        const doc = await client.query(
          `INSERT INTO sst.documentos_generados (orden_id, plantilla_id, tipo, url_pdf)
           VALUES ($1,NULL,$2,$3) RETURNING *`,
          [orderId, formato.tipo, key]
        );
        // `_etiqueta` y `_prediligenciado` no van a BD: los usa el correo para
        // enumerar lo que ESTA orden lleva adjunto, con el nombre de la ARL.
        created.push({ ...doc.rows[0], ...extra });
      }
    }
  }
  if (created.length) return created;

  const tpls = await client.query(
    // CFG-03 · `orden` deja al administrador decidir en qué secuencia salen los
    // formatos de una ARL (el correo de asignación los adjunta en este orden).
    `SELECT * FROM sst.plantillas WHERE activo AND (arl_id = $1 OR arl_id IS NULL)
      ORDER BY orden, nombre`,
    [order.arl_id]
  );

  for (const template of tpls.rows) {
    const buffer = await generateFormatoPdf({ template, order, professional });
    const extra = {
      _buffer: buffer, _filename: `${template.tipo}.pdf`,
      _etiqueta: template.nombre || template.tipo, _prediligenciado: true,
      _clave: null, _admiteObservaciones: false, _editables: [],
    };
    if (!guardar) {
      created.push({ tipo: template.tipo, ...extra });
      continue;
    }
    const key = await storage.put('documents', `${order.codigo || order.id}_${template.tipo}.pdf`, buffer);
    const doc = await client.query(
      `INSERT INTO sst.documentos_generados (orden_id, plantilla_id, tipo, url_pdf)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [orderId, template.id, template.tipo, key]
    );
    created.push({ ...doc.rows[0], ...extra });
  }
  return created;
}
