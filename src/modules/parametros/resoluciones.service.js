import { pool, withTransaction } from '../../config/db.js';
import { proveedorFE } from '../facturacion/index.js';

/**
 * A0-08 · Resoluciones de numeración (FEL-13).
 *
 * La autoridad sobre la numeración es el proveedor: aquí se guarda una copia para
 * poder avisar cuando una resolución se vence o se agota, y para que el resto de
 * Orbita sepa qué rango usar. Las resoluciones reales de JD&D NO se siembran
 * (R-01): llegan con "Sincronizar con el proveedor".
 */

const SELECT = `
  r.id, r.tipo_documento, r.prefijo, r.desde, r.hasta, r.consecutivo_actual,
  r.numero_resolucion,
  to_char(r.fecha_desde, 'YYYY-MM-DD') AS fecha_desde,
  to_char(r.fecha_hasta, 'YYYY-MM-DD') AS fecha_hasta,
  (r.fecha_hasta - CURRENT_DATE) AS dias_para_vencer,
  r.factus_rango_id, r.activa, r.sincronizada_en,
  CASE WHEN r.hasta IS NULL OR r.desde IS NULL THEN NULL
       ELSE GREATEST(r.hasta - r.consecutivo_actual, 0) END AS numeros_restantes,
  CASE WHEN r.hasta IS NULL OR r.desde IS NULL THEN NULL
       ELSE round(100.0 * GREATEST(r.hasta - r.consecutivo_actual, 0) / (r.hasta - r.desde + 1), 1) END AS porcentaje_restante`;

export async function listarResoluciones(client = pool) {
  const r = await client.query(
    `SELECT ${SELECT} FROM sst.resoluciones_numeracion r
      ORDER BY r.activa DESC, r.tipo_documento, r.prefijo`,
  );
  return r.rows;
}

/**
 * Trae los rangos del proveedor y los guarda (upsert por el id del rango). Un
 * rango de un documento que Orbita no emite (Nota Débito) o que el adaptador no
 * sabe clasificar se OMITE y se dice cuál, en vez de adivinar su tipo.
 */
export async function sincronizarResoluciones() {
  const rangos = await proveedorFE().listarRangosNumeracion();

  const resumen = { creadas: 0, actualizadas: 0, omitidas: [] };
  await withTransaction(async (client) => {
    for (const x of rangos) {
      if (!x.tipoDocumento) {
        resumen.omitidas.push({ documento: x.documentoProveedor, prefijo: x.prefijo, motivo: 'Orbita no emite este tipo de documento' });
        continue;
      }
      const r = await client.query(
        `INSERT INTO sst.resoluciones_numeracion
           (tipo_documento, prefijo, desde, hasta, consecutivo_actual, numero_resolucion,
            fecha_desde, fecha_hasta, factus_rango_id, activa, sincronizada_en)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
         ON CONFLICT (factus_rango_id) DO UPDATE
            SET tipo_documento = EXCLUDED.tipo_documento, prefijo = EXCLUDED.prefijo,
                desde = EXCLUDED.desde, hasta = EXCLUDED.hasta,
                consecutivo_actual = EXCLUDED.consecutivo_actual,
                numero_resolucion = EXCLUDED.numero_resolucion,
                fecha_desde = EXCLUDED.fecha_desde, fecha_hasta = EXCLUDED.fecha_hasta,
                activa = EXCLUDED.activa, sincronizada_en = now()
         RETURNING (xmax = 0) AS nueva`,
        [x.tipoDocumento, x.prefijo, x.desde, x.hasta, x.actual, x.numeroResolucion,
          x.fechaDesde, x.fechaHasta, x.proveedorId, x.activo],
      );
      if (r.rows[0].nueva) resumen.creadas++; else resumen.actualizadas++;
    }
  });
  return resumen;
}
