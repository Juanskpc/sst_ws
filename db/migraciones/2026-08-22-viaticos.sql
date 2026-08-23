-- Fase 3 de la tanda del 22-ago-2026 · viáticos opcionales por orden.
--
-- Mismo motivo que las anteriores para no correr `npm run migrate` entero:
-- además del esquema aplica `seed.sql` y reescribe el correo y el celular de la
-- cuenta admin del cliente desde el `.env`.
--
-- Es ADITIVO: tres columnas nulables en la orden y dos con DEFAULT 0 en la
-- cuenta de cobro. No mueve ninguna fila; las cuentas ya emitidas quedan con
-- `total_viaticos = 0` y su total no cambia.
--
-- ⚠️ Aplicar ANTES de desplegar el código de la fase 3.
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-08-22-viaticos.sql

BEGIN;

ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS viaticos_valor       NUMERIC(14,2);
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS viaticos_detalle     JSONB;
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS viaticos_observacion TEXT;

ALTER TABLE sst.precuenta_items ADD COLUMN IF NOT EXISTS viaticos       NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE sst.precuentas      ADD COLUMN IF NOT EXISTS total_viaticos NUMERIC(14,2) NOT NULL DEFAULT 0;

-- 🪤 CUATRO vistas hay que rehacer, no una. Postgres congela la lista de
-- columnas de una vista al CREARLA (trampa 69 del HANDOFF), y aquí la cadena es
-- más larga que en las migraciones anteriores:
--
--   * `vw_ordenes_expandidas` es `SELECT o.*` → hereda las tres columnas nuevas.
--   * `vw_horas_ejecutadas` NO es `*`: nombra sus columnas una a una, así que
--     hay que añadirle `viaticos_valor` a mano o la cuenta de cobro no lo ve.
--   * `vw_horas_por_cobrar` es `SELECT h.*` SOBRE la anterior, así que cae con
--     ella (CASCADE) y hay que recrearla después.
--   * `vw_precuentas` es `SELECT pc.*` → hereda `total_viaticos`.
--
-- Los bloques son copia literal de `db/schema.sql`.

DROP VIEW IF EXISTS sst.vw_ordenes_expandidas;
CREATE VIEW sst.vw_ordenes_expandidas AS
SELECT o.*,
       a.nombre         AS arl_nombre,
       a.formato_origen AS arl_formato,
       p.nombre         AS profesional_nombre,
       p.correo         AS profesional_correo,
       tp.nombre        AS tipo_orden,
       tp.valor_hora    AS tipo_orden_valor_hora
FROM sst.ordenes_servicio o
JOIN sst.arls a               ON a.id = o.arl_id
LEFT JOIN sst.profesionales p ON p.id = o.profesional_asignado_id
LEFT JOIN sst.tipos_orden tp  ON tp.id = o.tipo_orden_id;

DROP VIEW IF EXISTS sst.vw_horas_ejecutadas CASCADE;
CREATE VIEW sst.vw_horas_ejecutadas AS
SELECT o.id                     AS orden_id,
       o.codigo                 AS orden_codigo,
       o.profesional_asignado_id AS profesional_id,
       p.nombre                 AS profesional_nombre,
       o.empresa_nombre,
       a.nombre                 AS arl_nombre,
       o.tipo_actividad,
       o.actividad_economica,
       COALESCE(o.horas_asignadas, 0) AS horas,
       o.tipo_orden_id,
       tp.nombre           AS tipo_orden,
       o.valor_hora_cobro,
       o.valor_hora_origen,
       o.valor_cobro_total,
       o.viaticos_valor,
       COALESCE(o.fecha_ejecucion, o.fecha_programada, o.actualizado_en)::date AS fecha_ejecucion,
       to_char(COALESCE(o.fecha_ejecucion, o.fecha_programada, o.actualizado_en), 'YYYY-MM') AS periodo,
       o.soportes_aceptados_en
FROM sst.ordenes_servicio o
JOIN sst.arls a               ON a.id = o.arl_id
LEFT JOIN sst.profesionales p ON p.id = o.profesional_asignado_id
LEFT JOIN sst.tipos_orden tp  ON tp.id = o.tipo_orden_id
WHERE o.estado IN ('EJECUTADA','FINALIZADA') AND o.profesional_asignado_id IS NOT NULL;

CREATE VIEW sst.vw_horas_por_cobrar AS
SELECT h.* FROM sst.vw_horas_ejecutadas h
 WHERE h.soportes_aceptados_en IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM sst.precuenta_items i WHERE i.orden_id = h.orden_id);

DROP VIEW IF EXISTS sst.vw_precuentas;
CREATE VIEW sst.vw_precuentas AS
SELECT pc.*,
       p.nombre  AS profesional_nombre,
       p.correo  AS profesional_correo,
       row_number() OVER (PARTITION BY pc.profesional_id, pc.periodo ORDER BY pc.creado_en)::int AS numero,
       count(*)    OVER (PARTITION BY pc.profesional_id, pc.periodo)::int                        AS del_mes,
       (SELECT count(*)::int FROM sst.precuenta_items i WHERE i.precuenta_id = pc.id) AS total_ordenes
FROM sst.precuentas pc
JOIN sst.profesionales p ON p.id = pc.profesional_id;

COMMIT;

-- Las órdenes existentes quedan sin viáticos (NULL), que es lo correcto: la
-- inmensa mayoría no los lleva. Las de Bolívar que sí los tuvieran en su SIPAB
-- original no se rellenan solas — habría que reprocesar el archivo—; se
-- escriben a mano desde el detalle de la orden.
