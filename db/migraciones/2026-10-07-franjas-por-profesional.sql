-- 7-oct-2026 · Franjas de visita POR ASESOR.
--
-- Petición de JD&D: cuando una orden la ejecutan varios asesores, cada uno tiene
-- su propio horario (el mismo día y hora que los demás, o no) y sus formatos
-- salen con sus fechas y sus horas. Hasta ahora las franjas eran de la orden y
-- los asesores adicionales (`sst.orden_coasesores`, 5-oct) iban todos a las mismas.
--
-- `profesional_id` NULL = la franja es del asesor principal
-- (`ordenes_servicio.profesional_asignado_id`): es lo que tienen todas las filas
-- existentes, así que nada cambia para las órdenes de un solo asesor.
--
-- ADITIVA e idempotente. Va después de `2026-10-05-coasesores.sql`.
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-10-07-franjas-por-profesional.sql

BEGIN;

ALTER TABLE sst.franjas_visita
  ADD COLUMN IF NOT EXISTS profesional_id UUID REFERENCES sst.profesionales(id);
CREATE INDEX IF NOT EXISTS idx_franjas_visita_profesional ON sst.franjas_visita(profesional_id);

COMMIT;
