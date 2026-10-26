-- P1 (26-oct-2026) · La campanita y los correos nombran la orden por su
-- cronograma_secuencia (Bolívar) o su número de orden (demás ARL), no por el
-- código OS interno. El aviso de «encuesta respondida» sale de `vw_encuestas`,
-- así que la vista tiene que exponer esas columnas de la orden.
--
-- `vw_encuestas` es una vista de las de `SELECT` sobre columnas concretas: al
-- añadir columnas hay que RECREARLA (Postgres congela la lista al crearla,
-- trampa 69), y con ella su dependiente `vw_profesionales_desempeno` (la vista
-- del desempeño lee `vw_encuestas` en un LATERAL). Se recrean las dos, idénticas
-- a `schema.sql`, salvo las tres columnas nuevas.

DROP VIEW IF EXISTS sst.vw_encuestas CASCADE;
CREATE VIEW sst.vw_encuestas AS
SELECT e.id,
       e.orden_id,
       o.codigo                                   AS orden_codigo,
       o.codigo_cronograma,
       o.secuencia,
       o.numero_orden,
       COALESCE(e.empresa_nombre, o.empresa_nombre) AS empresa_nombre,
       COALESCE(e.arl_id, o.arl_id)               AS arl_id,
       a.nombre                                   AS arl_nombre,
       COALESCE(e.profesional_id, o.profesional_asignado_id) AS profesional_id,
       p.nombre                                   AS profesional_nombre,
       o.actividad_economica,
       o.horas_asignadas,
       o.fecha_programada,
       e.contacto_nombre,
       e.contacto_correo,
       e.satisfaccion,
       e.calificacion_profesional,
       COALESCE(e.calificacion_profesional, e.satisfaccion) AS nota_profesional,
       e.recomendacion,
       e.comentarios,
       e.preguntas,
       e.enviado_en,
       e.respondido_en,
       e.respondido_en IS NOT NULL                AS respondida,
       date_trunc('month', COALESCE(e.respondido_en, e.enviado_en, e.creado_en)) AS mes
FROM sst.respuestas_encuesta e
JOIN sst.ordenes_servicio o     ON o.id = e.orden_id
LEFT JOIN sst.arls a            ON a.id = COALESCE(e.arl_id, o.arl_id)
LEFT JOIN sst.profesionales p   ON p.id = COALESCE(e.profesional_id, o.profesional_asignado_id);

DROP VIEW IF EXISTS sst.vw_profesionales_desempeno;
CREATE VIEW sst.vw_profesionales_desempeno AS
SELECT p.id AS profesional_id,
       COALESCE(o.ordenes_ejecutadas, 0)   AS ordenes_ejecutadas,
       COALESCE(e.encuestas_enviadas, 0)   AS encuestas_enviadas,
       COALESCE(e.encuestas_respondidas, 0) AS encuestas_respondidas,
       e.calificacion_promedio,
       e.ultima_calificacion_en
FROM sst.profesionales p
LEFT JOIN LATERAL (
  SELECT count(*)::int AS ordenes_ejecutadas
    FROM sst.ordenes_servicio os
   WHERE os.profesional_asignado_id = p.id AND os.estado IN ('EJECUTADA','FINALIZADA')
) o ON true
LEFT JOIN LATERAL (
  SELECT count(*)::int                                    AS encuestas_enviadas,
         count(*) FILTER (WHERE v.respondida)::int        AS encuestas_respondidas,
         round(avg(v.nota_profesional) FILTER (WHERE v.respondida)::numeric, 2) AS calificacion_promedio,
         max(v.respondido_en)                             AS ultima_calificacion_en
    FROM sst.vw_encuestas v
   WHERE v.profesional_id = p.id
) e ON true;
