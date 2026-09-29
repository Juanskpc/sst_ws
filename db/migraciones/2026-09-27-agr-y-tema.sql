-- Tanda 0 de correcciones (27-sep-2026) · fichas T0-04 y T0-05.
--
--   · T0-04 · `asesor_gestion_riesgo`: el AGR que trae el SIPAB de Bolívar
--             (casilla 16 del AT-031).
--   · T0-05 · `tema_actividad`: el tema/actividad que se escribe a mano para el
--             AT-031 ("Temas desarrollados") y el AT-028 ("Tema y/o actividad").
--
-- Van juntas en un solo archivo porque las dos tocan `ordenes_servicio` y, por
-- tanto, obligan a rehacer la misma vista (trampa 69).
--
-- Mismo motivo que las migraciones anteriores para NO correr `npm run migrate`
-- entero: además del esquema aplica `seed.sql` y reescribe la cuenta admin del
-- cliente (trampa 86).
--
-- Es ADITIVO: dos columnas nulables, sin DEFAULT. No mueve ninguna fila; las
-- órdenes existentes quedan con las dos en NULL y los formatos salen como
-- salían. Idempotente: se puede repetir.
--
-- ⚠️ Aplicar ANTES de desplegar el código de T0-04/T0-05: el INSERT de
-- `materializarOrden` ya nombra `asesor_gestion_riesgo`, así que sin la columna
-- falla la confirmación de cualquier orden importada, no solo las de Bolívar.
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-09-27-agr-y-tema.sql

BEGIN;

ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS asesor_gestion_riesgo TEXT;
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS tema_actividad        TEXT;

-- `vw_ordenes_expandidas` es `SELECT o.*`: Postgres congela su lista de columnas
-- al crearla, así que sin recrearla las dos columnas nuevas existen en la tabla
-- pero NO en la vista, que es lo que lee el detalle y el listado de órdenes.
-- Ninguna otra vista depende de ella (comprobado en jdd_dev), por eso basta el
-- DROP sin CASCADE. Bloque copiado literal de `db/schema.sql`.
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

-- Comprobación posterior recomendada (mirar solo la tabla no sirve: ahí siempre
-- están):
--
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='sst' AND table_name='vw_ordenes_expandidas'
--      AND column_name IN ('asesor_gestion_riesgo','tema_actividad');
--
-- Tienen que salir las DOS.
