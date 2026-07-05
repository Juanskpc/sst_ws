import { Router } from 'express';
import { pool, withTransaction } from '../../config/db.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { uploadSupports } from '../../middleware/upload.js';
import { badRequest, notFound } from '../../utils/httpError.js';
import { storage } from '../../services/storage.service.js';
import { changeStatus } from '../orders/orders.service.js';
import { notifyAdmins } from '../../services/notification.service.js';

const router = Router();

// Resuelve un token de enlace público activo → OS asociada.
async function resolveToken(token, client = pool) {
  const r = await client.query(
    `SELECT pl.id AS enlace_id, pl.activo, pl.expira_en, o.*
     FROM sst.enlaces_publicos pl JOIN sst.ordenes_servicio o ON o.id = pl.orden_id
     WHERE pl.token=$1`, [token]
  );
  const row = r.rows[0];
  if (!row) throw notFound('Enlace inválido');
  if (!row.activo) throw badRequest('El enlace ya no está activo');
  if (row.expira_en && new Date(row.expira_en) < new Date()) throw badRequest('El enlace expiró');
  return row;
}

// M6 · Resumen de la OS para el portal público (SIN login).
router.get('/support/:token', asyncHandler(async (req, res) => {
  const row = await resolveToken(req.params.token);
  const arl = await pool.query(`SELECT nombre FROM sst.arls WHERE id=$1`, [row.arl_id]);
  const files = await pool.query(
    `SELECT id, nombre_original, mime, subido_en FROM sst.archivos_soporte WHERE orden_id=$1 ORDER BY subido_en`,
    [row.id]
  );
  res.json({
    data: {
      codigo: row.codigo,
      empresa_nombre: row.empresa_nombre,
      arl_nombre: arl.rows[0]?.nombre,
      actividad_economica: row.actividad_economica,
      horas_asignadas: row.horas_asignadas,
      fecha_programada: row.fecha_programada,
      estado: row.estado,
      soportes_cargados: files.rows,
    },
  });
}));

// M6 · Subir soportes firmados (SIN login). Múltiples archivos. → EN VERIFICACIÓN.
router.post('/support/:token/files', uploadSupports.array('files', 10), asyncHandler(async (req, res) => {
  if (!req.files?.length) throw badRequest('Adjunta al menos un archivo en "files"');

  const result = await withTransaction(async (client) => {
    const row = await resolveToken(req.params.token, client);
    if (!['PROGRAMADA', 'EN VERIFICACIÓN'].includes(row.estado)) {
      throw badRequest(`No se pueden subir soportes en estado ${row.estado}`);
    }
    const saved = [];
    for (const f of req.files) {
      const key = await storage.put(`supports/${row.id}`, f.originalname, f.buffer);
      const sf = await client.query(
        `INSERT INTO sst.archivos_soporte (orden_id, enlace_publico_id, url_archivo, nombre_original, mime, tamano_bytes, via_enlace_publico)
         VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING id, nombre_original, mime`,
        [row.id, row.enlace_id, key, f.originalname, f.mimetype, f.size]
      );
      saved.push(sf.rows[0]);
    }
    // SUP-05 · al subir, la OS pasa automáticamente a EN VERIFICACIÓN (si estaba PROGRAMADA).
    if (row.estado === 'PROGRAMADA') {
      await changeStatus(
        { orderId: row.id, newStatus: 'EN VERIFICACIÓN', userId: null, motivo: 'Soportes cargados por el profesional' },
        client
      );
    }
    return { orden: row, saved };
  });

  // SUP-06/07 · avisar a administradores.
  await notifyAdmins({
    tipo: 'SOPORTE_CARGADO',
    titulo: 'Soportes recibidos',
    mensaje: `${result.orden.codigo} · ${result.orden.empresa_nombre || ''} pasó a EN VERIFICACIÓN`,
    datos: { orden_id: result.orden.id },
  });

  res.status(201).json({ message: 'Soportes cargados. La OS pasó a verificación.', data: result.saved });
}));

export default router;
