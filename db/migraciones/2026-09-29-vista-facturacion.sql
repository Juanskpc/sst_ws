-- 29-sep-2026 · A1-08 · Pantalla de Facturación en la matriz de Roles y permisos.
--
-- Es una de las "llaves" del sistema Finanzas (con terceros y parametrización):
-- quien tiene alguna entra a Finanzas; quien tiene también una llave de Operación
-- (importar, órdenes, profesionales) ve la pantalla de selección de sistema.
-- Mismo reparto que terceros y parametrización: admin, contador y auditor sí;
-- administrativo no.
--
-- ADITIVO e idempotente: ON CONFLICT DO NOTHING respeta lo que el cliente ya haya
-- ajustado a mano desde Configuración.
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-09-29-vista-facturacion.sql

BEGIN;
INSERT INTO sst.permisos_rol (rol, vista, permitido) VALUES
  ('admin',          'facturacion', TRUE),
  ('contador',       'facturacion', TRUE),
  ('auditor',        'facturacion', TRUE),
  ('administrativo', 'facturacion', FALSE)
ON CONFLICT (rol, vista) DO NOTHING;
COMMIT;
