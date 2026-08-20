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
--
-- FINALIZADA es el final REAL del ciclo (ago-2026): EJECUTADA solo dice que el
-- profesional subió los soportes, y ahí se quedaba la orden para siempre, sin
-- forma de distinguir la que nadie ha revisado de la que ya se dio por buena.
-- Se alcanza al aceptar los soportes y de ahí no se sale.
--
-- El valor se añade también en `db/migrate.js` para las bases que ya existen:
-- Postgres no deja USAR un valor de enum en la misma transacción en que se
-- agrega, así que no puede ir aquí dentro (las vistas de abajo lo nombran).
DO $$ BEGIN
  CREATE TYPE sst.estado_orden AS ENUM (
    'SIN PROGRAMAR', 'PROGRAMADA', 'EN VERIFICACIÓN', 'EJECUTADA', 'FINALIZADA', 'CANCELADA'
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

-- IMP-09 · Huella SHA-256 del archivo subido.
--
-- Sirve para responder ANTES de gastar una petición de IA la única pregunta que
-- importa al volver a soltar un documento en Importar: "¿este archivo ya se
-- procesó?". El mismo PDF de la ARL se descarga y se vuelve a cargar con
-- normalidad —en la bandeja actual hay uno repetido cuatro veces—, y cada
-- repetición costaba una extracción completa para acabar en "ya existe".
ALTER TABLE sst.lotes_importacion ADD COLUMN IF NOT EXISTS hash_archivo TEXT;
CREATE INDEX IF NOT EXISTS idx_lotes_importacion_hash
  ON sst.lotes_importacion(hash_archivo) WHERE hash_archivo IS NOT NULL;

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
-- VER-01 / PRE-01 · Cuándo un administrador dio por buenos los soportes.
--
-- No mueve el estado (la OS ya está EJECUTADA desde que el profesional subió los
-- archivos), pero es LA condición para que la orden entre a la cuenta de cobro
-- del profesional: se le paga por trabajo revisado, no por trabajo subido. Antes
-- ese hecho solo quedaba como una fila de historial con un motivo de texto, que
-- no es algo sobre lo que se pueda construir una consulta de cobro.
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS soportes_aceptados_en  TIMESTAMPTZ;
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS soportes_aceptados_por UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_ordenes_soportes_aceptados
  ON sst.ordenes_servicio(soportes_aceptados_en) WHERE soportes_aceptados_en IS NOT NULL;

-- ⭐ CFG-04 · Catálogo de TIPOS DE ORDEN con su valor hora.
--
-- Es la lista de "Valores por hora según actividad" de Configuración, que hasta
-- ahora vivía escrita a mano en la pantalla y no se guardaba en ninguna parte.
-- Al pasar a ser tabla, cada OS apunta a un tipo y de ahí sale lo que se le
-- paga al profesional por hora.
--
-- OJO con el histórico: la orden NO lee el valor por la clave foránea, sino que
-- se queda con una COPIA (`ordenes_servicio.valor_hora_cobro`) en el momento en
-- que se asigna el profesional. Si mañana sube la hora de "Capacitación", las
-- órdenes ya asignadas siguen valiendo lo que valían — que es justo lo que una
-- cuenta de cobro ya enviada necesita para no cambiar sola.
CREATE TABLE IF NOT EXISTS sst.tipos_orden (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre         TEXT NOT NULL,
  valor_hora     NUMERIC(12,2) NOT NULL DEFAULT 0,
  -- No se borran: una orden vieja puede seguir apuntando a un tipo que ya no se
  -- usa, y perder el nombre dejaría su historial sin explicación.
  activo         BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tipos_orden_nombre
  ON sst.tipos_orden (lower(btrim(nombre)));

-- Los tres que ya estaban escritos en la pantalla (y que coinciden con las
-- tarifas por profesional cargadas). Van aquí y no en seed.sql porque el relleno
-- de las órdenes los necesita ya creados.
INSERT INTO sst.tipos_orden (nombre, valor_hora) VALUES
  ('Capacitación', 85000),
  ('Asesoría',    120000),
  ('Inspección',   95000)
ON CONFLICT DO NOTHING;

-- ⭐ CFG-04 / PRE-02 · Categoría de la orden y lo que se paga por ella.
--
-- `tipo_orden_id` es OBLIGATORIO al cargar una OS (lo exige el backend, no un
-- NOT NULL: las órdenes anteriores al cambio se rellenaron con el bloque del
-- final y una restricción dura habría hecho fallar la migración a mitad).
--
-- `valor_hora_cobro` es la COPIA del valor vigente cuando se asignó al
-- profesional, y `valor_hora_origen` de dónde salió ('tarifa' del profesional,
-- 'tipo' del catálogo o 'profesional' por su valor base). Congelarlo es el
-- punto: un cambio de tarifa no puede reescribir lo que ya se trabajó.
--
-- El total va como columna GENERADA: se recalcula solo si cambian las horas de
-- la orden y no puede quedar desincronizado por olvidar actualizarlo.
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS tipo_orden_id     UUID REFERENCES sst.tipos_orden(id);
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS valor_hora_cobro  NUMERIC(12,2);
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS valor_hora_origen TEXT;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='sst' AND table_name='ordenes_servicio' AND column_name='valor_cobro_total'
  ) THEN
    ALTER TABLE sst.ordenes_servicio
      ADD COLUMN valor_cobro_total NUMERIC(14,2)
      GENERATED ALWAYS AS (round(COALESCE(horas_asignadas,0) * COALESCE(valor_hora_cobro,0), 2)) STORED;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_ordenes_tipo ON sst.ordenes_servicio(tipo_orden_id);

-- El borrador arrastra el tipo elegido en la vista previa de Importar, para que
-- la OS nazca con él. Se guarda en columna y no en el JSON de la extracción: no
-- lo dice el documento de la ARL, lo decide quien revisa.
ALTER TABLE sst.borradores_extraccion ADD COLUMN IF NOT EXISTS tipo_orden_id UUID REFERENCES sst.tipos_orden(id);

-- VER-04 · QUÉ soportes se devolvieron para corregir, no solo que "hubo rechazo".
--
-- El rechazo era total: la orden volvía entera y el profesional podía subirlo
-- todo otra vez, incluido lo que ya estaba bien. Guardando las categorías
-- devueltas, el portal abre solo esas casillas y deja las demás bloqueadas, y
-- el correo puede decir exactamente qué documento repetir.
--
-- Es una lista de PENDIENTES, no un histórico: se vacía en cuanto el
-- profesional sube lo que le devolvieron o el administrador acepta los
-- soportes. El histórico de rechazos vive en historial_estados_orden.
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS soportes_rechazados     TEXT[];
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS soportes_rechazo_motivo TEXT;
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS soportes_rechazados_en  TIMESTAMPTZ;

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

-- ASG-02 · Franjas en que se ejecuta la visita de una OS.
--
-- `ordenes_servicio.fecha_programada` solo sabe de UN instante, y una visita
-- real se parte: mañana y tarde, o varios días. Esa columna se conserva (la usan
-- los reportes, la cartera, el periodo de la pre-cuenta y el orden del listado)
-- y queda igual al INICIO de la primera franja; el detalle vive aquí.
-- Una OS sin franjas es una OS a la antigua: se lee su fecha_programada y ya.
CREATE TABLE IF NOT EXISTS sst.franjas_visita (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  orden_id    UUID NOT NULL REFERENCES sst.ordenes_servicio(id) ON DELETE CASCADE,
  fecha       DATE NOT NULL,
  hora_inicio TIME NOT NULL,
  hora_fin    TIME NOT NULL,
  creado_por  UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL,
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_franja_visita_rango CHECK (hora_fin > hora_inicio)
);
CREATE INDEX IF NOT EXISTS idx_franjas_visita_orden ON sst.franjas_visita(orden_id, fecha, hora_inicio);

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

-- SUP · Categoría y nombre interno del soporte (ago-2026).
--
-- `nombre_original` es lo que traía el archivo del móvil del profesional
-- ('IMG_20260815_142233.jpg'), y con eso el administrador no sabía qué estaba
-- abriendo. Ahora la casilla del portal en la que se subió queda registrada
-- (`categoria`) y el sistema le pone un nombre propio (`nombre_archivo`:
-- 'acta.pdf', 'evidencias.jpg'). El original se conserva para poder decirle al
-- profesional cuál de los suyos hay que repetir.
--
-- `tamano_original_bytes` guarda cuánto pesaba antes de comprimir: sin ese dato
-- no hay forma de saber si la compresión está sirviendo en producción.
ALTER TABLE sst.archivos_soporte ADD COLUMN IF NOT EXISTS categoria             TEXT;
ALTER TABLE sst.archivos_soporte ADD COLUMN IF NOT EXISTS nombre_archivo        TEXT;
ALTER TABLE sst.archivos_soporte ADD COLUMN IF NOT EXISTS tamano_original_bytes BIGINT;

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

-- NOT-04 · Papelera de la campanita.
--
-- Antes solo se podía marcar leída, así que la bandeja crecía sin fin y los
-- avisos ya resueltos seguían estorbando. Se borra en blando y no de verdad:
-- una notificación es el rastro de un hecho de negocio (una asignación, un
-- rechazo), y ese rastro no se tira por limpiar la vista — de ahí que la
-- pestaña "Eliminadas" pueda devolverla.
ALTER TABLE sst.notificaciones ADD COLUMN IF NOT EXISTS eliminado_en TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_notificaciones_bandeja
  ON sst.notificaciones(usuario_id, eliminado_en, creado_en DESC);

-- ENC-05 · Los avisos de encuesta anteriores al cambio no traían el profesional,
-- y sin él la campanita no sabía a qué ficha llevar: se quedaban abriendo la
-- orden, que es justo lo que se quería dejar de hacer. Se rellena desde la OS.
UPDATE sst.notificaciones n
   SET datos = COALESCE(n.datos, '{}'::jsonb)
               || jsonb_build_object('profesional_id', o.profesional_asignado_id)
  FROM sst.ordenes_servicio o
 WHERE n.tipo = 'ENCUESTA_RESPONDIDA'
   AND o.id::text = n.datos->>'orden_id'
   AND o.profesional_asignado_id IS NOT NULL
   AND NOT (n.datos ? 'profesional_id');

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

-- ENC-03 · La encuesta califica DOS cosas distintas, no una.
--
-- `satisfaccion` mide la actividad recibida y `recomendacion` a JD&D como
-- empresa; faltaba la nota del PROFESIONAL que dictó la capacitación, que es
-- justo la que permite hacerle seguimiento a cada asesor. Se guarda aparte para
-- poder promediarla sola.
--
-- Las encuestas anteriores a esta columna quedan en NULL: no se rellenan con la
-- satisfacción general, porque no es lo mismo. Donde hace falta una nota del
-- profesional para promediar (la vista de desempeño) se usa el COALESCE, y ahí
-- sí queda dicho que es una aproximación.
ALTER TABLE sst.respuestas_encuesta ADD COLUMN IF NOT EXISTS calificacion_profesional SMALLINT;

-- Los topes viven en la BD y no solo en el formulario: el comentario se pinta en
-- la tabla de Informes y en el detalle del profesional, y un texto de 20.000
-- caracteres pegado desde un correo rompe las dos vistas.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_encuesta_calificacion_profesional') THEN
    ALTER TABLE sst.respuestas_encuesta
      ADD CONSTRAINT chk_encuesta_calificacion_profesional
      CHECK (calificacion_profesional IS NULL OR calificacion_profesional BETWEEN 1 AND 5);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_encuesta_comentarios_largo') THEN
    ALTER TABLE sst.respuestas_encuesta
      ADD CONSTRAINT chk_encuesta_comentarios_largo
      CHECK (comentarios IS NULL OR char_length(comentarios) <= 500);
  END IF;
END $$;

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

-- EST-06: proteger el cierre de la OS (defensa en profundidad, además de la
-- matriz de sst.cambiar_estado_orden).
--
-- Desde EJECUTADA solo caben dos salidas: FINALIZADA (el administrador aceptó
-- los soportes) y PROGRAMADA (los rechazó y se los devuelve al profesional).
-- Esa marcha atrás existe porque, al no haber estado intermedio, sin ella no
-- habría forma de devolver el trabajo.
--
-- FINALIZADA no tiene salida: es el cierre del ciclo y de él cuelgan la encuesta
-- al cliente y la cuenta de cobro del profesional. Reabrir una orden cerrada es
-- una decisión de negocio, no un clic.
CREATE OR REPLACE FUNCTION sst.fn_bloquear_regresion_ejecutada() RETURNS trigger AS $$
BEGIN
  IF OLD.estado = 'FINALIZADA' AND NEW.estado <> 'FINALIZADA' THEN
    RAISE EXCEPTION 'Una OS FINALIZADA no vuelve atrás: es el cierre del ciclo.';
  END IF;
  IF OLD.estado = 'EJECUTADA'
     AND NEW.estado NOT IN ('EJECUTADA', 'PROGRAMADA', 'FINALIZADA') THEN
    RAISE EXCEPTION 'Desde EJECUTADA solo se puede FINALIZAR (aceptar soportes) o volver a PROGRAMADA (rechazarlos).';
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

  -- Matriz de transiciones válidas.
  --
  -- El ciclo son CUATRO estados (ago-2026, a pedido del cliente):
  --   SIN PROGRAMAR → PROGRAMADA → EJECUTADA → FINALIZADA
  --
  -- EJECUTADA la pone el PROFESIONAL al subir los soportes; FINALIZADA la pone
  -- el ADMINISTRADOR al aceptarlos. Antes no existía la segunda y la orden se
  -- quedaba en EJECUTADA para siempre: no había manera de mirar la bandeja y
  -- saber qué estaba revisado y qué no.
  --
  -- Se eliminaron EN VERIFICACIÓN (subir soportes deja la OS EJECUTADA
  -- directamente) y CANCELADA (una orden anulada se DESHABILITA en la bandeja,
  -- que es soft-delete del borrador y no un estado de la OS). Los valores siguen
  -- existiendo en el enum `sst.estado_orden` porque Postgres no permite quitar
  -- valores de un tipo enumerado; simplemente ya no se alcanzan.
  --
  -- EJECUTADA → PROGRAMADA es la única marcha atrás y existe a propósito: es el
  -- rechazo de soportes (VER-02). Sin ella, al no haber estado intermedio, el
  -- administrador no tendría forma de devolverle el trabajo al profesional.
  -- Diverge de EST-06, que prohibía salir de EJECUTADA.
  v_permitido := CASE
    WHEN v_actual = 'SIN PROGRAMAR' AND p_estado_nuevo = 'PROGRAMADA'    THEN TRUE
    WHEN v_actual = 'PROGRAMADA'    AND p_estado_nuevo IN ('EJECUTADA','SIN PROGRAMAR') THEN TRUE
    WHEN v_actual = 'EJECUTADA'     AND p_estado_nuevo IN ('FINALIZADA','PROGRAMADA') THEN TRUE
    ELSE FALSE
  END;

  IF NOT v_permitido THEN
    RAISE EXCEPTION 'Transición de estado inválida: % → %.', v_actual, p_estado_nuevo;
  END IF;

  -- Motivo obligatorio en las marchas atrás: rechazar soportes
  -- (EJECUTADA → PROGRAMADA) y devolver una visita a la bandeja
  -- (PROGRAMADA → SIN PROGRAMAR). En ambas alguien deshace trabajo hecho y hay
  -- que poder saber por qué.
  IF (v_actual = 'EJECUTADA'  AND p_estado_nuevo = 'PROGRAMADA')
     OR (v_actual = 'PROGRAMADA' AND p_estado_nuevo = 'SIN PROGRAMAR') THEN
    IF p_motivo IS NULL OR btrim(p_motivo) = '' THEN
      RAISE EXCEPTION 'El motivo es obligatorio para esta transición (% → %).', v_actual, p_estado_nuevo;
    END IF;
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
       p.correo         AS profesional_correo,
       -- CFG-04 · El NOMBRE del tipo de orden viaja resuelto: la vista de
       -- Órdenes lo enseña en cada fila y pedir el catálogo aparte para
       -- traducir un id sería un viaje por pantalla.
       tp.nombre        AS tipo_orden,
       tp.valor_hora    AS tipo_orden_valor_hora
FROM sst.ordenes_servicio o
JOIN sst.arls a               ON a.id = o.arl_id
LEFT JOIN sst.profesionales p ON p.id = o.profesional_asignado_id
LEFT JOIN sst.tipos_orden tp  ON tp.id = o.tipo_orden_id;

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
  -- Un contador por estado, cada uno puro: la pantalla los pinta como tarjetas
  -- separadas y sumarlos aquí las descuadraría. Donde hace falta "el trabajo
  -- hecho" (el KPI de arriba del dashboard) se suman los dos, que es una
  -- decisión de presentación.
  count(*) FILTER (WHERE estado = 'EJECUTADA')               AS ejecutadas,
  count(*) FILTER (WHERE estado = 'FINALIZADA')              AS finalizadas,
  -- RPT-01 pide "ejecutadas EN EL MES": el acumulado histórico se conserva
  -- arriba porque lo usan los porcentajes por ARL y la cartera.
  count(*) FILTER (
    WHERE estado IN ('EJECUTADA','FINALIZADA')
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
       count(o.id) FILTER (WHERE o.estado IN ('EJECUTADA','FINALIZADA')) AS ejecutadas
FROM sst.arls a
LEFT JOIN sst.ordenes_servicio o ON o.arl_id = a.id
GROUP BY a.id, a.nombre
ORDER BY a.nombre;

-- ENC-05/07 · Encuestas con todo lo legible ya resuelto: alimenta el dashboard
-- de satisfacción, el listado y la exportación.
--
-- Los nombres salen del snapshot de la encuesta y solo caen al JOIN vivo cuando
-- falta (encuestas creadas antes de que existiera el snapshot).
DROP VIEW IF EXISTS sst.vw_encuestas CASCADE;
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
       e.calificacion_profesional,
       -- Con qué nota entra esta encuesta al promedio del profesional. Las
       -- anteriores a la pregunta nueva aportan su satisfacción general, que es
       -- lo más cercano que hay: descartarlas dejaría a media plantilla sin
       -- historial de un día para otro.
       COALESCE(e.calificacion_profesional, e.satisfaccion) AS nota_profesional,
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

-- CFG-01 / ENC-05 · Lo que se ve de un profesional en su listado: cuánto trabajo
-- cerró y cómo lo califican.
--
-- Las dos cifras van juntas porque una sin la otra engaña: un 5,0 de una sola
-- encuesta no dice lo mismo que un 4,6 de cuarenta, y la encuesta es OPCIONAL —
-- un asesor puede tener 100 órdenes ejecutadas y 10 respuestas. Por eso viaja
-- también `encuestas_respondidas`, que es lo que le pone tamaño a la nota.
DROP VIEW IF EXISTS sst.vw_profesionales_desempeno;
CREATE VIEW sst.vw_profesionales_desempeno AS
SELECT p.id AS profesional_id,
       COALESCE(o.ordenes_ejecutadas, 0)   AS ordenes_ejecutadas,
       COALESCE(e.encuestas_enviadas, 0)   AS encuestas_enviadas,
       COALESCE(e.encuestas_respondidas, 0) AS encuestas_respondidas,
       e.calificacion_promedio,
       e.ultima_calificacion_en
FROM sst.profesionales p
LEFT JOIN LATERAL (
  SELECT count(*)::int AS ordenes_ejecutadas
    FROM sst.ordenes_servicio os
   WHERE os.profesional_asignado_id = p.id AND os.estado IN ('EJECUTADA','FINALIZADA')
) o ON true
LEFT JOIN LATERAL (
  SELECT count(*)::int                                    AS encuestas_enviadas,
         count(*) FILTER (WHERE v.respondida)::int        AS encuestas_respondidas,
         round(avg(v.nota_profesional) FILTER (WHERE v.respondida)::numeric, 2) AS calificacion_promedio,
         max(v.respondido_en)                             AS ultima_calificacion_en
    FROM sst.vw_encuestas v
   WHERE v.profesional_id = p.id
) e ON true;

-- PRE-01 · Rellena `soportes_aceptados_en` en las órdenes que ya se habían
-- revisado antes de que existiera la columna. La huella está en el historial,
-- que es donde se dejaba constancia hasta ahora; sin este bloque esas órdenes
-- desaparecerían de las cuentas de cobro al desplegar.
DO $$
BEGIN
  UPDATE sst.ordenes_servicio o
     SET soportes_aceptados_en = h.primera_aceptacion
    FROM (
      SELECT orden_id, min(cambiado_en) AS primera_aceptacion
        FROM sst.historial_estados_orden
       WHERE motivo = 'Soportes revisados y aceptados'
       GROUP BY orden_id
    ) h
   WHERE h.orden_id = o.id
     AND o.soportes_aceptados_en IS NULL;
END $$;

-- CFG-04 · Ninguna orden puede quedarse sin tipo.
--
-- El campo es obligatorio de aquí en adelante, pero las 38 que ya estaban
-- cargadas no lo tenían. Se deduce del título de la actividad que trajo la ARL
-- ("CAP SEGURIDAD VIAL" → Capacitación) y, cuando no dice nada —la mayoría, que
-- llegó sin ese dato—, cae en Capacitación, que es lo que hace esta empresa casi
-- siempre. Es una suposición y se puede corregir orden por orden desde Órdenes;
-- lo que no se podía dejar es la mitad de la bandeja sin categoría, porque de
-- ella cuelga el valor hora del profesional.
DO $$
DECLARE v_cap UUID; v_ase UUID; v_ins UUID; v_n INTEGER;
BEGIN
  SELECT id INTO v_cap FROM sst.tipos_orden WHERE lower(btrim(nombre)) = 'capacitación';
  SELECT id INTO v_ase FROM sst.tipos_orden WHERE lower(btrim(nombre)) = 'asesoría';
  SELECT id INTO v_ins FROM sst.tipos_orden WHERE lower(btrim(nombre)) = 'inspección';
  IF v_cap IS NULL THEN RETURN; END IF;

  UPDATE sst.ordenes_servicio
     SET tipo_orden_id = CASE
           WHEN tipo_actividad ILIKE '%asesor%' THEN COALESCE(v_ase, v_cap)
           WHEN tipo_actividad ILIKE '%inspec%' THEN COALESCE(v_ins, v_cap)
           ELSE v_cap
         END
   WHERE tipo_orden_id IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    RAISE NOTICE 'CFG-04: % orden(es) sin tipo quedaron categorizadas.', v_n;
  END IF;

  -- Los borradores todavía sin validar arrancan con la misma suposición, para
  -- que la vista previa llegue con el desplegable ya puesto.
  UPDATE sst.borradores_extraccion
     SET tipo_orden_id = CASE
           WHEN metadatos_extraccion->'tipo_actividad'->>'value' ILIKE '%asesor%' THEN COALESCE(v_ase, v_cap)
           WHEN metadatos_extraccion->'tipo_actividad'->>'value' ILIKE '%inspec%' THEN COALESCE(v_ins, v_cap)
           ELSE v_cap
         END
   WHERE tipo_orden_id IS NULL AND estado <> 'VALIDADA';
END $$;

-- PRE-02 · Y las que ya tienen profesional se quedan con SU valor hora.
--
-- Se congela el que estaría vigente hoy, con el mismo orden de resolución que
-- usa la asignación: tarifa del profesional para ese tipo → valor del tipo →
-- valor base del profesional. Sin este bloque, las órdenes ya asignadas
-- entrarían a la cuenta de cobro con valor cero.
UPDATE sst.ordenes_servicio o
   SET valor_hora_cobro = v.valor, valor_hora_origen = v.origen
  FROM (
    SELECT o2.id,
           COALESCE(t.valor_hora, NULLIF(tp.valor_hora, 0), p.valor_hora, 0) AS valor,
           CASE WHEN t.valor_hora IS NOT NULL          THEN 'tarifa'
                WHEN COALESCE(tp.valor_hora, 0) > 0    THEN 'tipo'
                ELSE 'profesional' END                 AS origen
      FROM sst.ordenes_servicio o2
      JOIN sst.profesionales p       ON p.id  = o2.profesional_asignado_id
      LEFT JOIN sst.tipos_orden tp   ON tp.id = o2.tipo_orden_id
      LEFT JOIN LATERAL (
        SELECT ta.valor_hora
          FROM sst.tarifas_actividad_profesional ta
         WHERE ta.profesional_id = o2.profesional_asignado_id
           AND tp.nombre IS NOT NULL
           AND lower(ta.actividad) = lower(tp.nombre)
         ORDER BY ta.vigente_desde DESC LIMIT 1
      ) t ON true
     WHERE o2.valor_hora_cobro IS NULL
  ) v
 WHERE v.id = o.id;

-- EST-01 · Las órdenes cuyos soportes YA se habían aceptado nacen FINALIZADAS.
--
-- Se revisaron y se dieron por buenas cuando el estado final era EJECUTADA; sin
-- este bloque se quedarían mezcladas con las que nadie ha mirado todavía, que es
-- justo la distinción que el estado nuevo viene a hacer. El movimiento queda en
-- el historial, como cualquier otro cambio de estado.
DO $$
DECLARE v_n INTEGER;
BEGIN
  WITH movidas AS (
    UPDATE sst.ordenes_servicio
       SET estado = 'FINALIZADA'
     WHERE estado = 'EJECUTADA' AND soportes_aceptados_en IS NOT NULL
    RETURNING id, soportes_aceptados_por, soportes_aceptados_en
  )
  INSERT INTO sst.historial_estados_orden (orden_id, estado_anterior, estado_nuevo, cambiado_por, motivo, cambiado_en)
  SELECT id, 'EJECUTADA', 'FINALIZADA', soportes_aceptados_por,
         'Soportes aceptados (migración al estado FINALIZADA)', soportes_aceptados_en
    FROM movidas;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    RAISE NOTICE 'Migración de estados: % OS con soportes aceptados pasaron a FINALIZADA.', v_n;
  END IF;
END $$;

-- PRE-01 · Horas ejecutadas por profesional y mes: la materia prima de la
-- cuenta de cobro.
--
-- El mes de una OS es el de su EJECUCIÓN, no el de su carga ni el de la
-- revisión: una orden importada en junio, ejecutada en julio y revisada en
-- agosto se le paga al profesional en julio. Si no tiene fecha de ejecución se
-- cae a la programada y, en último término, a `actualizado_en`.
DROP VIEW IF EXISTS sst.vw_horas_ejecutadas CASCADE;
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
       -- PRE-02 · Lo que se le paga por esta orden, congelado al asignarla. La
       -- cuenta de cobro lee esto y no el catálogo: cambiar el valor hora de un
       -- tipo no puede reescribir lo ya trabajado.
       o.tipo_orden_id,
       tp.nombre           AS tipo_orden,
       o.valor_hora_cobro,
       o.valor_hora_origen,
       o.valor_cobro_total,
       COALESCE(o.fecha_ejecucion, o.fecha_programada, o.actualizado_en)::date AS fecha_ejecucion,
       to_char(COALESCE(o.fecha_ejecucion, o.fecha_programada, o.actualizado_en), 'YYYY-MM') AS periodo,
       o.soportes_aceptados_en
FROM sst.ordenes_servicio o
JOIN sst.arls a               ON a.id = o.arl_id
LEFT JOIN sst.profesionales p ON p.id = o.profesional_asignado_id
LEFT JOIN sst.tipos_orden tp  ON tp.id = o.tipo_orden_id
WHERE o.estado IN ('EJECUTADA','FINALIZADA') AND o.profesional_asignado_id IS NOT NULL;

-- ⭐ PRE-01 · Lo que de verdad se le puede cobrar a JD&D por un profesional.
--
-- Es `vw_horas_ejecutadas` más UNA condición: los soportes tienen que estar
-- aceptados. Que la OS esté EJECUTADA significa que el profesional subió los
-- archivos; que se le pueda pagar significa que un administrador los revisó y
-- los dio por buenos.
--
-- Va en una vista aparte y no como filtro de la anterior a propósito: los
-- informes de horas (RPT-05) miden trabajo EJECUTADO, y colarles aquí la
-- revisión les cambiaría la cifra sin que nadie lo pidiera.
DROP VIEW IF EXISTS sst.vw_horas_por_cobrar;
CREATE VIEW sst.vw_horas_por_cobrar AS
SELECT * FROM sst.vw_horas_ejecutadas WHERE soportes_aceptados_en IS NOT NULL;

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
WHERE o.estado NOT IN ('EJECUTADA', 'FINALIZADA', 'CANCELADA');

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
WHERE o.estado IN ('EJECUTADA','FINALIZADA')
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

-- =============================================================================
-- MIGRACIÓN (ago-2026) · Ciclo de vida reducido a tres estados
-- =============================================================================
-- El cliente pidió simplificar EST-01: SIN PROGRAMAR → PROGRAMADA → EJECUTADA.
-- Los valores 'EN VERIFICACIÓN' y 'CANCELADA' siguen en el enum porque Postgres
-- no permite eliminar valores de un tipo enumerado, pero ya no se alcanzan (ver
-- la matriz de sst.cambiar_estado_orden).
--
-- Las órdenes que estaban EN VERIFICACIÓN ya tienen sus soportes cargados: bajo
-- el modelo nuevo eso ES estar ejecutada, así que se convierten. Sin esto se
-- quedarían en un estado sin transiciones válidas, imposibles de mover.
--
-- Las CANCELADA históricas NO se tocan a propósito: son un hecho del pasado y
-- reinterpretarlas sería inventar. Se quedan como registro y no vuelven a
-- producirse.
DO $$
DECLARE v_n INT;
BEGIN
  SELECT count(*) INTO v_n FROM sst.ordenes_servicio WHERE estado = 'EN VERIFICACIÓN';
  IF v_n > 0 THEN
    -- La auditoría primero: necesita leer el estado anterior antes de pisarlo.
    INSERT INTO sst.historial_estados_orden (orden_id, estado_anterior, estado_nuevo, motivo)
    SELECT id, 'EN VERIFICACIÓN', 'EJECUTADA',
           'Migración: se eliminó el estado EN VERIFICACIÓN; los soportes ya estaban cargados.'
      FROM sst.ordenes_servicio WHERE estado = 'EN VERIFICACIÓN';

    UPDATE sst.ordenes_servicio
       SET estado = 'EJECUTADA',
           -- Sin fecha de ejecución la OS no entraría en la pre-cuenta del mes
           -- ni en los reportes de ejecución; se usa la de la visita.
           fecha_ejecucion = COALESCE(fecha_ejecucion, fecha_programada, now()),
           actualizado_en = now()
     WHERE estado = 'EN VERIFICACIÓN';

    RAISE NOTICE 'Migración de estados: % OS pasaron de EN VERIFICACIÓN a EJECUTADA.', v_n;
  END IF;
END $$;
