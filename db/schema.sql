-- =============================================================================
-- JD&D IA-Core · Esquema de base de datos  (PostgreSQL / Neon) — EN ESPAÑOL
-- Esquema lógico: sst
--
-- Alcance (decisión de proyecto):
--   * NÚCLEO FASE 1  → tablas + vistas + funciones IMPLEMENTADAS y usadas por el backend.
--   * COSTURAS FASE 2 → tablas creadas FÍSICAMENTE ("incluir todo el proyecto"),
--                       pero SIN lógica de backend (Regla de Oro: no se codifica Fase 2).
--
-- Idempotente: se puede re-ejecutar. Usa CREATE ... IF NOT EXISTS y DO-guards.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;      -- gen_random_uuid()

CREATE SCHEMA IF NOT EXISTS sst;
SET search_path TO sst, public;

-- -----------------------------------------------------------------------------
-- TIPOS ENUMERADOS
-- -----------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE sst.rol_usuario AS ENUM ('admin', 'profesional', 'contador', 'auditor');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sst.estado_profesional AS ENUM ('Activo', 'Inactivo');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sst.formato_arl AS ENUM ('excel', 'pdf');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- EST-01: estados obligatorios de la Orden de Servicio.
DO $$ BEGIN
  CREATE TYPE sst.estado_orden AS ENUM (
    'SIN PROGRAMAR', 'PROGRAMADA', 'EN VERIFICACIÓN', 'EJECUTADA', 'CANCELADA'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sst.estado_importacion AS ENUM ('PROCESANDO', 'PROCESADO', 'ERROR');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Estado del registro de extracción (borrador) del pipeline IA (M2/M3).
DO $$ BEGIN
  CREATE TYPE sst.estado_extraccion AS ENUM (
    'PROCESANDO', 'PENDIENTE_VALIDACION', 'VALIDADA', 'DUPLICADA', 'DESCARTADA', 'ERROR'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- PENDIENTE_REVISION: el borrador ya fue extraído pero AÚN NO entra a la bandeja
-- de Órdenes. Vive solo en la vista previa de Importar, donde el Admin revisa,
-- corrige y confirma. Al confirmar pasa a PENDIENTE_VALIDACION (IMP-03/IMP-04).
-- Requiere PostgreSQL 12+ (permite ADD VALUE dentro de un bloque de transacción
-- siempre que el valor nuevo no se use en la misma transacción).
ALTER TYPE sst.estado_extraccion ADD VALUE IF NOT EXISTS 'PENDIENTE_REVISION';

-- =============================================================================
-- NÚCLEO FASE 1
-- =============================================================================

-- M1 · Usuarios / Auth ---------------------------------------------------------
-- Login por DOCUMENTO DE IDENTIDAD (varchar) + contraseña. El correo se conserva
-- para notificaciones y recuperación de contraseña (AUTH-03).
-- `es_maestro`: marca al Administrador Maestro (cuenta exclusiva del equipo de
-- desarrollo). Mantiene rol 'admin' para no alterar los permisos existentes; las
-- capacidades exclusivas (gestión de usuarios internos) se validan sobre el flag.
CREATE TABLE IF NOT EXISTS sst.usuarios (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  documento_identidad      VARCHAR(30) UNIQUE,
  nombre                   TEXT NOT NULL,
  correo                   TEXT NOT NULL UNIQUE,
  contrasena_hash          TEXT NOT NULL,
  rol                      sst.rol_usuario NOT NULL DEFAULT 'profesional',
  telefono                 TEXT,
  especialidad             TEXT,
  activo                   BOOLEAN NOT NULL DEFAULT TRUE,
  es_maestro               BOOLEAN NOT NULL DEFAULT FALSE,
  -- Costuras de autenticación robusta (verificación de correo y bloqueo por
  -- intentos): columnas listas, la lógica se activa en iteraciones futuras.
  correo_verificado_en     TIMESTAMPTZ,
  intentos_fallidos        INT NOT NULL DEFAULT 0,
  bloqueado_hasta          TIMESTAMPTZ,
  contrasena_actualizada_en TIMESTAMPTZ,
  creado_en                TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en           TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Para bases ya existentes: agrega columnas sin perder datos.
ALTER TABLE sst.usuarios ADD COLUMN IF NOT EXISTS documento_identidad VARCHAR(30);
ALTER TABLE sst.usuarios ADD COLUMN IF NOT EXISTS es_maestro BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE sst.usuarios ADD COLUMN IF NOT EXISTS correo_verificado_en TIMESTAMPTZ;
ALTER TABLE sst.usuarios ADD COLUMN IF NOT EXISTS intentos_fallidos INT NOT NULL DEFAULT 0;
ALTER TABLE sst.usuarios ADD COLUMN IF NOT EXISTS bloqueado_hasta TIMESTAMPTZ;
ALTER TABLE sst.usuarios ADD COLUMN IF NOT EXISTS contrasena_actualizada_en TIMESTAMPTZ;
-- Los tokens de recuperación ya no viven en texto plano sobre usuarios:
-- se hashean en sst.tokens_autenticacion (ver más abajo).
ALTER TABLE sst.usuarios DROP COLUMN IF EXISTS token_recuperacion;
ALTER TABLE sst.usuarios DROP COLUMN IF EXISTS token_recuperacion_expira;
CREATE UNIQUE INDEX IF NOT EXISTS uq_usuarios_documento ON sst.usuarios(documento_identidad);
-- Garantiza a nivel de BD que exista a lo sumo UN Administrador Maestro.
CREATE UNIQUE INDEX IF NOT EXISTS uq_usuarios_maestro ON sst.usuarios(es_maestro) WHERE es_maestro;

-- AUTH-03 · Tokens de autenticación de un solo uso -----------------------------
-- Base común para recuperación de contraseña HOY y verificación de correo en el
-- futuro. El token en claro solo viaja en el correo; aquí se guarda su SHA-256.
DO $$ BEGIN
  CREATE TYPE sst.proposito_token AS ENUM ('recuperacion_contrasena', 'verificacion_correo');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS sst.tokens_autenticacion (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id  UUID NOT NULL REFERENCES sst.usuarios(id) ON DELETE CASCADE,
  proposito   sst.proposito_token NOT NULL DEFAULT 'recuperacion_contrasena',
  token_hash  TEXT NOT NULL UNIQUE,          -- SHA-256 hex del token en claro
  expira_en   TIMESTAMPTZ NOT NULL,
  usado_en    TIMESTAMPTZ,                   -- un solo uso: NULL = vigente
  ip          TEXT,
  user_agent  TEXT,
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tokens_aut_usuario ON sst.tokens_autenticacion(usuario_id, proposito);

-- AUTH-06 · Auditoría de eventos de autenticación ------------------------------
-- Evento como TEXT (no enum) para poder auditar nuevos eventos sin migrar tipos.
CREATE TABLE IF NOT EXISTS sst.eventos_autenticacion (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL,
  correo     TEXT,
  evento     TEXT NOT NULL,   -- login_exitoso | login_fallido | recuperacion_solicitada | ...
  exito      BOOLEAN,
  ip         TEXT,
  user_agent TEXT,
  datos      JSONB,
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_eventos_aut_usuario ON sst.eventos_autenticacion(usuario_id);
CREATE INDEX IF NOT EXISTS idx_eventos_aut_evento  ON sst.eventos_autenticacion(evento, creado_en);

-- Roles y permisos · matriz de acceso por vista (rol × vista → permitido) ------
-- Vistas = ítems del sidebar: dashboard | importar | ordenes | informes |
-- profesionales | configuracion. es_maestro (ver arriba) siempre tiene acceso
-- total y no depende de esta tabla — es la salvaguarda ante un bloqueo accidental.
CREATE TABLE IF NOT EXISTS sst.permisos_rol (
  rol            sst.rol_usuario NOT NULL,
  vista          TEXT NOT NULL,
  permitido      BOOLEAN NOT NULL DEFAULT TRUE,
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (rol, vista)
);

-- CFG-01 · Profesionales (asesores de campo) ----------------------------------
CREATE TABLE IF NOT EXISTS sst.profesionales (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id     UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL,
  nombre         TEXT NOT NULL,
  correo         TEXT NOT NULL,
  telefono       TEXT,
  especialidad   TEXT,
  valor_hora     NUMERIC(12,2) NOT NULL DEFAULT 0,   -- 🔗 costura M9 (Fase 2)
  estado         sst.estado_profesional NOT NULL DEFAULT 'Activo',
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_profesionales_estado ON sst.profesionales(estado);

-- Catálogo de ARLs -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sst.arls (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre          TEXT NOT NULL UNIQUE,
  formato_origen  sst.formato_arl NOT NULL
);

-- CFG-02 · Empresas clientes ---------------------------------------------------
-- Hasta ahora la empresa vivía como texto suelto dentro de cada OS
-- (empresa_nombre + nit_nic, tal como los extrae la IA del documento de la ARL).
-- Esta tabla la convierte en maestro editable; la OS conserva su texto original
-- como respaldo histórico y se enlaza por `empresa_id` (ver más abajo).
--
-- Claves de comparación (columnas generadas, para que la BD y el backend usen
-- exactamente la misma regla):
--   * nit_normalizado: dígitos de la parte anterior al guion, de modo que
--     '901.225.480-3', '901225480-3' y '901225480' sean la misma empresa. El
--     dígito de verificación se descarta porque las ARL lo omiten a discreción.
--   * nombre_normalizado: solo alfanuméricos en mayúscula ('Inversiones Andinas
--     S.A.S' = 'INVERSIONES ANDINAS SAS'). Es el plan B cuando el NIT llega
--     ilegible del OCR, que ocurre.
CREATE TABLE IF NOT EXISTS sst.empresas (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nit                 TEXT NOT NULL,
  nit_normalizado     TEXT GENERATED ALWAYS AS
                        (regexp_replace(split_part(nit, '-', 1), '[^0-9]', '', 'g')) STORED,
  nombre              TEXT NOT NULL,
  nombre_normalizado  TEXT GENERATED ALWAYS AS
                        (upper(regexp_replace(nombre, '[^a-zA-Z0-9]', '', 'g'))) STORED,
  actividad_economica TEXT,
  ciudad              TEXT,
  direccion           TEXT,
  -- Contacto administrativo (quien recibe la programación de la visita).
  contacto_nombre     TEXT,
  contacto_cargo      TEXT,
  contacto_telefono   TEXT,
  contacto_correo     TEXT,
  -- Responsable de SST (a quien se le envía la encuesta de satisfacción, M8).
  contacto_sst_nombre   TEXT,
  contacto_sst_telefono TEXT,
  contacto_sst_correo   TEXT,
  notas               TEXT,
  activo              BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en           TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Unicidad por NIT, pero parcial: una empresa cargada sin NIT legible no debe
-- chocar contra las demás sin NIT (todas normalizarían a la cadena vacía).
CREATE UNIQUE INDEX IF NOT EXISTS uq_empresas_nit
  ON sst.empresas (nit_normalizado) WHERE nit_normalizado <> '';
CREATE INDEX IF NOT EXISTS idx_empresas_nombre_norm ON sst.empresas (nombre_normalizado);
CREATE INDEX IF NOT EXISTS idx_empresas_activo      ON sst.empresas (activo);

-- Plantillas de formatos (M4) — precargadas en Fase 1 -------------------------
-- 🔗 costura CFG-05: en Fase 2 se vuelven editables. Aquí solo catálogo.
CREATE TABLE IF NOT EXISTS sst.plantillas (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  arl_id               UUID REFERENCES sst.arls(id) ON DELETE SET NULL,
  nombre               TEXT NOT NULL,
  tipo                 TEXT NOT NULL,        -- acta_visita | asistencia | ficha_gestion
  descripcion          TEXT,
  clave_almacenamiento TEXT,                 -- key S3 de la plantilla base (opcional)
  activo               BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en            TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- CFG-03 · Textos editables que SÍ salen impresos en el PDF (pdf.service.js).
-- El formato se dibuja con pdf-lib, no se rellena un archivo base: por eso lo
-- editable es el contenido (título, introducción y nota al pie), no un adjunto.
ALTER TABLE sst.plantillas ADD COLUMN IF NOT EXISTS encabezado     TEXT;
ALTER TABLE sst.plantillas ADD COLUMN IF NOT EXISTS nota_pie       TEXT;
-- Orden de impresión cuando una ARL tiene varios formatos (menor primero).
ALTER TABLE sst.plantillas ADD COLUMN IF NOT EXISTS orden          INT NOT NULL DEFAULT 0;
ALTER TABLE sst.plantillas ADD COLUMN IF NOT EXISTS actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now();

-- M2 · Lotes de importación ----------------------------------------------------
CREATE TABLE IF NOT EXISTS sst.lotes_importacion (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subido_por     UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL,
  nombre_archivo TEXT NOT NULL,
  arl_detectada  UUID REFERENCES sst.arls(id) ON DELETE SET NULL,
  url_archivo    TEXT,                       -- key S3 del archivo original
  tipo_mime      TEXT,
  estado         sst.estado_importacion NOT NULL DEFAULT 'PROCESANDO',
  mensaje_error  TEXT,
  total_ordenes  INTEGER NOT NULL DEFAULT 0,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lotes_importacion_estado ON sst.lotes_importacion(estado);

-- ⭐ ordenes_servicio · La OS (tabla central, M2/M3) ---------------------------
CREATE TABLE IF NOT EXISTS sst.ordenes_servicio (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo                   TEXT UNIQUE,       -- código legible tipo OS-2026-0148 (autogenerado)
  arl_id                   UUID NOT NULL REFERENCES sst.arls(id),
  -- Identidad por ARL: Bolívar usa (cronograma + secuencia); AXA/Colmena usan
  -- numero_orden. Por eso cronograma/secuencia son NULLABLE (ver índices abajo).
  numero_orden             TEXT,
  codigo_cronograma        TEXT,
  secuencia                TEXT,
  nro_afiliacion           TEXT,
  nit_nic                  TEXT,
  empresa_nombre           TEXT,
  actividad_economica      TEXT,
  tipo_actividad           TEXT,
  modalidad                TEXT,
  horas_asignadas          NUMERIC(8,2),
  valor_unitario           NUMERIC(14,2),
  valor_total              NUMERIC(14,2),
  fecha_orden              DATE,
  fecha_vencimiento        DATE,
  ciudad_ejecucion         TEXT,
  direccion                TEXT,
  fecha_carga              TIMESTAMPTZ NOT NULL DEFAULT now(),
  descripcion              TEXT,
  contacto_empresa_nombre  TEXT,             -- persona administrativa de la empresa cliente
  contacto_empresa_cargo   TEXT,
  contacto_empresa_telefono TEXT,
  contacto_sst_nombre      TEXT,             -- 🔗 costura M8 (encuesta Fase 2): responsable SST real
  contacto_sst_telefono    TEXT,
  contacto_sst_correo      TEXT,
  estado                   sst.estado_orden NOT NULL DEFAULT 'SIN PROGRAMAR',
  profesional_asignado_id  UUID REFERENCES sst.profesionales(id) ON DELETE SET NULL,
  fecha_programada         TIMESTAMPTZ,       -- ASG: fecha/hora de ejecución programada
  fecha_ejecucion          TIMESTAMPTZ,       -- se setea al pasar a EJECUTADA
  lote_importacion_id      UUID REFERENCES sst.lotes_importacion(id) ON DELETE SET NULL,
  url_archivo_original     TEXT,             -- key S3 del documento origen
  metadatos_extraccion     JSONB,            -- extracción cruda IA + confidencias por campo
  creado_en                TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- IMP-09: dedup de Bolívar por (ARL + cronograma + secuencia). Postgres trata
  -- los NULL como distintos, así que las filas de AXA/Colmena (cronograma NULL)
  -- no colisionan aquí; su unicidad la cubre uq_ordenes_numero (abajo).
  CONSTRAINT uq_ordenes_dedup UNIQUE (arl_id, codigo_cronograma, secuencia)
);
-- Para bases ya existentes: agrega columnas nuevas y relaja los NOT NULL previos.
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS numero_orden TEXT;
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS nro_afiliacion TEXT;
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS tipo_actividad TEXT;
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS modalidad TEXT;
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS valor_unitario NUMERIC(14,2);
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS valor_total NUMERIC(14,2);
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS fecha_orden DATE;
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS fecha_vencimiento DATE;
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS ciudad_ejecucion TEXT;
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS direccion TEXT;
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS contacto_empresa_nombre TEXT;
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS contacto_empresa_cargo TEXT;
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS contacto_empresa_telefono TEXT;
-- CFG-02 · Enlace con el maestro de empresas. Es NULLABLE y ON DELETE SET NULL a
-- propósito: `empresa_nombre`/`nit_nic` siguen siendo el dato histórico de lo que
-- decía el documento de la ARL, así que una OS nunca pierde su empresa aunque el
-- registro maestro se dé de baja.
ALTER TABLE sst.ordenes_servicio
  ADD COLUMN IF NOT EXISTS empresa_id UUID REFERENCES sst.empresas(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_ordenes_empresa ON sst.ordenes_servicio(empresa_id);
ALTER TABLE sst.ordenes_servicio ALTER COLUMN codigo_cronograma DROP NOT NULL;
ALTER TABLE sst.ordenes_servicio ALTER COLUMN secuencia DROP NOT NULL;
-- Unicidad de AXA/Colmena por (ARL + numero_orden). Parcial: solo aplica cuando
-- numero_orden viene informado (las OS de Bolívar lo dejan NULL).
CREATE UNIQUE INDEX IF NOT EXISTS uq_ordenes_numero
  ON sst.ordenes_servicio (arl_id, numero_orden) WHERE numero_orden IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ordenes_estado      ON sst.ordenes_servicio(estado);
CREATE INDEX IF NOT EXISTS idx_ordenes_arl         ON sst.ordenes_servicio(arl_id);
CREATE INDEX IF NOT EXISTS idx_ordenes_prof        ON sst.ordenes_servicio(profesional_asignado_id);
CREATE INDEX IF NOT EXISTS idx_ordenes_fecha_carga ON sst.ordenes_servicio(fecha_carga);

-- ⭐ EST-03 · Historial de estados (auditoría + event source) ------------------
CREATE TABLE IF NOT EXISTS sst.historial_estados_orden (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  orden_id        UUID NOT NULL REFERENCES sst.ordenes_servicio(id) ON DELETE CASCADE,
  estado_anterior sst.estado_orden,
  estado_nuevo    sst.estado_orden NOT NULL,
  cambiado_por    UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL,
  motivo          TEXT,        -- obligatorio en CANCELADA y en rechazos de verificación
  cambiado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_historial_orden ON sst.historial_estados_orden(orden_id);
CREATE INDEX IF NOT EXISTS idx_historial_estado ON sst.historial_estados_orden(estado_nuevo);

-- Borradores de extracción del pipeline IA (staging M2/M3) --------------------
-- El registro vive como borrador con la extracción cruda; al "Validar y Guardar"
-- se materializa en ordenes_servicio con estado SIN PROGRAMAR.
CREATE TABLE IF NOT EXISTS sst.borradores_extraccion (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lote_importacion_id  UUID NOT NULL REFERENCES sst.lotes_importacion(id) ON DELETE CASCADE,
  arl_id               UUID REFERENCES sst.arls(id) ON DELETE SET NULL,
  nombre_archivo       TEXT,
  url_archivo_original TEXT,
  confianza_general    NUMERIC(5,2),
  metadatos_extraccion JSONB NOT NULL,           -- { campo: {value, confidence}, ... }
  estado               sst.estado_extraccion NOT NULL DEFAULT 'PROCESANDO',
  duplicado_de         UUID REFERENCES sst.ordenes_servicio(id) ON DELETE SET NULL,
  orden_servicio_id    UUID REFERENCES sst.ordenes_servicio(id) ON DELETE SET NULL,
  mensaje_error        TEXT,
  creado_en            TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_borradores_lote   ON sst.borradores_extraccion(lote_importacion_id);
CREATE INDEX IF NOT EXISTS idx_borradores_estado ON sst.borradores_extraccion(estado);

-- Órdenes (vista "Órdenes"): asignación ligera de profesional y SOFT-DELETE.
-- Se opera sobre el borrador mientras vive en la bandeja (antes de materializar la OS).
ALTER TABLE sst.borradores_extraccion
  ADD COLUMN IF NOT EXISTS profesional_asignado_id UUID REFERENCES sst.profesionales(id) ON DELETE SET NULL;
ALTER TABLE sst.borradores_extraccion
  ADD COLUMN IF NOT EXISTS fecha_programada TIMESTAMPTZ;
ALTER TABLE sst.borradores_extraccion
  ADD COLUMN IF NOT EXISTS deshabilitado BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE sst.borradores_extraccion
  ADD COLUMN IF NOT EXISTS deshabilitado_en TIMESTAMPTZ;
ALTER TABLE sst.borradores_extraccion
  ADD COLUMN IF NOT EXISTS deshabilitado_por UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_borradores_deshabilitado ON sst.borradores_extraccion(deshabilitado);
CREATE INDEX IF NOT EXISTS idx_borradores_prof          ON sst.borradores_extraccion(profesional_asignado_id);

-- Ocupaciones (agenda) del profesional: franjas fecha+hora en que NO está disponible.
-- Alimenta el calendario del modal "Asignar profesional".
CREATE TABLE IF NOT EXISTS sst.ocupaciones_profesional (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profesional_id UUID NOT NULL REFERENCES sst.profesionales(id) ON DELETE CASCADE,
  fecha          DATE NOT NULL,
  hora_inicio    TIME NOT NULL,
  hora_fin       TIME NOT NULL,
  motivo         TEXT,
  creado_por     UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_ocupacion_rango CHECK (hora_fin > hora_inicio)
);
CREATE INDEX IF NOT EXISTS idx_ocupaciones_prof  ON sst.ocupaciones_profesional(profesional_id);
CREATE INDEX IF NOT EXISTS idx_ocupaciones_fecha ON sst.ocupaciones_profesional(profesional_id, fecha);

-- M4 · Documentos generados (formatos PDF auto-diligenciados) ------------------
CREATE TABLE IF NOT EXISTS sst.documentos_generados (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  orden_id     UUID NOT NULL REFERENCES sst.ordenes_servicio(id) ON DELETE CASCADE,
  plantilla_id UUID REFERENCES sst.plantillas(id) ON DELETE SET NULL,
  tipo         TEXT NOT NULL,
  url_pdf      TEXT,        -- key S3
  generado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_documentos_orden ON sst.documentos_generados(orden_id);

-- M6 · Enlaces públicos + soportes --------------------------------------------
CREATE TABLE IF NOT EXISTS sst.enlaces_publicos (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  orden_id   UUID NOT NULL REFERENCES sst.ordenes_servicio(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  activo     BOOLEAN NOT NULL DEFAULT TRUE,
  expira_en  TIMESTAMPTZ,
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_enlaces_publicos_token ON sst.enlaces_publicos(token);

CREATE TABLE IF NOT EXISTS sst.archivos_soporte (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  orden_id           UUID NOT NULL REFERENCES sst.ordenes_servicio(id) ON DELETE CASCADE,
  enlace_publico_id  UUID REFERENCES sst.enlaces_publicos(id) ON DELETE SET NULL,
  url_archivo        TEXT NOT NULL,   -- key S3
  nombre_original    TEXT,
  mime               TEXT,
  tamano_bytes       BIGINT,
  via_enlace_publico BOOLEAN NOT NULL DEFAULT TRUE,
  subido_en          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_archivos_soporte_orden ON sst.archivos_soporte(orden_id);

-- M11 · Notificaciones ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS sst.notificaciones (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id UUID REFERENCES sst.usuarios(id) ON DELETE CASCADE,
  tipo       TEXT NOT NULL,
  titulo     TEXT,
  mensaje    TEXT,
  datos      JSONB,
  leido_en   TIMESTAMPTZ,
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notificaciones_usuario ON sst.notificaciones(usuario_id, leido_en);

-- Configuración global (clave-valor tipado) -----------------------------------
CREATE TABLE IF NOT EXISTS sst.configuracion (
  clave          TEXT PRIMARY KEY,
  valor          JSONB NOT NULL,
  descripcion    TEXT,
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RPT-06 · Cartera. Que una OS ejecutada esté facturada, o validada por la ARL,
-- es información EXTERNA: no se deduce de ningún estado del sistema, así que se
-- marca explícitamente. Nulo = pendiente, que es justo lo que lista el reporte.
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS facturado_en      TIMESTAMPTZ;
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS validado_arl_en   TIMESTAMPTZ;
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS cartera_marcada_por UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ordenes_cartera
  ON sst.ordenes_servicio(estado, facturado_en, validado_arl_en);

-- ASG-05 · Revisión de la invitación de calendario de la visita.
-- El .ics que se adjunta al correo de asignación lleva un UID fijo por orden,
-- de modo que al reprogramar el calendario MUEVA la visita en vez de crear un
-- segundo evento. Para que el cliente de correo acepte el cambio, la nueva
-- invitación tiene que traer un SEQUENCE mayor que la anterior; de ahí este
-- contador, que sube en cada asignación o reprogramación.
ALTER TABLE sst.ordenes_servicio
  ADD COLUMN IF NOT EXISTS secuencia_calendario INT NOT NULL DEFAULT 0;

-- =============================================================================
-- M8 · ENCUESTA DE SATISFACCIÓN (ENC-01..07)  ·  implementado en Fase 2
-- =============================================================================

-- Una fila por OS: se crea al pasar la orden a EJECUTADA (con su token y el
-- momento de envío) y se completa cuando el contacto responde.
CREATE TABLE IF NOT EXISTS sst.respuestas_encuesta (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  orden_id        UUID NOT NULL REFERENCES sst.ordenes_servicio(id) ON DELETE CASCADE,
  contacto_correo TEXT,
  token           TEXT UNIQUE,
  satisfaccion    SMALLINT CHECK (satisfaccion BETWEEN 1 AND 5),
  recomendacion   SMALLINT CHECK (recomendacion BETWEEN 1 AND 5),
  comentarios     TEXT,
  enviado_en      TIMESTAMPTZ
);

-- Columnas añadidas sobre la costura original de Fase 1 (BD ya desplegadas).
ALTER TABLE sst.respuestas_encuesta ADD COLUMN IF NOT EXISTS contacto_nombre TEXT;
ALTER TABLE sst.respuestas_encuesta ADD COLUMN IF NOT EXISTS respondido_en   TIMESTAMPTZ;
ALTER TABLE sst.respuestas_encuesta ADD COLUMN IF NOT EXISTS creado_en       TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE sst.respuestas_encuesta ADD COLUMN IF NOT EXISTS recordatorio_en TIMESTAMPTZ;
-- ENC-04 · Snapshot de a quién/qué corresponde la calificación. Se guarda copiado
-- y no por JOIN vivo porque la OS puede reasignarse después: la nota pertenece a
-- quien ejecutó la actividad, no a quien figure hoy en la orden.
ALTER TABLE sst.respuestas_encuesta ADD COLUMN IF NOT EXISTS profesional_id  UUID REFERENCES sst.profesionales(id) ON DELETE SET NULL;
ALTER TABLE sst.respuestas_encuesta ADD COLUMN IF NOT EXISTS arl_id          UUID REFERENCES sst.arls(id);
ALTER TABLE sst.respuestas_encuesta ADD COLUMN IF NOT EXISTS empresa_nombre  TEXT;
-- ENC-03 · Los enunciados son configurables (`encuesta_preguntas`), así que se
-- congela el texto que se le mostró a ESTE cliente: si mañana cambia la
-- redacción, las respuestas viejas siguen contando lo que realmente se preguntó.
ALTER TABLE sst.respuestas_encuesta ADD COLUMN IF NOT EXISTS preguntas       JSONB;

-- ENC-06 · Una sola encuesta por OS (y un solo token): evita reenviar dos
-- formularios distintos para la misma orden.
CREATE UNIQUE INDEX IF NOT EXISTS uq_encuesta_orden ON sst.respuestas_encuesta(orden_id);
CREATE INDEX IF NOT EXISTS idx_encuesta_respondido ON sst.respuestas_encuesta(respondido_en);

-- =============================================================================
-- M9 · PRE-CUENTA DE COBRO (PRE-01..09)  ·  implementado en Fase 2
-- =============================================================================

-- PRE-02 · Valor hora por profesional y tipo de actividad. El histórico se
-- conserva: se agregan filas con nuevo `vigente_desde` en vez de editar, para
-- que una pre-cuenta vieja se pueda recalcular con la tarifa de su momento.
CREATE TABLE IF NOT EXISTS sst.tarifas_actividad_profesional (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profesional_id UUID NOT NULL REFERENCES sst.profesionales(id) ON DELETE CASCADE,
  actividad      TEXT NOT NULL,
  valor_hora     NUMERIC(12,2) NOT NULL,
  vigente_desde  DATE NOT NULL DEFAULT CURRENT_DATE,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sst.precuentas (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profesional_id UUID NOT NULL REFERENCES sst.profesionales(id) ON DELETE CASCADE,
  periodo        TEXT NOT NULL,                 -- p.ej. '2026-07'
  total_horas    NUMERIC(10,2) NOT NULL DEFAULT 0,
  total_monto    NUMERIC(14,2) NOT NULL DEFAULT 0,
  estado         TEXT NOT NULL DEFAULT 'generada', -- generada|aceptada|rechazada
  observaciones  TEXT,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sst.precuenta_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  precuenta_id        UUID NOT NULL REFERENCES sst.precuentas(id) ON DELETE CASCADE,
  orden_id            UUID NOT NULL REFERENCES sst.ordenes_servicio(id),
  horas               NUMERIC(8,2) NOT NULL,
  valor_hora_snapshot NUMERIC(12,2) NOT NULL,   -- 💰 snapshot inmutable, NO FK viva
  monto               NUMERIC(14,2) NOT NULL
);

-- Columnas añadidas al implementar M9 sobre la costura de Fase 1.
-- PRE-05 · El profesional acepta o rechaza desde un enlace del correo, sin
-- login: el token ES la credencial (mismo patrón que M6 y M8).
ALTER TABLE sst.precuentas ADD COLUMN IF NOT EXISTS token          TEXT UNIQUE;
ALTER TABLE sst.precuentas ADD COLUMN IF NOT EXISTS enviado_en     TIMESTAMPTZ;
ALTER TABLE sst.precuentas ADD COLUMN IF NOT EXISTS respondido_en  TIMESTAMPTZ;
ALTER TABLE sst.precuentas ADD COLUMN IF NOT EXISTS generado_por   UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL;
ALTER TABLE sst.precuentas ADD COLUMN IF NOT EXISTS actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now();

-- Una sola pre-cuenta por profesional y periodo: regenerar actualiza la que ya
-- existe en lugar de duplicar el cobro del mes.
CREATE UNIQUE INDEX IF NOT EXISTS uq_precuenta_prof_periodo
  ON sst.precuentas(profesional_id, periodo);
CREATE INDEX IF NOT EXISTS idx_precuentas_periodo ON sst.precuentas(periodo);

-- PRE-03 · Datos de la OS congelados en el ítem: el documento que el
-- profesional aceptó debe poder reimprimirse igual aunque la orden cambie
-- después (o se elimine el nombre de la empresa por corrección de datos).
ALTER TABLE sst.precuenta_items ADD COLUMN IF NOT EXISTS orden_codigo    TEXT;
ALTER TABLE sst.precuenta_items ADD COLUMN IF NOT EXISTS empresa_nombre  TEXT;
ALTER TABLE sst.precuenta_items ADD COLUMN IF NOT EXISTS arl_nombre      TEXT;
ALTER TABLE sst.precuenta_items ADD COLUMN IF NOT EXISTS actividad       TEXT;
ALTER TABLE sst.precuenta_items ADD COLUMN IF NOT EXISTS fecha_ejecucion DATE;
-- De dónde salió el valor hora aplicado: 'tarifa' (PRE-02) o 'profesional'
-- (valor_hora base). Se muestra en pantalla para que una cifra rara se pueda
-- explicar sin abrir la base de datos.
ALTER TABLE sst.precuenta_items ADD COLUMN IF NOT EXISTS origen_tarifa   TEXT;

CREATE INDEX IF NOT EXISTS idx_precuenta_items_precuenta ON sst.precuenta_items(precuenta_id);

-- =============================================================================
-- COSTURAS FASE 2  ·  (ya no queda ninguna: M8 y M9 están implementados)
-- =============================================================================

-- =============================================================================
-- FUNCIONES Y TRIGGERS
-- =============================================================================

-- Toca actualizado_en automáticamente.
CREATE OR REPLACE FUNCTION sst.fn_tocar_actualizado_en() RETURNS trigger AS $$
BEGIN
  NEW.actualizado_en := now();
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER trg_usuarios_tocar      BEFORE UPDATE ON sst.usuarios
    FOR EACH ROW EXECUTE FUNCTION sst.fn_tocar_actualizado_en();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER trg_profesionales_tocar BEFORE UPDATE ON sst.profesionales
    FOR EACH ROW EXECUTE FUNCTION sst.fn_tocar_actualizado_en();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER trg_ordenes_tocar       BEFORE UPDATE ON sst.ordenes_servicio
    FOR EACH ROW EXECUTE FUNCTION sst.fn_tocar_actualizado_en();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER trg_borradores_tocar    BEFORE UPDATE ON sst.borradores_extraccion
    FOR EACH ROW EXECUTE FUNCTION sst.fn_tocar_actualizado_en();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- EST-06: bloquear cualquier retroceso desde EJECUTADA (defensa en profundidad).
CREATE OR REPLACE FUNCTION sst.fn_bloquear_regresion_ejecutada() RETURNS trigger AS $$
BEGIN
  IF OLD.estado = 'EJECUTADA' AND NEW.estado <> 'EJECUTADA' THEN
    RAISE EXCEPTION 'No se puede cambiar el estado de una OS EJECUTADA (EST-06).';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER trg_bloquear_ejecutada BEFORE UPDATE OF estado ON sst.ordenes_servicio
    FOR EACH ROW EXECUTE FUNCTION sst.fn_bloquear_regresion_ejecutada();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ⭐ Cambio de estado transaccional con reglas de dominio EST-01..06.
-- Valida la transición, exige motivo donde corresponde, actualiza la OS y
-- escribe la entrada de auditoría en historial_estados_orden, todo atómico.
CREATE OR REPLACE FUNCTION sst.cambiar_estado_orden(
  p_orden_id     UUID,
  p_estado_nuevo sst.estado_orden,
  p_cambiado_por UUID,
  p_motivo       TEXT DEFAULT NULL
) RETURNS sst.ordenes_servicio AS $$
DECLARE
  v_actual   sst.estado_orden;
  v_fila     sst.ordenes_servicio;
  v_permitido BOOLEAN := FALSE;
BEGIN
  SELECT estado INTO v_actual FROM sst.ordenes_servicio WHERE id = p_orden_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OS % no existe.', p_orden_id USING ERRCODE = 'no_data_found';
  END IF;

  IF v_actual = p_estado_nuevo THEN
    RAISE EXCEPTION 'La OS ya se encuentra en estado %.', p_estado_nuevo;
  END IF;

  -- Matriz de transiciones válidas (EST-01)
  v_permitido := CASE
    WHEN v_actual = 'SIN PROGRAMAR'    AND p_estado_nuevo IN ('PROGRAMADA','CANCELADA') THEN TRUE
    WHEN v_actual = 'PROGRAMADA'       AND p_estado_nuevo IN ('EN VERIFICACIÓN','SIN PROGRAMAR','CANCELADA') THEN TRUE
    WHEN v_actual = 'EN VERIFICACIÓN'  AND p_estado_nuevo IN ('EJECUTADA','PROGRAMADA','CANCELADA') THEN TRUE
    ELSE FALSE
  END;

  IF v_actual = 'EJECUTADA' THEN
    RAISE EXCEPTION 'No se puede cambiar el estado de una OS EJECUTADA (EST-06).';
  END IF;
  IF NOT v_permitido THEN
    RAISE EXCEPTION 'Transición de estado inválida: % → %.', v_actual, p_estado_nuevo;
  END IF;

  -- Motivo obligatorio: CANCELADA y rechazo de verificación (EN VERIFICACIÓN → PROGRAMADA)
  IF (p_estado_nuevo = 'CANCELADA'
      OR (v_actual = 'EN VERIFICACIÓN' AND p_estado_nuevo = 'PROGRAMADA'))
     AND (p_motivo IS NULL OR btrim(p_motivo) = '') THEN
    RAISE EXCEPTION 'El motivo es obligatorio para esta transición (% → %).', v_actual, p_estado_nuevo;
  END IF;

  UPDATE sst.ordenes_servicio
     SET estado = p_estado_nuevo,
         fecha_ejecucion = CASE WHEN p_estado_nuevo = 'EJECUTADA' THEN now() ELSE fecha_ejecucion END
   WHERE id = p_orden_id
   RETURNING * INTO v_fila;

  INSERT INTO sst.historial_estados_orden (orden_id, estado_anterior, estado_nuevo, cambiado_por, motivo)
  VALUES (p_orden_id, v_actual, p_estado_nuevo, p_cambiado_por, NULLIF(btrim(coalesce(p_motivo,'')), ''));

  RETURN v_fila;
END; $$ LANGUAGE plpgsql;

-- =============================================================================
-- VISTAS  ·  M10 (RPT-01/02) + apoyo a listados
-- =============================================================================

-- Listado expandido de OS con nombres legibles (apoya M3 / Informes).
-- Se re-crea desde cero (no OR REPLACE) porque `o.*` cambia de columnas cuando
-- se agregan campos a ordenes_servicio, y CREATE OR REPLACE no admite reordenar.
DROP VIEW IF EXISTS sst.vw_ordenes_expandidas;
CREATE VIEW sst.vw_ordenes_expandidas AS
SELECT o.*,
       a.nombre         AS arl_nombre,
       a.formato_origen AS arl_formato,
       p.nombre         AS profesional_nombre,
       p.correo         AS profesional_correo
FROM sst.ordenes_servicio o
JOIN sst.arls a               ON a.id = o.arl_id
LEFT JOIN sst.profesionales p ON p.id = o.profesional_asignado_id;

-- RPT-01 · KPIs globales del dashboard.
-- DROP + CREATE (y no CREATE OR REPLACE): la vista ganó `ejecutadas_mes` en medio
-- y Postgres solo permite reemplazar añadiendo columnas al final.
DROP VIEW IF EXISTS sst.vw_kpis_dashboard;
CREATE VIEW sst.vw_kpis_dashboard AS
SELECT
  count(*)                                                   AS total_ordenes,
  count(*) FILTER (WHERE estado = 'SIN PROGRAMAR')           AS sin_programar,
  count(*) FILTER (WHERE estado = 'PROGRAMADA')              AS programadas,
  count(*) FILTER (WHERE estado = 'EN VERIFICACIÓN')         AS en_verificacion,
  count(*) FILTER (WHERE estado = 'EJECUTADA')               AS ejecutadas,
  -- RPT-01 pide "ejecutadas EN EL MES": el acumulado histórico se conserva
  -- arriba porque lo usan los porcentajes por ARL y la cartera.
  count(*) FILTER (
    WHERE estado = 'EJECUTADA'
      AND date_trunc('month', COALESCE(fecha_ejecucion, actualizado_en)) = date_trunc('month', now())
  )                                                          AS ejecutadas_mes,
  count(*) FILTER (WHERE estado = 'CANCELADA')               AS canceladas,
  count(*) FILTER (
    WHERE (metadatos_extraccion->>'overall_confidence') IS NOT NULL
      AND (metadatos_extraccion->>'overall_confidence')::numeric < 70
  )                                                          AS alertas_baja_confianza
FROM sst.ordenes_servicio;

-- RPT-02 · Distribución de OS por ARL.
CREATE OR REPLACE VIEW sst.vw_ordenes_por_arl AS
SELECT a.id AS arl_id, a.nombre AS arl_nombre,
       count(o.id) AS total,
       count(o.id) FILTER (WHERE o.estado = 'EJECUTADA') AS ejecutadas
FROM sst.arls a
LEFT JOIN sst.ordenes_servicio o ON o.arl_id = a.id
GROUP BY a.id, a.nombre
ORDER BY a.nombre;

-- ENC-05/07 · Encuestas con todo lo legible ya resuelto: alimenta el dashboard
-- de satisfacción, el listado y la exportación.
--
-- Los nombres salen del snapshot de la encuesta y solo caen al JOIN vivo cuando
-- falta (encuestas creadas antes de que existiera el snapshot).
DROP VIEW IF EXISTS sst.vw_encuestas;
CREATE VIEW sst.vw_encuestas AS
SELECT e.id,
       e.orden_id,
       o.codigo                                   AS orden_codigo,
       COALESCE(e.empresa_nombre, o.empresa_nombre) AS empresa_nombre,
       COALESCE(e.arl_id, o.arl_id)               AS arl_id,
       a.nombre                                   AS arl_nombre,
       COALESCE(e.profesional_id, o.profesional_asignado_id) AS profesional_id,
       p.nombre                                   AS profesional_nombre,
       o.actividad_economica,
       o.horas_asignadas,
       o.fecha_programada,
       e.contacto_nombre,
       e.contacto_correo,
       e.satisfaccion,
       e.recomendacion,
       e.comentarios,
       e.preguntas,
       e.enviado_en,
       e.respondido_en,
       e.respondido_en IS NOT NULL                AS respondida,
       date_trunc('month', COALESCE(e.respondido_en, e.enviado_en, e.creado_en)) AS mes
FROM sst.respuestas_encuesta e
JOIN sst.ordenes_servicio o     ON o.id = e.orden_id
LEFT JOIN sst.arls a            ON a.id = COALESCE(e.arl_id, o.arl_id)
LEFT JOIN sst.profesionales p   ON p.id = COALESCE(e.profesional_id, o.profesional_asignado_id);

-- PRE-01 · Horas ejecutadas por profesional y mes: la materia prima de la
-- pre-cuenta.
--
-- El mes de una OS es el de su `fecha_programada` (cuándo se ejecutó la
-- actividad), no el de su carga: una orden importada en junio y ejecutada en
-- julio se le paga al profesional en julio. Si no tiene fecha programada se cae
-- a `actualizado_en`, que en una OS EJECUTADA es su último cambio de estado.
DROP VIEW IF EXISTS sst.vw_horas_ejecutadas;
CREATE VIEW sst.vw_horas_ejecutadas AS
SELECT o.id                     AS orden_id,
       o.codigo                 AS orden_codigo,
       o.profesional_asignado_id AS profesional_id,
       p.nombre                 AS profesional_nombre,
       o.empresa_nombre,
       a.nombre                 AS arl_nombre,
       o.tipo_actividad,
       o.actividad_economica,
       COALESCE(o.horas_asignadas, 0) AS horas,
       COALESCE(o.fecha_programada, o.actualizado_en)::date AS fecha_ejecucion,
       to_char(COALESCE(o.fecha_programada, o.actualizado_en), 'YYYY-MM') AS periodo
FROM sst.ordenes_servicio o
JOIN sst.arls a               ON a.id = o.arl_id
LEFT JOIN sst.profesionales p ON p.id = o.profesional_asignado_id
WHERE o.estado = 'EJECUTADA' AND o.profesional_asignado_id IS NOT NULL;

-- RPT-03 · Órdenes vencidas: llevan demasiado tiempo sin ejecutarse.
--
-- La antigüedad se cuenta desde la fecha de la orden y, si la ARL no la trae,
-- desde que se cargó al sistema. El umbral (60 días en el FRS) NO va aquí: lo
-- aplica la consulta, para poder mirar el reporte con otro corte sin migrar.
DROP VIEW IF EXISTS sst.vw_ordenes_vencidas;
CREATE VIEW sst.vw_ordenes_vencidas AS
SELECT o.id,
       o.codigo,
       o.estado,
       o.empresa_nombre,
       o.nit_nic,
       a.nombre  AS arl_nombre,
       o.arl_id,
       p.nombre  AS profesional_nombre,
       o.profesional_asignado_id AS profesional_id,
       o.horas_asignadas,
       o.fecha_orden,
       o.fecha_vencimiento,
       o.fecha_carga,
       o.fecha_programada,
       COALESCE(o.fecha_orden, o.fecha_carga::date)                         AS fecha_referencia,
       (CURRENT_DATE - COALESCE(o.fecha_orden, o.fecha_carga::date))::int    AS dias_transcurridos,
       CASE WHEN o.fecha_vencimiento IS NOT NULL
            THEN (o.fecha_vencimiento - CURRENT_DATE)::int END               AS dias_para_vencer
FROM sst.ordenes_servicio o
JOIN sst.arls a               ON a.id = o.arl_id
LEFT JOIN sst.profesionales p ON p.id = o.profesional_asignado_id
WHERE o.estado NOT IN ('EJECUTADA', 'CANCELADA');

-- RPT-06 · Cartera: ejecutadas que siguen sin facturar o sin validar la ARL.
DROP VIEW IF EXISTS sst.vw_cartera;
CREATE VIEW sst.vw_cartera AS
SELECT o.id,
       o.codigo,
       o.empresa_nombre,
       o.nit_nic,
       o.arl_id,
       a.nombre AS arl_nombre,
       o.profesional_asignado_id AS profesional_id,
       p.nombre AS profesional_nombre,
       o.horas_asignadas,
       o.valor_total,
       COALESCE(o.fecha_programada, o.actualizado_en)::date AS fecha_ejecucion,
       (CURRENT_DATE - COALESCE(o.fecha_programada, o.actualizado_en)::date)::int AS dias_desde_ejecucion,
       o.facturado_en,
       o.validado_arl_en,
       -- Etiqueta única para agrupar y para pintar la fila.
       CASE WHEN o.facturado_en IS NULL AND o.validado_arl_en IS NULL THEN 'sin_facturar_ni_validar'
            WHEN o.facturado_en IS NULL                               THEN 'sin_facturar'
            ELSE 'sin_validar_arl' END AS pendiente
FROM sst.ordenes_servicio o
JOIN sst.arls a               ON a.id = o.arl_id
LEFT JOIN sst.profesionales p ON p.id = o.profesional_asignado_id
WHERE o.estado = 'EJECUTADA'
  AND (o.facturado_en IS NULL OR o.validado_arl_en IS NULL);

-- PRE-08 · Pre-cuentas con los datos del profesional ya resueltos.
DROP VIEW IF EXISTS sst.vw_precuentas;
CREATE VIEW sst.vw_precuentas AS
SELECT pc.*,
       p.nombre  AS profesional_nombre,
       p.correo  AS profesional_correo,
       (SELECT count(*)::int FROM sst.precuenta_items i WHERE i.precuenta_id = pc.id) AS total_ordenes
FROM sst.precuentas pc
JOIN sst.profesionales p ON p.id = pc.profesional_id;

-- RPT-01 · Estados dentro del mes en curso.
CREATE OR REPLACE VIEW sst.vw_estados_mensual AS
SELECT date_trunc('month', fecha_carga) AS mes,
       estado,
       count(*) AS total
FROM sst.ordenes_servicio
GROUP BY 1, 2
ORDER BY 1 DESC, 2;
