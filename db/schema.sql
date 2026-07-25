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

-- =============================================================================
-- COSTURAS FASE 2  ·  Tablas creadas físicamente, SIN lógica de backend.
-- (No implementar ENC-/PRE-/RPT-03..07 según la Regla de Oro.)
-- =============================================================================

-- M9 · Pre-cuenta de cobro
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

-- M8 · Encuestas de satisfacción
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
CREATE OR REPLACE VIEW sst.vw_kpis_dashboard AS
SELECT
  count(*)                                                   AS total_ordenes,
  count(*) FILTER (WHERE estado = 'SIN PROGRAMAR')           AS sin_programar,
  count(*) FILTER (WHERE estado = 'PROGRAMADA')              AS programadas,
  count(*) FILTER (WHERE estado = 'EN VERIFICACIÓN')         AS en_verificacion,
  count(*) FILTER (WHERE estado = 'EJECUTADA')               AS ejecutadas,
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

-- RPT-01 · Estados dentro del mes en curso.
CREATE OR REPLACE VIEW sst.vw_estados_mensual AS
SELECT date_trunc('month', fecha_carga) AS mes,
       estado,
       count(*) AS total
FROM sst.ordenes_servicio
GROUP BY 1, 2
ORDER BY 1 DESC, 2;
