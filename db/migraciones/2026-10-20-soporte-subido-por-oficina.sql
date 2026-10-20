-- 20-oct-2026 · La OFICINA sube el documento corregido de una casilla.
--
-- JD&D pidió que la encargada pueda subir ella misma un soporte que el
-- profesional subió mal (desde Órdenes → Verificación de soportes). El archivo
-- reemplaza al de la casilla, igual que en el portal; esta columna deja
-- constancia de quién lo subió. NULL = lo subió el profesional por su enlace.
--
-- ADITIVA e idempotente.
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-10-20-soporte-subido-por-oficina.sql

BEGIN;
ALTER TABLE sst.archivos_soporte
  ADD COLUMN IF NOT EXISTS subido_por_usuario_id UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL;
COMMIT;
