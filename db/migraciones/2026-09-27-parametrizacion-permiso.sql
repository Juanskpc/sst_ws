-- Fase A · facturación · A0-10 · vista "parametrizacion" en la matriz de permisos (27-sep-2026).
--
-- Solo el cambio (no correr `npm run migrate` entero: trampa 86). Sin esta fila
-- la vista existe en el código pero nadie la ve en el sidebar (auth.puedeVer()
-- consulta esta tabla). Mismo criterio que terceros: admin y contador operan,
-- el auditor consulta, el administrativo no ve lo financiero.
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-09-27-parametrizacion-permiso.sql

BEGIN;

INSERT INTO sst.permisos_rol (rol, vista, permitido) VALUES
  ('admin',          'parametrizacion', TRUE),
  ('contador',       'parametrizacion', TRUE),
  ('auditor',        'parametrizacion', TRUE),
  ('administrativo', 'parametrizacion', FALSE)
ON CONFLICT (rol, vista) DO NOTHING;

COMMIT;
