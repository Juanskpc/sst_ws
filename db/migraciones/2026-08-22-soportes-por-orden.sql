-- Fase 2 de la tanda del 22-ago-2026 · los soportes dependen de la orden.
--
-- Mismo motivo que la migración anterior para no correr `npm run migrate`
-- entero: además del esquema aplica `seed.sql` y reescribe el correo y el
-- celular de la cuenta admin del cliente desde el `.env`.
--
-- Es ADITIVO: una columna nulable. No mueve ninguna fila y se deshace con
-- `DROP COLUMN`. Idempotente.
--
-- ⚠️ Aplicar ANTES de desplegar el código de la fase 2: la asignación
-- (`POST /orders/:id/assign`) ya escribe esta columna.
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-08-22-soportes-por-orden.sql

BEGIN;

ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS soportes_requeridos TEXT[];

-- `vw_ordenes_expandidas` es `SELECT o.*` y Postgres congela esa lista al CREAR
-- la vista, así que hay que rehacerla o la columna nueva no llega al código que
-- lee de ella. Ver trampa 69 del HANDOFF.
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

COMMIT;

-- Las órdenes YA ASIGNADAS quedan con la columna en NULL, y eso es lo correcto:
-- su enlace público sigue vivo y el portal les pide las tres casillas de
-- siempre, que son las que se les pidieron en su correo. Solo las órdenes que se
-- asignen (o se reprogramen) a partir de ahora estrenan la lista por ARL.
