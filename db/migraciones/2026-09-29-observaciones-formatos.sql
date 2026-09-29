-- 29-sep-2026 · Vista previa de formatos antes de enviarlos al profesional.
--
--   · `observaciones_formatos`: lo que el administrador escribe en la casilla de
--     observaciones de cada formato durante la vista previa de la asignación,
--     como `{ "<formato>": "texto" }` (claves de `formatos-arl.service.js`:
--     at031, at028, prestacionColmena, asistenciaColmena).
--
-- Se guarda en la orden, y no solo dentro del PDF, para que reprogramar o
-- regenerar los formatos no las pierda y la vista previa aparezca ya rellena.
--
-- ADITIVO: una columna con DEFAULT '{}' (las órdenes existentes quedan sin
-- observaciones y sus formatos salen igual que antes). Idempotente.
--
-- Mismo motivo que las migraciones anteriores para NO correr `npm run migrate`
-- entero (trampa 86).
--
-- ⚠️ Aplicar ANTES de desplegar el código: la asignación ya escribe la columna.
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-09-29-observaciones-formatos.sql

BEGIN;

ALTER TABLE sst.ordenes_servicio
  ADD COLUMN IF NOT EXISTS observaciones_formatos JSONB NOT NULL DEFAULT '{}'::jsonb;

-- `vw_ordenes_expandidas` es `SELECT o.*` y Postgres congela sus columnas al
-- crearla (trampa 69): sin recrearla, la columna nueva no llega a la vista que
-- lee `generateOrderDocuments`. Bloque copiado literal de `db/schema.sql`.
DROP VIEW IF EXISTS sst.vw_ordenes_expandidas;
CREATE VIEW sst.vw_ordenes_expandidas AS
SELECT o.*,
       a.nombre         AS arl_nombre,
       a.formato_origen AS arl_formato,
       p.nombre         AS profesional_nombre,
       p.correo         AS profesional_correo,
       -- ASG · Quién firma los formatos cuando NO es quien ejecuta (el
       -- profesional registrado ante la ARL). NULL en el caso normal.
       pf.nombre        AS profesional_formatos_nombre,
       -- CFG-04 · El NOMBRE del tipo de orden viaja resuelto: la vista de
       -- Órdenes lo enseña en cada fila y pedir el catálogo aparte para
       -- traducir un id sería un viaje por pantalla.
       tp.nombre        AS tipo_orden,
       tp.valor_hora    AS tipo_orden_valor_hora,
       -- La categoría del viático, resuelta por el mismo motivo: el detalle de
       -- la orden y el informe de facturación la enseñan junto a la cifra, y sin
       -- el nombre un importe suelto no dice de qué es.
       tv.nombre        AS viaticos_tipo,
       tv.valor         AS viaticos_tipo_valor
FROM sst.ordenes_servicio o
JOIN sst.arls a               ON a.id = o.arl_id
LEFT JOIN sst.profesionales p ON p.id = o.profesional_asignado_id
LEFT JOIN sst.profesionales pf ON pf.id = o.profesional_formatos_id
LEFT JOIN sst.tipos_orden tp  ON tp.id = o.tipo_orden_id
LEFT JOIN sst.tipos_viatico tv ON tv.id = o.viaticos_tipo_id;

COMMIT;

-- Comprobación posterior (tiene que salir UNA fila):
--
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='sst' AND table_name='vw_ordenes_expandidas'
--      AND column_name = 'observaciones_formatos';
