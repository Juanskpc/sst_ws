import { Router } from 'express';
import { pool } from '../../config/db.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { badRequest, conflict, notFound } from '../../utils/httpError.js';
import { authRequired, requireRole } from '../../middleware/auth.js';

const router = Router();
router.use(authRequired);

/**
 * Clave de comparación de teléfonos: solo dígitos y quedándose con los últimos
 * 10 (largo de un celular colombiano). Así '+57 300 111 2233', '57 3001112233'
 * y '3001112233' se reconocen como el mismo número pese al indicativo.
 */
const claveTelefono = (t) => String(t ?? '').replace(/\D/g, '').slice(-10);

/**
 * CFG-01 · El correo y el teléfono identifican a un asesor de campo: no pueden
 * repetirse entre profesionales (se usan para contactarlo y para cruzarlo con
 * su cuenta de usuario). El correo se compara sin distinguir mayúsculas ni
 * espacios sobrantes; el teléfono, solo por sus dígitos.
 *
 * `excluirId` evita que un registro choque consigo mismo al editarse.
 */
async function assertContactoDisponible({ correo, telefono, excluirId = null }) {
  const correoNorm = correo == null ? null : String(correo).trim().toLowerCase();
  const telNorm = claveTelefono(telefono);
  if (!correoNorm && !telNorm) return;

  const r = await pool.query(
    `WITH otros AS (
       SELECT nombre,
              lower(btrim(correo)) AS correo_norm,
              right(regexp_replace(coalesce(telefono,''), '[^0-9]', '', 'g'), 10) AS tel_norm
         FROM sst.profesionales
        WHERE ($3::uuid IS NULL OR id <> $3::uuid)
     )
     SELECT nombre,
            ($1::text IS NOT NULL AND correo_norm = $1) AS choca_correo,
            ($2::text <> '' AND tel_norm = $2) AS choca_telefono
       FROM otros
      WHERE ($1::text IS NOT NULL AND correo_norm = $1)
         OR ($2::text <> '' AND tel_norm = $2)
      LIMIT 2`,
    [correoNorm || null, telNorm, excluirId]
  );
  if (!r.rows.length) return;

  const porCorreo = r.rows.find((x) => x.choca_correo);
  const porTelefono = r.rows.find((x) => x.choca_telefono);
  // Se informan los dos choques a la vez cuando ocurren: corregir uno y volver a
  // enviar solo para descubrir el otro obliga a un viaje de más.
  if (porCorreo && porTelefono) {
    throw conflict(
      porCorreo.nombre === porTelefono.nombre
        ? `El correo y el teléfono ya están registrados a nombre de ${porCorreo.nombre}.`
        : `El correo ya está registrado a nombre de ${porCorreo.nombre} y el teléfono a nombre de ${porTelefono.nombre}.`
    );
  }
  if (porCorreo) throw conflict(`El correo ya está registrado a nombre de ${porCorreo.nombre}.`);
  throw conflict(`El teléfono ya está registrado a nombre de ${porTelefono.nombre}.`);
}

/**
 * ASG-08 · Enlaza la ficha con la cuenta de acceso que tenga el mismo correo.
 *
 * Se hace sola, como el maestro de empresas de CFG-02: la ficha (CFG-01) y la
 * cuenta (Configuración → Usuarios) se crean en pantallas distintas y nadie iba
 * a acordarse de cruzarlas a mano, con lo que el profesional entraba y su
 * dashboard salía vacío.
 *
 * Solo enlaza si hay exactamente una cuenta con ese correo; si hay varias no
 * hay forma de saber cuál es y enlazar la equivocada le enseñaría a alguien las
 * órdenes de otro. Se llama después de escribir la ficha, y no lanza: fallar
 * aquí no debe tumbar un alta de profesional válida.
 */
async function enlazarCuenta(profesionalId, correo) {
  if (!correo) return;
  try {
    await pool.query(
      `UPDATE sst.profesionales p
          SET usuario_id = u.id, actualizado_en = now()
         FROM sst.usuarios u
        WHERE p.id = $1
          AND lower(btrim(u.correo)) = lower(btrim($2))
          AND (SELECT count(*) FROM sst.usuarios y
                WHERE lower(btrim(y.correo)) = lower(btrim($2))) = 1`,
      [profesionalId, correo]
    );
  } catch (e) {
    console.warn(`[profesionales] no se pudo enlazar la cuenta de ${profesionalId}: ${e.message}`);
  }
}

// CFG-01 · Listado (con buscador rápido opcional ?q=)
router.get('/', asyncHandler(async (req, res) => {
  const { q } = req.query;
  const params = [];
  let where = '';
  if (q) {
    params.push(`%${q}%`);
    where = `WHERE p.nombre ILIKE $1 OR p.correo ILIKE $1 OR p.especialidad ILIKE $1`;
  }
  // CFG-01 / ENC-05 · La ficha viaja con lo que se hace con ella: cuántas
  // órdenes cerró y cómo lo califican los clientes. Son datos de dos módulos
  // distintos, pero se leen juntos —una nota sin saber sobre cuántas visitas no
  // dice nada— y pedirlos en dos viajes obligaría a la vista a cruzarlos.
  const r = await pool.query(
    `SELECT p.*,
            d.ordenes_ejecutadas,
            d.encuestas_enviadas,
            d.encuestas_respondidas,
            d.calificacion_promedio,
            d.ultima_calificacion_en
       FROM sst.profesionales p
       JOIN sst.vw_profesionales_desempeno d ON d.profesional_id = p.id
       ${where}
      ORDER BY p.nombre`, params
  );
  res.json({ data: r.rows });
}));

/**
 * ENC-05 · Las encuestas de UN profesional, con su comentario.
 *
 * El promedio de la lista dice "4,6"; esto dice por qué. Sin este detalle, una
 * nota baja no se puede accionar: no se sabe de qué visita salió, ni si el
 * cliente escribió el motivo. Solo se devuelven las RESPONDIDAS — una encuesta
 * enviada y sin contestar no es una calificación.
 */
router.get('/:id/encuestas', asyncHandler(async (req, res) => {
  const r = await pool.query(
    `SELECT id, orden_id, orden_codigo, empresa_nombre, arl_nombre, actividad_economica,
            satisfaccion, calificacion_profesional, nota_profesional, recomendacion,
            comentarios, respondido_en
       FROM sst.vw_encuestas
      WHERE profesional_id = $1 AND respondida
      ORDER BY respondido_en DESC
      LIMIT 200`,
    [req.params.id]
  );
  const resumen = await pool.query(
    `SELECT * FROM sst.vw_profesionales_desempeno WHERE profesional_id = $1`, [req.params.id]
  );
  res.json({ data: r.rows, resumen: resumen.rows[0] || null });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const r = await pool.query(`SELECT * FROM sst.profesionales WHERE id=$1`, [req.params.id]);
  if (!r.rows[0]) throw notFound('Profesional no encontrado');
  res.json({ data: r.rows[0] });
}));

// CFG-01 · Crear (admin)
router.post('/', requireRole('admin'), asyncHandler(async (req, res) => {
  const { nombre, telefono, especialidad, valor_hora = 0, estado = 'Activo' } = req.body || {};
  const correo = req.body?.correo || req.body?.email;
  if (!nombre || !correo) throw badRequest('nombre y correo son obligatorios');
  if (!['Activo', 'Inactivo'].includes(estado)) throw badRequest('estado inválido');
  await assertContactoDisponible({ correo, telefono });
  const r = await pool.query(
    `INSERT INTO sst.profesionales (nombre, correo, telefono, especialidad, valor_hora, estado)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [nombre, correo, telefono, especialidad, valor_hora, estado]
  );
  await enlazarCuenta(r.rows[0].id, r.rows[0].correo);
  res.status(201).json({ data: r.rows[0] });
}));

// CFG-01 · Editar (admin)
router.put('/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const { nombre, telefono, especialidad, valor_hora, estado } = req.body || {};
  const correo = req.body?.correo ?? req.body?.email ?? null;
  // Misma regla que en el alta: si no se valida aquí, la restricción se saltaría
  // creando el profesional con otro correo y editándolo después.
  await assertContactoDisponible({ correo, telefono, excluirId: req.params.id });
  const r = await pool.query(
    `UPDATE sst.profesionales SET
       nombre = COALESCE($2, nombre),
       correo = COALESCE($3, correo),
       telefono = COALESCE($4, telefono),
       especialidad = COALESCE($5, especialidad),
       valor_hora = COALESCE($6, valor_hora),
       estado = COALESCE($7, estado)
     WHERE id=$1 RETURNING *`,
    [req.params.id, nombre, correo, telefono, especialidad, valor_hora, estado]
  );
  if (!r.rows[0]) throw notFound('Profesional no encontrado');
  // Si cambió el correo, el enlace anterior puede haber dejado de ser cierto:
  // se suelta y se vuelve a resolver. Corregir el correo de una ficha es
  // precisamente como un administrador la asocia a la cuenta correcta.
  if (correo) {
    await pool.query(`UPDATE sst.profesionales SET usuario_id = NULL WHERE id = $1`, [req.params.id]);
    await enlazarCuenta(req.params.id, r.rows[0].correo);
    const refrescado = await pool.query(`SELECT * FROM sst.profesionales WHERE id=$1`, [req.params.id]);
    return res.json({ data: refrescado.rows[0] });
  }
  res.json({ data: r.rows[0] });
}));

// CFG-01 · Alternar estado Activo/Inactivo (admin)
router.patch('/:id/estado', requireRole('admin'), asyncHandler(async (req, res) => {
  const r = await pool.query(
    `UPDATE sst.profesionales
       SET estado = CASE WHEN estado='Activo' THEN 'Inactivo'::sst.estado_profesional
                         ELSE 'Activo'::sst.estado_profesional END
     WHERE id=$1 RETURNING *`,
    [req.params.id]
  );
  if (!r.rows[0]) throw notFound('Profesional no encontrado');
  res.json({ data: r.rows[0] });
}));

// ===== Ocupaciones (agenda) del profesional — calendario de disponibilidad =====

async function ensureProfessional(id) {
  const r = await pool.query(`SELECT id FROM sst.profesionales WHERE id=$1`, [id]);
  if (!r.rows[0]) throw notFound('Profesional no encontrado');
}

// SELECT con fecha/hora ya formateadas como texto para el frontend.
const OCUPACION_COLS = `
  id, profesional_id,
  to_char(fecha, 'YYYY-MM-DD') AS fecha,
  to_char(hora_inicio, 'HH24:MI') AS hora_inicio,
  to_char(hora_fin, 'HH24:MI') AS hora_fin,
  motivo, creado_en`;

// Listar franjas ocupadas del profesional.
router.get('/:id/ocupaciones', asyncHandler(async (req, res) => {
  await ensureProfessional(req.params.id);
  const r = await pool.query(
    `SELECT ${OCUPACION_COLS}
     FROM sst.ocupaciones_profesional
     WHERE profesional_id=$1
     ORDER BY fecha, hora_inicio`,
    [req.params.id]
  );
  res.json({ data: r.rows });
}));

// Registrar una franja de ocupación (admin).
router.post('/:id/ocupaciones', requireRole('admin'), asyncHandler(async (req, res) => {
  await ensureProfessional(req.params.id);
  const { fecha, hora_inicio, hora_fin, motivo = null } = req.body || {};
  if (!fecha || !hora_inicio || !hora_fin) {
    throw badRequest('fecha, hora_inicio y hora_fin son obligatorios');
  }
  if (hora_fin <= hora_inicio) throw badRequest('hora_fin debe ser mayor que hora_inicio');
  // Cruce de agenda: dos franjas del mismo profesional se solapan si comparten
  // fecha y sus intervalos se intersecan. Tocarse en el borde (10:00–12:00 y
  // 12:00–14:00) NO es cruce: el profesional encadena una tras otra.
  const cruce = await pool.query(
    `SELECT to_char(hora_inicio, 'HH24:MI') AS inicio,
            to_char(hora_fin, 'HH24:MI')    AS fin,
            motivo
       FROM sst.ocupaciones_profesional
      WHERE profesional_id = $1
        AND fecha = $2::date
        AND hora_inicio < $4::time
        AND $3::time < hora_fin
      ORDER BY hora_inicio
      LIMIT 1`,
    [req.params.id, fecha, hora_inicio, hora_fin]
  );
  if (cruce.rows[0]) {
    const { inicio, fin } = cruce.rows[0];
    throw conflict(`El profesional ya está ocupado el ${fecha} de ${inicio} a ${fin}. Las franjas no pueden cruzarse.`);
  }
  const ins = await pool.query(
    `INSERT INTO sst.ocupaciones_profesional (profesional_id, fecha, hora_inicio, hora_fin, motivo, creado_por)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [req.params.id, fecha, hora_inicio, hora_fin, motivo, req.user.sub]
  );
  const r = await pool.query(
    `SELECT ${OCUPACION_COLS} FROM sst.ocupaciones_profesional WHERE id=$1`,
    [ins.rows[0].id]
  );
  res.status(201).json({ data: r.rows[0] });
}));

// Eliminar una franja de ocupación (admin).
router.delete('/:id/ocupaciones/:slotId', requireRole('admin'), asyncHandler(async (req, res) => {
  const r = await pool.query(
    `DELETE FROM sst.ocupaciones_profesional WHERE id=$1 AND profesional_id=$2 RETURNING id`,
    [req.params.slotId, req.params.id]
  );
  if (!r.rows[0]) throw notFound('Ocupación no encontrada');
  res.json({ data: { id: r.rows[0].id } });
}));

// ---------------------------------------------------------------------------
// M9 · PRE-02 — Tarifas por tipo de actividad (valor hora del profesional).
// ---------------------------------------------------------------------------

/**
 * Tarifas del profesional. Se devuelven todas (incluidas las históricas): la
 * vigencia la resuelve el cálculo de la pre-cuenta según la fecha del periodo,
 * y ver el histórico es lo que permite entender un monto ya facturado.
 */
router.get('/:id/tarifas', asyncHandler(async (req, res) => {
  const r = await pool.query(
    `SELECT id, profesional_id, actividad, valor_hora, vigente_desde, creado_en
       FROM sst.tarifas_actividad_profesional
      WHERE profesional_id=$1
      ORDER BY actividad, vigente_desde DESC`,
    [req.params.id]
  );
  res.json({ data: r.rows });
}));

/**
 * Alta de tarifa (admin). Cambiar un valor NO edita la fila anterior: se agrega
 * otra con nueva vigencia, para no alterar pre-cuentas ya calculadas. Repetir
 * actividad + misma fecha sí sobrescribe (es corregir un error de digitación).
 */
router.post('/:id/tarifas', requireRole('admin'), asyncHandler(async (req, res) => {
  const { actividad, valor_hora: valorHora, vigente_desde: vigenteDesde } = req.body || {};
  const nombre = (actividad || '').trim();
  if (!nombre) throw badRequest('La actividad es obligatoria');
  const valor = Number(valorHora);
  if (!Number.isFinite(valor) || valor <= 0) throw badRequest('El valor hora debe ser un número mayor que cero');

  const r = await pool.query(
    `INSERT INTO sst.tarifas_actividad_profesional (profesional_id, actividad, valor_hora, vigente_desde)
     VALUES ($1,$2,$3, COALESCE($4::date, CURRENT_DATE))
     RETURNING id, profesional_id, actividad, valor_hora, vigente_desde, creado_en`,
    [req.params.id, nombre, valor, vigenteDesde || null]
  );
  res.status(201).json({ data: r.rows[0] });
}));

router.delete('/:id/tarifas/:tarifaId', requireRole('admin'), asyncHandler(async (req, res) => {
  const r = await pool.query(
    `DELETE FROM sst.tarifas_actividad_profesional WHERE id=$1 AND profesional_id=$2 RETURNING id`,
    [req.params.tarifaId, req.params.id]
  );
  if (!r.rows[0]) throw notFound('Tarifa no encontrada');
  res.json({ data: { id: r.rows[0].id } });
}));

export default router;
