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
   'Razón social mostrada en formatos y correos.'),
  -- CFG-05 · Día del mes en que se cierra el cobro a profesionales. NO dispara
  -- nada solo (el despliegue no tiene cron): es la fecha contra la que la vista
  -- de Pre-cuentas avisa de los periodos que quedaron sin generar.
  ('precuenta_dia_corte', '5'::jsonb,
   'Día del mes en que se cierran las pre-cuentas del mes anterior (1-28).'),
  -- ENC-03 · Enunciados de la encuesta ("preguntas variables"): se editan aquí
  -- sin tocar código ni migrar. Las dos escalas son 1-5 y alimentan el
  -- dashboard, por eso su significado no cambia aunque cambie la redacción.
  ('encuesta_preguntas',
   '{"titulo":"Encuesta de satisfacción",
     "satisfaccion":"Nivel de satisfacción de la actividad recibida",
     "recomendacion":"¿Recomendaría a JD&D Consultores?",
     "comentarios":"Observaciones para mejorar el servicio"}'::jsonb,
   'ENC-03 · Textos del formulario público de satisfacción.')
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
  ('auditor',     'configuracion',  TRUE),
  -- M9 · Pre-cuentas: es plata. La ve quien la genera (admin), quien paga
  -- (contador) y quien fiscaliza (auditor); el profesional responde por el
  -- enlace del correo, no necesita la vista interna.
  ('admin',       'precuentas',     TRUE),
  ('contador',    'precuentas',     TRUE),
  ('auditor',     'precuentas',     TRUE),
  ('profesional', 'precuentas',     FALSE),
  -- CFG-02 · Empresas clientes: maestro comercial. Lo mantiene el admin; el
  -- contador y el auditor lo consultan (aparece en cartera y pre-cuentas). El
  -- profesional no lo necesita.
  ('admin',       'empresas',       TRUE),
  ('contador',    'empresas',       TRUE),
  ('auditor',     'empresas',       TRUE),
  ('profesional', 'empresas',       FALSE)
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

-- =============================================================================
-- CFG-02 · Derivación del maestro de empresas desde las OS ya cargadas
-- =============================================================================
-- Las OS anteriores a CFG-02 solo tienen la empresa como texto. Aquí se destila
-- el maestro y se enlazan. Solo toca filas con `empresa_id IS NULL`, así que
-- re-ejecutar la migración no duplica nada ni pisa ediciones del administrador.
--
-- Se resuelve primero por NIT y solo después por nombre: el NIT es el
-- identificador real, pero llega ilegible del OCR con suficiente frecuencia
-- ('900.184.?52-1') como para necesitar el segundo intento.

-- 1 · Alta: una empresa por nombre, con el NIT mayoritario.
--
-- Se agrupa por NOMBRE y no por NIT porque el mismo cliente llega con el NIT
-- roto en algunas órdenes ('900.184.?52-1' frente a '900.184.552-1' en el resto)
-- y agrupar por NIT crearía una ficha duplicada por cada error de lectura. Entre
-- las variantes de NIT de un mismo nombre gana la que aparece en más órdenes;
-- a igualdad, la más reciente.
--
-- Contrapartida asumida: dos empresas realmente distintas con el mismo nombre
-- normalizado quedarían fusionadas en una sola ficha. Es mucho menos frecuente
-- que el ruido de OCR y el administrador puede separarlas a mano.
WITH candidatas AS (
  SELECT o.*,
         upper(regexp_replace(o.empresa_nombre, '[^a-zA-Z0-9]', '', 'g')) AS nombre_norm,
         regexp_replace(split_part(coalesce(o.nit_nic, ''), '-', 1), '[^0-9]', '', 'g') AS nit_norm
    FROM sst.ordenes_servicio o
   WHERE o.empresa_id IS NULL
     AND coalesce(btrim(o.empresa_nombre), '') <> ''
), votadas AS (
  SELECT c.*, count(*) OVER (PARTITION BY c.nombre_norm, c.nit_norm) AS votos
    FROM candidatas c
), elegidas AS (
  SELECT DISTINCT ON (nombre_norm) *
    FROM votadas
   ORDER BY nombre_norm, votos DESC, creado_en DESC
)
INSERT INTO sst.empresas (
  nit, nombre, actividad_economica, ciudad, direccion,
  contacto_nombre, contacto_cargo, contacto_telefono,
  contacto_sst_nombre, contacto_sst_telefono, contacto_sst_correo)
SELECT coalesce(e.nit_nic, ''), btrim(e.empresa_nombre), e.actividad_economica, e.ciudad_ejecucion, e.direccion,
       e.contacto_empresa_nombre, e.contacto_empresa_cargo, e.contacto_empresa_telefono,
       e.contacto_sst_nombre, e.contacto_sst_telefono, e.contacto_sst_correo
  FROM elegidas e
 WHERE NOT EXISTS (SELECT 1 FROM sst.empresas x WHERE x.nombre_normalizado = e.nombre_norm)
   AND NOT EXISTS (SELECT 1 FROM sst.empresas x WHERE x.nit_normalizado <> '' AND x.nit_normalizado = e.nit_norm)
ON CONFLICT DO NOTHING;

-- 2 · Enlace por NIT (el identificador real manda sobre el nombre).
UPDATE sst.ordenes_servicio o
   SET empresa_id = e.id
  FROM sst.empresas e
 WHERE o.empresa_id IS NULL
   AND e.nit_normalizado <> ''
   AND e.nit_normalizado = regexp_replace(split_part(coalesce(o.nit_nic, ''), '-', 1), '[^0-9]', '', 'g');

-- 3 · Enlace por nombre: recoge las órdenes cuyo NIT llegó ilegible.
UPDATE sst.ordenes_servicio o
   SET empresa_id = e.id
  FROM sst.empresas e
 WHERE o.empresa_id IS NULL
   AND e.nombre_normalizado <> ''
   AND e.nombre_normalizado = upper(regexp_replace(coalesce(o.empresa_nombre, ''), '[^a-zA-Z0-9]', '', 'g'));

-- =============================================================================
-- ASG-08 · Vínculo entre la cuenta de acceso y la ficha del profesional
-- =============================================================================
-- `profesionales.usuario_id` existía desde el principio pero nunca se llenó: las
-- fichas se dieron de alta desde /profesionales (CFG-01) y las cuentas desde
-- Configuración → Usuarios, sin nada que las cruzara. Sin ese enlace no hay
-- forma de saber qué órdenes son "las mías" cuando entra un profesional, que es
-- justo lo que pide ASG-08.
--
-- El cruce es por correo, en minúsculas y sin espacios, y solo cuando la
-- correspondencia es 1-a-1: hay fichas que comparten correo (dos asesores dados
-- de alta con el buzón de quien los registró), y enlazar ambas al mismo usuario
-- le mostraría al profesional órdenes de un compañero. Esas quedan sin enlazar
-- a propósito, para que un administrador las corrija a mano.
--
-- Solo toca filas con `usuario_id IS NULL`, así que es idempotente y nunca pisa
-- un enlace hecho desde la UI.
UPDATE sst.profesionales p
   SET usuario_id = u.id, actualizado_en = now()
  FROM sst.usuarios u
 WHERE p.usuario_id IS NULL
   AND lower(btrim(u.correo)) = lower(btrim(p.correo))
   -- 1-a-1 por ambos lados: ni la ficha ni la cuenta pueden ser ambiguas.
   AND (SELECT count(*) FROM sst.profesionales x
         WHERE lower(btrim(x.correo)) = lower(btrim(p.correo))) = 1
   AND (SELECT count(*) FROM sst.usuarios y
         WHERE lower(btrim(y.correo)) = lower(btrim(p.correo))) = 1;
