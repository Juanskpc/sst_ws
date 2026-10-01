-- 1-oct-2026 · Número de RADICADO de la orden (solo Bolívar).
--
-- JD&D radica ante Bolívar el paquete de cada orden y la ARL le devuelve un
-- número de radicado que necesitan mapear contra la orden. Es un dato a mano,
-- de una sola orden, que solo existe en Bolívar: se guarda en la OS (no en una
-- tabla aparte) junto a quién y cuándo lo escribió, como el «Validado plataforma».
--
-- ADITIVO e idempotente.
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-10-01-numero-radicado.sql

BEGIN;

ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS numero_radicado     TEXT;
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS numero_radicado_en  TIMESTAMPTZ;
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS numero_radicado_por UUID REFERENCES sst.usuarios(id);

COMMIT;
