-- 9-oct-2026 · Cuenta de DEVOLUCIÓN de cada retención (la que usa la nota crédito).
--
-- En el software anterior cada retención tiene cuatro cuentas (ventas, compras, devolución
-- en ventas y devolución en compras). ORBITA ya guardaba la de ventas o compras en
-- `retenciones.cuenta_id` (B3-01); con esta columna la nota crédito reversa la retención
-- en SU cuenta de devolución (retefuente 11 % → 13551510, 4 % → 13551504…) en vez de la
-- regla general NC_RETEFUENTE. Vacía = se usa la regla general, como hasta hoy.
--
-- Aditiva e idempotente:
--   psql "$DATABASE_URL" -f db/migraciones/2026-10-09-retenciones-cuenta-devolucion.sql

BEGIN;
ALTER TABLE sst.retenciones ADD COLUMN IF NOT EXISTS cuenta_devolucion_id UUID REFERENCES sst.cuentas_contables(id);
COMMIT;
