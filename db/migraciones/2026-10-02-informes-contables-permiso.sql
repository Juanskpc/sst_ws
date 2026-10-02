-- Fase C · C1-01 · Pantalla de Informes contables en la matriz de Roles y permisos.
-- Solo consulta el libro: el mismo reparto que Contabilidad (admin, contador y
-- auditor sí; administrativo no). Idempotente.
BEGIN;

INSERT INTO sst.permisos_rol (rol, vista, permitido) VALUES
  ('admin',          'informes_contables', TRUE),
  ('contador',       'informes_contables', TRUE),
  ('auditor',        'informes_contables', TRUE),
  ('administrativo', 'informes_contables', FALSE)
ON CONFLICT (rol, vista) DO NOTHING;

COMMIT;
