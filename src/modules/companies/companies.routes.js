import { Router } from 'express';
import { pool, withTransaction } from '../../config/db.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { badRequest, conflict, notFound } from '../../utils/httpError.js';
import { authRequired, requireRole } from '../../middleware/auth.js';
import { EMPRESA_COLS, normalizarNit } from './companies.service.js';

const router = Router();
router.use(authRequired);

/**
 * CFG-02 · Maestro de empresas clientes.
 *
 * La lectura queda abierta a cualquier sesión autenticada (contador y auditor la
 * necesitan para leer las cuentas de cobro); la escritura es del administrador.
 */

/** Campos editables desde el formulario, en el orden en que van al UPDATE. */
const CAMPOS_EDITABLES = [
  'nombre', 'actividad_economica', 'ciudad', 'direccion',
  'contacto_nombre', 'contacto_cargo', 'contacto_telefono', 'contacto_correo',
  'contacto_sst_nombre', 'contacto_sst_telefono', 'contacto_sst_correo', 'notas',
];

/**
 * El NIT identifica a la empresa: no puede repetirse. Se compara normalizado
 * (ver companies.service.js), así que '901.225.480-3' choca con '901225480'.
 * `excluirId` evita que un registro colisione consigo mismo al editarse.
 */
async function assertNitDisponible(nit, excluirId = null) {
  const norm = normalizarNit(nit);
  if (!norm) return;
  const r = await pool.query(
    `SELECT nombre FROM sst.empresas
      WHERE nit_normalizado = $1 AND ($2::uuid IS NULL OR id <> $2::uuid) LIMIT 1`,
    [norm, excluirId]
  );
  if (r.rows[0]) throw conflict(`El NIT ${nit} ya está registrado a nombre de ${r.rows[0].nombre}.`);
}

/** Normaliza el cuerpo del formulario: '' → null y recorte de espacios. */
const limpiar = (v) => {
  const s = v == null ? '' : String(v).trim();
  return s === '' ? null : s;
};

// CFG-02 · Listado. ?q= busca por nombre, NIT o actividad; ?activo=true|false.
router.get('/', asyncHandler(async (req, res) => {
  const { q, activo } = req.query;
  const params = [];
  const filtros = [];
  if (q) {
    params.push(`%${q}%`);
    filtros.push(`(e.nombre ILIKE $${params.length} OR e.nit ILIKE $${params.length}
                   OR e.actividad_economica ILIKE $${params.length} OR e.ciudad ILIKE $${params.length})`);
  }
  if (activo === 'true' || activo === 'false') {
    params.push(activo === 'true');
    filtros.push(`e.activo = $${params.length}`);
  }
  const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';

  // El conteo de órdenes es lo que le dice al administrador si una ficha es real
  // o un duplicado recién creado por el OCR, así que viaja con el listado.
  const r = await pool.query(
    `SELECT ${EMPRESA_COLS.split(',').map((c) => `e.${c.trim()}`).join(', ')},
            (count(o.id))::int AS total_ordenes,
            (count(o.id) FILTER (WHERE o.estado IN ('EJECUTADA','FINALIZADA')))::int AS ordenes_ejecutadas,
            max(o.fecha_carga) AS ultima_orden
       FROM sst.empresas e
       LEFT JOIN sst.ordenes_servicio o ON o.empresa_id = e.id
       ${where}
      GROUP BY e.id
      ORDER BY e.nombre`,
    params
  );
  res.json({ data: r.rows });
}));

// CFG-02 · Ficha con sus últimas órdenes (contexto para decidir una baja).
router.get('/:id', asyncHandler(async (req, res) => {
  const r = await pool.query(`SELECT ${EMPRESA_COLS} FROM sst.empresas WHERE id=$1`, [req.params.id]);
  if (!r.rows[0]) throw notFound('Empresa no encontrada');
  const ordenes = await pool.query(
    `SELECT o.id, o.codigo, o.estado, o.tipo_actividad, o.fecha_orden, o.fecha_ejecucion,
            o.horas_asignadas, a.nombre AS arl_nombre
       FROM sst.ordenes_servicio o
       LEFT JOIN sst.arls a ON a.id = o.arl_id
      WHERE o.empresa_id = $1
      ORDER BY o.fecha_carga DESC
      LIMIT 20`,
    [req.params.id]
  );
  res.json({ data: r.rows[0], ordenes: ordenes.rows });
}));

// CFG-02 · Alta manual (admin).
router.post('/', requireRole('admin'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  const nombre = limpiar(b.nombre);
  const nit = limpiar(b.nit);
  if (!nombre) throw badRequest('El nombre de la empresa es obligatorio');
  if (!nit) throw badRequest('El NIT es obligatorio');
  await assertNitDisponible(nit);

  const valores = CAMPOS_EDITABLES.map((c) => limpiar(b[c]));
  const r = await pool.query(
    `INSERT INTO sst.empresas (nit, ${CAMPOS_EDITABLES.join(', ')})
     VALUES ($1, ${CAMPOS_EDITABLES.map((_, i) => `$${i + 2}`).join(', ')})
     RETURNING ${EMPRESA_COLS}`,
    [nit, ...valores]
  );
  res.status(201).json({ data: r.rows[0] });
}));

// CFG-02 · Edición (admin). Los campos ausentes conservan su valor.
router.put('/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  const nit = b.nit === undefined ? null : limpiar(b.nit);
  if (b.nit !== undefined && !nit) throw badRequest('El NIT no puede quedar vacío');
  if (b.nombre !== undefined && !limpiar(b.nombre)) throw badRequest('El nombre no puede quedar vacío');
  if (nit) await assertNitDisponible(nit, req.params.id);

  // COALESCE por campo: el formulario envía la ficha completa, pero un cliente
  // que mande solo un campo (o el toggle de estado) no debe borrar el resto.
  const sets = CAMPOS_EDITABLES.map((c, i) => `${c} = COALESCE($${i + 3}, ${c})`);
  const r = await pool.query(
    `UPDATE sst.empresas
        SET nit = COALESCE($2, nit), ${sets.join(', ')}, actualizado_en = now()
      WHERE id = $1
      RETURNING ${EMPRESA_COLS}`,
    [req.params.id, nit, ...CAMPOS_EDITABLES.map((c) => (b[c] === undefined ? null : limpiar(b[c])))]
  );
  if (!r.rows[0]) throw notFound('Empresa no encontrada');
  res.json({ data: r.rows[0] });
}));

// CFG-02 · Activar / desactivar (admin). Una empresa inactiva conserva su
// historial de órdenes; solo deja de ofrecerse en los listados operativos.
router.patch('/:id/estado', requireRole('admin'), asyncHandler(async (req, res) => {
  const r = await pool.query(
    `UPDATE sst.empresas SET activo = NOT activo, actualizado_en = now()
      WHERE id=$1 RETURNING ${EMPRESA_COLS}`,
    [req.params.id]
  );
  if (!r.rows[0]) throw notFound('Empresa no encontrada');
  res.json({ data: r.rows[0] });
}));

/**
 * CFG-02 · Baja definitiva (admin).
 *
 * Con órdenes enlazadas se rechaza: perder la ficha dejaría esas OS apuntando a
 * nada. La excepción es `?reasignar_a=<id>`, que primero traspasa las órdenes a
 * otra empresa — es la forma de fusionar los duplicados que genera un NIT mal
 * leído por el OCR, el único caso en que borrar tiene sentido.
 */
router.delete('/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const destinoId = req.query.reasignar_a || null;
  if (destinoId === req.params.id) throw badRequest('No se puede reasignar una empresa a sí misma');

  const resultado = await withTransaction(async (client) => {
    const emp = await client.query(`SELECT id, nombre FROM sst.empresas WHERE id=$1 FOR UPDATE`, [req.params.id]);
    if (!emp.rows[0]) throw notFound('Empresa no encontrada');

    let reasignadas = 0;
    if (destinoId) {
      const destino = await client.query(`SELECT id, nombre FROM sst.empresas WHERE id=$1`, [destinoId]);
      if (!destino.rows[0]) throw notFound('La empresa destino no existe');
      const upd = await client.query(
        `UPDATE sst.ordenes_servicio SET empresa_id=$2 WHERE empresa_id=$1`,
        [req.params.id, destinoId]
      );
      reasignadas = upd.rowCount;
    } else {
      const cnt = await client.query(
        `SELECT count(*)::int AS c FROM sst.ordenes_servicio WHERE empresa_id=$1`, [req.params.id]
      );
      if (cnt.rows[0].c > 0) {
        throw conflict(
          `${emp.rows[0].nombre} tiene ${cnt.rows[0].c} orden(es) de servicio asociadas. ` +
          'Desactívela o fusiónela con otra empresa en lugar de eliminarla.'
        );
      }
    }
    await client.query(`DELETE FROM sst.empresas WHERE id=$1`, [req.params.id]);
    return { id: req.params.id, reasignadas };
  });
  res.json({ data: resultado });
}));

export default router;
