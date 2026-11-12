-- 12-nov-2026 · Los rangos de nómina se ven en Parametrización → Numeración.
--
-- Pedido de la contadora: crearon el rango de nómina electrónica en el proveedor y no salía en la
-- pantalla. El proveedor guarda los rangos de nómina en OTRA lista (GET /v2/numbering-ranges/payrolls)
-- y «Sincronizar con el proveedor» solo leía la de facturación (GET /v2/numbering-ranges).
--
--   · tipo_documento admite NOTA_AJUSTE_NOMINA (NOMINA ya estaba).
--   · factus_lista dice de qué lista vino el rango.
--   · rango_ref guarda el id del rango como texto: en la lista de nómina el id NO es numérico
--     (p. ej. "01m48rk686vkmcfb2rewgx2m57", visto en el sandbox), así que no cabe en
--     factus_rango_id (BIGINT), que se queda para los de facturación (la emisión lo manda así).
--   · La unicidad pasa a ser (factus_lista, rango_ref).
--
-- Aditivo e idempotente. Las filas existentes quedan como FACTURACION con rango_ref = su id.
--   node scripts/aplicar-migracion.mjs db/migraciones/2026-11-12-numeracion-nomina.sql

BEGIN;

ALTER TABLE sst.resoluciones_numeracion DROP CONSTRAINT IF EXISTS resoluciones_numeracion_tipo_documento_check;
ALTER TABLE sst.resoluciones_numeracion ADD CONSTRAINT resoluciones_numeracion_tipo_documento_check
  CHECK (tipo_documento IN ('FACTURA', 'NOTA_CREDITO', 'DOC_SOPORTE', 'NOTA_AJUSTE_DS', 'NOMINA', 'NOTA_AJUSTE_NOMINA'));

ALTER TABLE sst.resoluciones_numeracion
  ADD COLUMN IF NOT EXISTS factus_lista TEXT NOT NULL DEFAULT 'FACTURACION';
ALTER TABLE sst.resoluciones_numeracion DROP CONSTRAINT IF EXISTS resoluciones_numeracion_factus_lista_check;
ALTER TABLE sst.resoluciones_numeracion ADD CONSTRAINT resoluciones_numeracion_factus_lista_check
  CHECK (factus_lista IN ('FACTURACION', 'NOMINA'));

ALTER TABLE sst.resoluciones_numeracion ADD COLUMN IF NOT EXISTS rango_ref TEXT;
UPDATE sst.resoluciones_numeracion SET rango_ref = factus_rango_id::text
 WHERE rango_ref IS NULL AND factus_rango_id IS NOT NULL;

ALTER TABLE sst.resoluciones_numeracion DROP CONSTRAINT IF EXISTS resoluciones_numeracion_factus_rango_id_key;
ALTER TABLE sst.resoluciones_numeracion DROP CONSTRAINT IF EXISTS resoluciones_numeracion_lista_rango_key;
ALTER TABLE sst.resoluciones_numeracion DROP CONSTRAINT IF EXISTS resoluciones_numeracion_lista_ref_key;
ALTER TABLE sst.resoluciones_numeracion ADD CONSTRAINT resoluciones_numeracion_lista_ref_key
  UNIQUE (factus_lista, rango_ref);

COMMIT;
