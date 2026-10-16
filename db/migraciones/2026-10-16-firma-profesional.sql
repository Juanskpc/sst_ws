-- 16-oct-2026 · FIRMA DIGITAL del profesional.
--
-- JD&D pidió que cada asesor tenga su firma guardada en el sistema. Se sube desde
-- Profesionales (editar la ficha) como imagen PNG o JPG. Como todo binario, en la BD
-- va solo la key del almacenamiento; el archivo vive en `storage` (local o S3).
--
-- ADITIVA e idempotente: sin firma = las tres columnas vacías, como hasta hoy.
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-10-16-firma-profesional.sql

BEGIN;
ALTER TABLE sst.profesionales ADD COLUMN IF NOT EXISTS firma_url TEXT;
ALTER TABLE sst.profesionales ADD COLUMN IF NOT EXISTS firma_mime TEXT;
ALTER TABLE sst.profesionales ADD COLUMN IF NOT EXISTS firma_actualizada_en TIMESTAMPTZ;
COMMIT;
