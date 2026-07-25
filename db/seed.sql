-- =============================================================================
-- JD&D IA-Core · Datos semilla estáticos (idempotente)
-- =============================================================================
SET search_path TO sst, public;

-- Catálogo de ARLs -------------------------------------------------------------
INSERT INTO sst.arls (nombre, formato_origen) VALUES
  ('Bolívar',       'excel'),
  ('AXA Colpatria', 'pdf'),
  ('Colmena',       'pdf')
ON CONFLICT (nombre) DO NOTHING;

-- Configuración global ---------------------------------------------------------
INSERT INTO sst.configuracion (clave, valor, descripcion) VALUES
  ('confidence_threshold', '70'::jsonb,
   'Umbral mínimo de confianza de la IA (%). Campos por debajo se marcan para revisión.'),
  ('company_name', '"JD&D Consultores en Sistemas de Gestión"'::jsonb,
   'Razón social mostrada en formatos y correos.')
ON CONFLICT (clave) DO NOTHING;

-- Roles y permisos · matriz por defecto (rol × vista) --------------------------
-- Todos los roles conservan Dashboard y Configuración (perfil/contraseña propios);
-- el resto se ajusta a lo que cada rol necesita operar en Fase 1. Editable desde
-- Configuración → Roles y permisos (solo admin). ON CONFLICT DO NOTHING para no
-- pisar los ajustes que un administrador ya haya guardado.
INSERT INTO sst.permisos_rol (rol, vista, permitido) VALUES
  ('admin',       'dashboard',      TRUE),
  ('admin',       'importar',       TRUE),
  ('admin',       'ordenes',        TRUE),
  ('admin',       'informes',       TRUE),
  ('admin',       'profesionales',  TRUE),
  ('admin',       'configuracion',  TRUE),
  ('profesional', 'dashboard',      TRUE),
  ('profesional', 'importar',       FALSE),
  ('profesional', 'ordenes',        FALSE),
  ('profesional', 'informes',       TRUE),
  ('profesional', 'profesionales',  FALSE),
  ('profesional', 'configuracion',  TRUE),
  ('contador',    'dashboard',      TRUE),
  ('contador',    'importar',       FALSE),
  ('contador',    'ordenes',        FALSE),
  ('contador',    'informes',       TRUE),
  ('contador',    'profesionales',  FALSE),
  ('contador',    'configuracion',  TRUE),
  ('auditor',     'dashboard',      TRUE),
  ('auditor',     'importar',       FALSE),
  ('auditor',     'ordenes',        TRUE),
  ('auditor',     'informes',       TRUE),
  ('auditor',     'profesionales',  FALSE),
  ('auditor',     'configuracion',  TRUE)
ON CONFLICT (rol, vista) DO NOTHING;

-- Plantillas de formatos precargadas (M4 / FOR) --------------------------------
INSERT INTO sst.plantillas (arl_id, nombre, tipo, descripcion)
SELECT a.id, v.nombre, v.tipo, v.descripcion
FROM (VALUES
  ('Bolívar',       'Acta de Visita — Bolívar',       'acta_visita',
   'Acta de visita con espacios para firmas físicas del profesional y el cliente.'),
  ('Bolívar',       'Lista de Asistencia — Bolívar',  'asistencia',
   'Formato de asistencia a capacitación/inspección.'),
  ('AXA Colpatria', 'Ficha de Gestión — AXA',         'ficha_gestion',
   'Ficha de gestión de la visita para AXA Colpatria.')
) AS v(arl_nombre, nombre, tipo, descripcion)
JOIN sst.arls a ON a.nombre = v.arl_nombre
WHERE NOT EXISTS (
  SELECT 1 FROM sst.plantillas t WHERE t.nombre = v.nombre
);
