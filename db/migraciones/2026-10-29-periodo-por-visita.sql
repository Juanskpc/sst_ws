-- 29-oct-2026 · El mes de la cuenta de cobro es el de la VISITA, no el de la subida de soportes.
--
-- Hallado en producción con la cuenta de octubre de José Luis Guacas: 17 de sus 18 líneas eran
-- visitas de julio a septiembre. `ordenes_servicio.fecha_ejecucion` la pone el trigger de estado en
-- now() al pasar a EJECUTADA (cuando el asesor sube los soportes), y el 20-oct se subieron de golpe
-- los formatos de órdenes viejas para facturar: todas cayeron en octubre. Le pasaba a 7 asesores.
--
-- Ahora la fecha de trabajo de una orden es la de su ÚLTIMA franja de visita; solo sin franjas
-- (órdenes viejas o particulares sin agenda) se cae a lo de antes. Lo usan la cuenta de cobro y el
-- informe de horas (RPT-05), que también medía por la fecha de subida.
--
-- Además repara las cuentas ABIERTAS (generada/rechazada): las líneas de otro mes salen de la cuenta
-- (vuelven a quedar por cobrar en el mes de su visita), las que se quedan toman la fecha de la
-- visita, se recalculan los totales y se borra la cuenta que quede vacía. Las enviadas y aceptadas
-- no se tocan: el profesional ya las vio.
--
-- Idempotente.
--   node scripts/aplicar-migracion.mjs db/migraciones/2026-10-29-periodo-por-visita.sql

BEGIN;

-- Mismas columnas y tipos: CREATE OR REPLACE basta y no arrastra vw_horas_por_cobrar.
CREATE OR REPLACE VIEW sst.vw_horas_ejecutadas AS
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
       -- 29-oct-2026 · El día de la última visita, no el de la subida de soportes.
       COALESCE(fv.ultima, o.fecha_ejecucion::date, o.fecha_programada::date, o.actualizado_en::date) AS fecha_ejecucion,
       to_char(COALESCE(fv.ultima, o.fecha_ejecucion::date, o.fecha_programada::date, o.actualizado_en::date), 'YYYY-MM') AS periodo,
       o.soportes_aceptados_en
FROM sst.ordenes_servicio o
LEFT JOIN sst.arls a          ON a.id = o.arl_id
LEFT JOIN sst.profesionales p ON p.id = o.profesional_asignado_id
LEFT JOIN sst.tipos_orden tp  ON tp.id = o.tipo_orden_id
LEFT JOIN (SELECT orden_id, sum(horas) AS horas FROM sst.orden_coasesores GROUP BY orden_id) co
       ON co.orden_id = o.id
LEFT JOIN (SELECT orden_id, max(fecha) AS ultima FROM sst.franjas_visita GROUP BY orden_id) fv
       ON fv.orden_id = o.id
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
       COALESCE(fv.ultima, o.fecha_ejecucion::date, o.fecha_programada::date, o.actualizado_en::date),
       to_char(COALESCE(fv.ultima, o.fecha_ejecucion::date, o.fecha_programada::date, o.actualizado_en::date), 'YYYY-MM'),
       o.soportes_aceptados_en
FROM sst.orden_coasesores c
JOIN sst.ordenes_servicio o   ON o.id = c.orden_id
JOIN sst.profesionales p      ON p.id = c.profesional_id
LEFT JOIN sst.arls a          ON a.id = o.arl_id
LEFT JOIN sst.tipos_orden tp  ON tp.id = o.tipo_orden_id
LEFT JOIN (SELECT orden_id, max(fecha) AS ultima FROM sst.franjas_visita GROUP BY orden_id) fv
       ON fv.orden_id = o.id
WHERE o.estado IN ('EJECUTADA','FINALIZADA') AND o.profesional_asignado_id IS NOT NULL;

-- ── Reparación de las cuentas abiertas ──────────────────────────────────────
CREATE TEMP TABLE _lineas_otro_mes ON COMMIT DROP AS
SELECT i.id AS item_id, pc.id AS precuenta_id, p.nombre AS profesional, pc.periodo,
       i.orden_codigo, i.orden_referencia, h.periodo AS periodo_visita
  FROM sst.precuenta_items i
  JOIN sst.precuentas pc   ON pc.id = i.precuenta_id
  JOIN sst.profesionales p ON p.id = pc.profesional_id
  JOIN sst.vw_horas_ejecutadas h ON h.orden_id = i.orden_id AND h.profesional_id = pc.profesional_id
 WHERE pc.estado IN ('generada', 'rechazada') AND NOT i.manual AND h.periodo <> pc.periodo;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM _lineas_otro_mes ORDER BY profesional, orden_codigo LOOP
    RAISE NOTICE 'Sale de la cuenta % de %: % (%) → visita de %',
      r.periodo, r.profesional, r.orden_referencia, r.orden_codigo, r.periodo_visita;
  END LOOP;
END $$;

DELETE FROM sst.precuenta_items WHERE id IN (SELECT item_id FROM _lineas_otro_mes);

-- Las que se quedan, con el día de la visita.
UPDATE sst.precuenta_items i
   SET fecha_ejecucion = h.fecha_ejecucion
  FROM sst.precuentas pc, sst.vw_horas_ejecutadas h
 WHERE pc.id = i.precuenta_id AND pc.estado IN ('generada', 'rechazada') AND NOT i.manual
   AND h.orden_id = i.orden_id AND h.profesional_id = pc.profesional_id
   AND i.fecha_ejecucion IS DISTINCT FROM h.fecha_ejecucion;

-- Cuenta abierta que se quedó sin líneas: se borra (su trabajo vuelve a estar por cobrar).
DELETE FROM sst.precuentas pc
 WHERE pc.id IN (SELECT precuenta_id FROM _lineas_otro_mes)
   AND NOT EXISTS (SELECT 1 FROM sst.precuenta_items i WHERE i.precuenta_id = pc.id);

UPDATE sst.precuentas pc
   SET total_horas = t.horas, total_monto = t.honorarios + t.viaticos, total_viaticos = t.viaticos, actualizado_en = now()
  FROM (SELECT precuenta_id, COALESCE(sum(horas),0) AS horas, COALESCE(sum(monto),0) AS honorarios,
               COALESCE(sum(viaticos),0) AS viaticos
          FROM sst.precuenta_items GROUP BY precuenta_id) t
 WHERE t.precuenta_id = pc.id AND pc.id IN (SELECT precuenta_id FROM _lineas_otro_mes);

COMMIT;
