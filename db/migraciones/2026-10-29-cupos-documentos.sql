-- 29-oct-2026 · Cupos de documentos electrónicos: «vas X de Y».
--
-- Pedido del usuario: que facturación y nómina lleven su cuenta y se le muestre al cliente lo que
-- tiene disponible.
--   · facturacion: 1.000 documentos al año, el tope de la anualidad de la cotización a JD&D (no los
--     1.600 del paquete comprado al proveedor). Cuentan TODOS los electrónicos: facturas, notas
--     crédito, documentos soporte y notas de ajuste. Año desde la activación (6-oct-2026).
--   · nomina: el paquete de 60 documentos (nóminas y notas de ajuste), del 7-oct-2026 al 6-oct-2027.
-- Al renovar se cambian `desde`/`hasta` (y `total` si cambia el cupo). Se edita aquí, no desde la app.
--
-- Idempotente: no pisa un valor ya ajustado.
--   node scripts/aplicar-migracion.mjs db/migraciones/2026-10-29-cupos-documentos.sql

BEGIN;
INSERT INTO sst.configuracion (clave, valor, descripcion) VALUES (
  'cupos_documentos',
  '{"facturacion": {"total": 1000, "desde": "2026-10-06", "hasta": "2027-10-05"},
    "nomina":      {"total": 60,   "desde": "2026-10-07", "hasta": "2027-10-06"}}'::jsonb,
  'Documentos electrónicos incluidos por periodo (facturación y nómina). Lo que pase se cotiza aparte.'
) ON CONFLICT (clave) DO NOTHING;
COMMIT;
