import { pool } from '../../config/db.js';

/**
 * 7-oct-2026 (reunión con JD&D) · Recordatorio de órdenes próximas a ejecutar.
 *
 * Una fila por VISITA programada (franja), no por orden: una orden de varios días
 * aparece una vez por cada día que falta, y lo que importa es la visita que viene.
 * Los asesores que comparten la misma franja van juntos en la fila.
 *
 * Entran las órdenes PROGRAMADAS con una visita desde hace `diasAtras` días (las que
 * ya pasaron y siguen sin soportes: «atrasadas») hasta dentro de `dias` días. Los
 * minutos que faltan se calculan en hora de Colombia, que es en la que se escribió
 * la franja (la base corre en UTC).
 */
export async function ordenesProximas({ dias = 7, diasAtras = 3 } = {}, db = pool) {
  const d = Math.min(Math.max(Number.parseInt(dias, 10) || 7, 1), 60);
  const atras = Math.min(Math.max(Number.parseInt(diasAtras, 10) || 0, 0), 30);
  const r = await db.query(
    `WITH ahora AS (SELECT (now() AT TIME ZONE 'America/Bogota') AS t)
     SELECT o.id AS orden_id, o.codigo, o.empresa_nombre,
            COALESCE(a.nombre, NULLIF(btrim(COALESCE(tp.razon_social, concat_ws(' ', tp.nombres, tp.apellidos))), '')) AS pagador,
            o.ciudad_ejecucion, o.direccion, o.modalidad_ejecucion,
            COALESCE(NULLIF(btrim(o.tema_actividad), ''), o.descripcion) AS actividad,
            to_char(f.fecha, 'YYYY-MM-DD') AS fecha,
            to_char(f.hora_inicio, 'HH24:MI') AS hora_inicio,
            to_char(f.hora_fin, 'HH24:MI') AS hora_fin,
            string_agg(DISTINCT COALESCE(pf.nombre, pa.nombre), ' · ' ORDER BY COALESCE(pf.nombre, pa.nombre)) AS asesores,
            round(extract(epoch FROM ((f.fecha + f.hora_inicio) - (SELECT t FROM ahora))) / 60)::int AS minutos_para_iniciar,
            round(extract(epoch FROM ((f.fecha + f.hora_fin) - (SELECT t FROM ahora))) / 60)::int AS minutos_para_terminar
       FROM sst.franjas_visita f
       JOIN sst.ordenes_servicio o ON o.id = f.orden_id
       LEFT JOIN sst.arls a ON a.id = o.arl_id
       LEFT JOIN sst.terceros tp ON tp.id = o.pagador_tercero_id
       LEFT JOIN sst.profesionales pa ON pa.id = o.profesional_asignado_id
       LEFT JOIN sst.profesionales pf ON pf.id = f.profesional_id
      WHERE o.estado = 'PROGRAMADA'
        AND f.fecha >= (SELECT t FROM ahora)::date - $2::int
        AND f.fecha <= (SELECT t FROM ahora)::date + $1::int
      GROUP BY o.id, o.codigo, o.empresa_nombre, a.nombre, tp.razon_social, tp.nombres, tp.apellidos,
               o.ciudad_ejecucion, o.direccion, o.modalidad_ejecucion, o.tema_actividad, o.descripcion,
               f.fecha, f.hora_inicio, f.hora_fin
      ORDER BY f.fecha, f.hora_inicio, o.codigo`,
    [d, atras],
  );
  return r.rows;
}
