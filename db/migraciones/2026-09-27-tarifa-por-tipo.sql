-- Tanda 0 de correcciones (27-sep-2026) · ficha T0-10: el valor hora "estándar" de los socios.
--
-- La tarifa pactada de un profesional se buscaba por TEXTO (`lower(actividad) =
-- lower(tipo.nombre)`): "Capacitacion" sin tilde, un doble espacio o un tipo
-- renombrado no casaban, y la orden caía al valor del tipo sin avisar. Ahora la
-- tarifa apunta al tipo de orden por id.
--
-- Qué hace:
--   1. `sst.norm_texto()`: la ÚNICA normalización (minúsculas, sin tildes, espacios
--      colapsados). Con `translate`, sin la extensión `unaccent`.
--   2. `tarifas_actividad_profesional.tipo_orden_id` (nulable) + índice.
--   3. Backfill: enlaza cada tarifa existente con el tipo de mismo nombre
--      normalizado. Las que no casen quedan en NULL (la pantalla las marca y el
--      cálculo las sigue resolviendo por nombre normalizado).
--
-- Es ADITIVO e idempotente: una función, una columna nulable y un UPDATE que solo
-- toca filas sin tipo. No borra ni reescribe `actividad`. No usa `npm run migrate`
-- (trampa 86).
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-09-27-tarifa-por-tipo.sql
--
-- Después de aplicarla, para saber cuántas tarifas quedaron huérfanas:
--   SELECT actividad, count(*) FROM sst.tarifas_actividad_profesional
--    WHERE tipo_orden_id IS NULL GROUP BY 1;

BEGIN;

CREATE OR REPLACE FUNCTION sst.norm_texto(t TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT btrim(regexp_replace(
    translate(lower(coalesce(t, '')), 'áéíóúüñ', 'aeiouun'), '\s+', ' ', 'g'))
$$;

ALTER TABLE sst.tarifas_actividad_profesional
  ADD COLUMN IF NOT EXISTS tipo_orden_id UUID REFERENCES sst.tipos_orden(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_tarifas_prof_tipo
  ON sst.tarifas_actividad_profesional(profesional_id, tipo_orden_id);

UPDATE sst.tarifas_actividad_profesional ta
   SET tipo_orden_id = t.id
  FROM sst.tipos_orden t
 WHERE ta.tipo_orden_id IS NULL
   AND sst.norm_texto(ta.actividad) = sst.norm_texto(t.nombre);

COMMIT;
