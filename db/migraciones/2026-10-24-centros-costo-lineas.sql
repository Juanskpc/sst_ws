-- 24-oct-2026 · Centro de costo por LÍNEA de compra y centros de costo por ARL.
--
-- 1) Registro de compras y gastos: el centro de costo ya no es uno solo para toda
--    la compra; cada ítem lleva el suyo (p. ej. un mismo recibo con un gasto de
--    Bolívar y otro de AXA). `compras.centro_costo_id` se conserva como el centro
--    común cuando todos los ítems coinciden.
-- 2) Un centro de costo puede pertenecer a una ARL (`arl_id`). Cuando se genera el
--    documento soporte de una cuenta de cobro, el valor de cada orden va al centro
--    de costo de SU ARL (petición de JD&D del 23-oct).
--
-- ADITIVA e idempotente.
--
--   node scripts/aplicar-migracion.mjs db/migraciones/2026-10-24-centros-costo-lineas.sql

BEGIN;
ALTER TABLE sst.compra_items
  ADD COLUMN IF NOT EXISTS centro_costo_id UUID REFERENCES sst.centros_costo(id);

ALTER TABLE sst.centros_costo
  ADD COLUMN IF NOT EXISTS arl_id UUID REFERENCES sst.arls(id) ON DELETE SET NULL;
-- Una ARL tiene a lo sumo UN centro de costo activo que la represente.
CREATE UNIQUE INDEX IF NOT EXISTS uq_centro_costo_arl ON sst.centros_costo (arl_id) WHERE arl_id IS NOT NULL AND activo;
COMMIT;
