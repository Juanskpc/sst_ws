-- Fase A · facturación · A1-05 · enlaza el historial de cobro con el documento
-- electrónico que lo produjo (28-sep-2026).
--
-- Solo el cambio (no correr `npm run migrate` entero: trampa 86). Aditiva: una
-- columna NULL en una tabla existente, nada se reescribe.
--
-- `sst.historial_cobro_orden` ya existía (tanda del 22-ago-2026, M13): guarda
-- cada cambio de `estado_cobro`, tanto el manual (`PATCH /orders/cobro`, Siigo
-- durante la transición) como el que ahora dispara la emisión de una factura de
-- Orbita. `documento_id` es NULL en el primer caso y el id del documento
-- VALIDADO en el segundo: con eso, `PATCH /orders/cobro` puede negarse a
-- desmarcar una orden que se facturó desde Orbita (ficha A1-05 — "eso se hace
-- con nota crédito", A2-01).
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-09-28-historial-cobro-documento.sql

BEGIN;

ALTER TABLE sst.historial_cobro_orden
  ADD COLUMN IF NOT EXISTS documento_id UUID REFERENCES sst.documentos_electronicos(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_historial_cobro_orden_documento ON sst.historial_cobro_orden(documento_id);

COMMIT;

-- Comprobación posterior recomendada:
--
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='sst' AND table_name='historial_cobro_orden' AND column_name='documento_id';
