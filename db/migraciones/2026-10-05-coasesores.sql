-- 5-oct-2026 · Varios asesores en la misma orden, en las mismas fechas y horarios.
--
-- Petición de JD&D (audio del 5-oct): una orden de 8 h la ejecutan dos asesores a
-- la vez. Hasta hoy la orden tenía UN profesional, así que el segundo no recibía
-- formatos y a fin de mes las 8 h se le pagaban solo al primero.
--
-- Tabla nueva `sst.orden_coasesores` y las dos vistas de la cuenta de cobro, que
-- ahora dan una fila por (orden, profesional). Una orden sin coasesores da
-- exactamente la misma fila que antes.
--
-- ADITIVO e idempotente.
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-10-05-coasesores.sql

BEGIN;

-- 5-oct-2026 · Asesores ADICIONALES de una orden (varios asesores, mismas fechas).
--
-- Una orden de 8 h la pueden ejecutar dos asesores a la vez: van el mismo día y
-- a la misma hora, y cada uno cobra SUS horas (4 y 4). `profesional_asignado_id`
-- sigue siendo el asesor PRINCIPAL: de él son el enlace de soportes, la encuesta
-- y la firma de los formatos. Aquí van los demás, con las horas que se le
-- reconocen a cada uno y su valor hora congelado al asignar (igual que
-- `ordenes_servicio.valor_hora_cobro`).
--
-- Las horas del principal NO se guardan: son `horas_asignadas` menos la suma de
-- estas filas. Así una orden sin filas aquí se comporta exactamente como antes.
CREATE TABLE IF NOT EXISTS sst.orden_coasesores (
  orden_id          UUID NOT NULL REFERENCES sst.ordenes_servicio(id) ON DELETE CASCADE,
  profesional_id    UUID NOT NULL REFERENCES sst.profesionales(id),
  horas             NUMERIC(8,2) NOT NULL CHECK (horas > 0),
  valor_hora_cobro  NUMERIC(12,2),
  valor_hora_origen TEXT,
  creado_por        UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL,
  creado_en         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (orden_id, profesional_id)
);
CREATE INDEX IF NOT EXISTS idx_orden_coasesores_prof ON sst.orden_coasesores(profesional_id);

DROP VIEW IF EXISTS sst.vw_horas_ejecutadas CASCADE;
CREATE VIEW sst.vw_horas_ejecutadas AS
-- El asesor PRINCIPAL: las horas de la orden menos las de sus coasesores.
SELECT o.id                     AS orden_id,
       o.codigo                 AS orden_codigo,
       o.profesional_asignado_id AS profesional_id,
       p.nombre                 AS profesional_nombre,
       o.empresa_nombre,
       -- A3-01 · La orden particular no tiene ARL; la cuenta de cobro la enseña
       -- como tal en vez de dejar la casilla vacía.
       COALESCE(a.nombre, 'PARTICULAR') AS arl_nombre,
       o.tipo_actividad,
       o.actividad_economica,
       GREATEST(COALESCE(o.horas_asignadas, 0) - COALESCE(co.horas, 0), 0) AS horas,
       -- PRE-02 · Lo que se le paga por esta orden, congelado al asignarla. La
       -- cuenta de cobro lee esto y no el catálogo: cambiar el valor hora de un
       -- tipo no puede reescribir lo ya trabajado.
       o.tipo_orden_id,
       tp.nombre           AS tipo_orden,
       o.valor_hora_cobro,
       o.valor_hora_origen,
       -- Con coasesores ya no vale la columna generada de la orden (horas
       -- TOTALES × valor hora): al principal se le pagan solo las suyas.
       CASE WHEN co.horas IS NULL THEN o.valor_cobro_total
            ELSE round(GREATEST(COALESCE(o.horas_asignadas, 0) - co.horas, 0) * o.valor_hora_cobro, 2)
       END                 AS valor_cobro_total,
       -- Los viáticos viajan con las horas: la cuenta de cobro los cobra en la
       -- misma fila, como una línea aparte del mismo trabajo.
       o.viaticos_valor,
       COALESCE(o.fecha_ejecucion, o.fecha_programada, o.actualizado_en)::date AS fecha_ejecucion,
       to_char(COALESCE(o.fecha_ejecucion, o.fecha_programada, o.actualizado_en), 'YYYY-MM') AS periodo,
       o.soportes_aceptados_en
FROM sst.ordenes_servicio o
LEFT JOIN sst.arls a          ON a.id = o.arl_id
LEFT JOIN sst.profesionales p ON p.id = o.profesional_asignado_id
LEFT JOIN sst.tipos_orden tp  ON tp.id = o.tipo_orden_id
LEFT JOIN (SELECT orden_id, sum(horas) AS horas FROM sst.orden_coasesores GROUP BY orden_id) co
       ON co.orden_id = o.id
WHERE o.estado IN ('EJECUTADA','FINALIZADA') AND o.profesional_asignado_id IS NOT NULL
UNION ALL
-- Cada COASESOR: sus horas y su propio valor hora. Los viáticos de la orden son
-- del principal, así que aquí van en NULL (no se pagan dos veces).
SELECT o.id,
       o.codigo,
       c.profesional_id,
       p.nombre,
       o.empresa_nombre,
       COALESCE(a.nombre, 'PARTICULAR'),
       o.tipo_actividad,
       o.actividad_economica,
       c.horas,
       o.tipo_orden_id,
       tp.nombre,
       c.valor_hora_cobro,
       c.valor_hora_origen,
       round(c.horas * c.valor_hora_cobro, 2),
       NULL::numeric,
       COALESCE(o.fecha_ejecucion, o.fecha_programada, o.actualizado_en)::date,
       to_char(COALESCE(o.fecha_ejecucion, o.fecha_programada, o.actualizado_en), 'YYYY-MM'),
       o.soportes_aceptados_en
FROM sst.orden_coasesores c
JOIN sst.ordenes_servicio o   ON o.id = c.orden_id
JOIN sst.profesionales p      ON p.id = c.profesional_id
LEFT JOIN sst.arls a          ON a.id = o.arl_id
LEFT JOIN sst.tipos_orden tp  ON tp.id = o.tipo_orden_id
WHERE o.estado IN ('EJECUTADA','FINALIZADA') AND o.profesional_asignado_id IS NOT NULL;

DROP VIEW IF EXISTS sst.vw_horas_por_cobrar;
CREATE VIEW sst.vw_horas_por_cobrar AS
SELECT h.* FROM sst.vw_horas_ejecutadas h
 WHERE h.soportes_aceptados_en IS NOT NULL
   -- 5-oct-2026 · "Ya cobrada" se mira POR PROFESIONAL: con coasesores la misma
   -- orden entra en la cuenta de cada uno, y que uno ya la tenga en la suya no
   -- puede dar por cobradas las horas del otro.
   AND NOT EXISTS (
     SELECT 1 FROM sst.precuenta_items i
       JOIN sst.precuentas pc ON pc.id = i.precuenta_id
      WHERE i.orden_id = h.orden_id AND pc.profesional_id = h.profesional_id);

COMMIT;
