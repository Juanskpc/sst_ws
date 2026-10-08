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
  CREATE TYPE sst.rol_usuario AS ENUM ('admin', 'administrativo', 'contador', 'auditor');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AUTH-04 · 'profesional' pasó a llamarse 'administrativo' (19-ago-2026).
--
-- Se confundía con los PROFESIONALES que hacen las visitas, que no tienen
-- cuenta: son fichas de `sst.profesionales` y trabajan por enlaces públicos.
-- Este rol es personal interno de JD&D cuyo acceso lo define la matriz de
-- permisos, nada más. Se renombra el valor del enum en vez de crear otro: así
-- las cuentas y las filas de `permisos_rol` que ya existían siguen valiendo.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'rol_usuario' AND e.enumlabel = 'profesional'
  ) THEN
    ALTER TYPE sst.rol_usuario RENAME VALUE 'profesional' TO 'administrativo';
  END IF;
END $$;

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
  rol                      sst.rol_usuario NOT NULL DEFAULT 'administrativo',
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

-- El DEFAULT de la columna no lo cambia el CREATE TABLE en una BD que ya existe.
ALTER TABLE sst.usuarios ALTER COLUMN rol SET DEFAULT 'administrativo';

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

-- 5-oct-2026 · Catálogo de especialidades (lo administra JD&D desde Profesionales).
-- `profesionales.especialidad` guarda el NOMBRE elegido, no un id: los formatos de
-- las ARL y los informes lo leen como texto, y eliminar una especialidad del
-- catálogo no puede dejar una ficha sin la suya.
CREATE TABLE IF NOT EXISTS sst.especialidades (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre         TEXT NOT NULL,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_especialidades_nombre
  ON sst.especialidades (lower(btrim(nombre)));

-- Catálogo de ARLs -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sst.arls (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre          TEXT NOT NULL UNIQUE,
  formato_origen  sst.formato_arl NOT NULL
);

-- ⭐ ASG · Profesionales REGISTRADOS ante cada ARL (ago-2026, a pedido del cliente)
--
-- Bolívar solo acepta que ejecuten sus órdenes profesionales que ella misma tiene
-- registrados y aprobados en su base, y no todo el equipo de JD&D lo está. El
-- registro NO es un atributo del profesional: es **por ARL**, caduca, y lo
-- identifica un código que asigna la propia ARL. Por eso es tabla y no una
-- columna booleana en `profesionales`.
--
-- De aquí sale la lista del segundo selector del modal de asignación: cuando
-- ejecuta un profesional sin registro, los formatos salen a nombre de uno que sí
-- lo tenga (`ordenes_servicio.profesional_formatos_id`, más abajo).
CREATE TABLE IF NOT EXISTS sst.profesionales_arl (
  profesional_id  UUID NOT NULL REFERENCES sst.profesionales(id) ON DELETE CASCADE,
  arl_id          UUID NOT NULL REFERENCES sst.arls(id),
  registrado      BOOLEAN NOT NULL DEFAULT TRUE,
  codigo_registro TEXT,
  vigente_hasta   DATE,
  observacion     TEXT,
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (profesional_id, arl_id)
);
CREATE INDEX IF NOT EXISTS idx_profesionales_arl_arl ON sst.profesionales_arl(arl_id) WHERE registrado;

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
  -- NULL en las órdenes de clientes particulares (A3-01): esas las paga
  -- `pagador_tercero_id`, que se añade al final del archivo junto a los terceros.
  arl_id                   UUID REFERENCES sst.arls(id),
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

-- ⭐ Catálogo de TIPOS DE VIÁTICO con su valor (ago-2026).
--
-- Mismo patrón que los tipos de orden y por el mismo motivo: el viático era un
-- número suelto que cada quien escribía como quería, y así dos órdenes del mismo
-- desplazamiento acababan con cifras distintas. Ahora se elige la categoría y el
-- valor sale de ella.
--
-- Y el mismo cuidado con el histórico: la orden se queda con una COPIA del valor
-- (`ordenes_servicio.viaticos_valor`) en el momento en que se elige. Si mañana
-- sube el viático de "Transporte intermunicipal", las órdenes ya cargadas siguen
-- valiendo lo que valían.
--
-- Nace VACÍO a propósito: las categorías y sus importes los pone JD&D desde
-- Configuración → Preferencias del sistema. Sembrar cifras inventadas sería peor
-- que no tener ninguna, porque nadie las revisaría.
CREATE TABLE IF NOT EXISTS sst.tipos_viatico (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre         TEXT NOT NULL,
  valor          NUMERIC(14,2) NOT NULL DEFAULT 0,
  -- No se borran: una orden vieja puede seguir apuntando a una categoría
  -- retirada, y perder el nombre dejaría su historial sin explicación.
  activo         BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tipos_viatico_nombre
  ON sst.tipos_viatico (lower(btrim(nombre)));

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

-- ⭐ FOR · Los dos enumerados que Bolívar exige en el formato AT-031 (ago-2026).
--
-- `tipo_servicio_arl` es la LETRA del tipo de actividad (A Asesoría, T
-- Asistencia Técnica, C Capacitación, E Servicio Especializado, M Material,
-- O Otros). La trae el propio SIPAB en su columna "Tipo Servicio" y hasta ahora
-- se descartaba: se guardaba como contexto en metadatos_extraccion y no la leía
-- nadie, así que la casilla del formato salía sin marcar y había que marcarla a
-- bolígrafo sobre el impreso.
--
-- `modalidad_ejecucion` NO está en ningún documento: la decide quien revisa la
-- orden, y es obligatoria en Bolívar. No es un adorno del formato — el
-- comunicado SNPARL-40035219-2025 de la ARL dice que el AT-031 vale para
-- actividades presenciales o virtuales pero que **el AT-028 es únicamente para
-- presenciales**, así que de este campo depende qué formatos se adjuntan.
--
-- OJO: no se reutiliza la columna `modalidad`, que ya existe. Esa es texto libre
-- extraído de los PDF de AXA y Colmena; mezclar ahí un enumerado de dos valores
-- dejaría el histórico sin poder interpretarse.
-- En el BORRADOR no llevan columna: viven dentro de `metadatos_extraccion`,
-- como cualquier otro campo del modal de revisión (`CAMPOS_BORRADOR`). Es lo
-- mismo que hace la fecha de vencimiento, que tampoco viene en el documento y
-- se escribe a mano en la vista previa. `tipo_orden_id` sí es columna porque no
-- es un campo del formulario de extracción, sino un id del catálogo CFG-04.
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS tipo_servicio_arl   CHAR(1);
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS modalidad_ejecucion TEXT;

-- Los CHECK van por separado y con guarda: `ADD CONSTRAINT` no admite
-- IF NOT EXISTS, y sin esto el segundo `npm run migrate` fallaría.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ordenes_tipo_servicio_arl') THEN
    ALTER TABLE sst.ordenes_servicio ADD CONSTRAINT chk_ordenes_tipo_servicio_arl
      CHECK (tipo_servicio_arl IS NULL OR tipo_servicio_arl IN ('A','T','C','E','M','O'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ordenes_modalidad_ejecucion') THEN
    ALTER TABLE sst.ordenes_servicio ADD CONSTRAINT chk_ordenes_modalidad_ejecucion
      CHECK (modalidad_ejecucion IS NULL OR modalidad_ejecucion IN ('PRESENCIAL','VIRTUAL'));
  END IF;
END $$;

-- ⭐ FOR · AGR y tema/actividad de Bolívar (revisiones del cliente, 27-sep-2026).
--
-- `asesor_gestion_riesgo` es el Asesor de Gestión del Riesgo de la ARL (casilla
-- 16 del AT-031). Lo trae el SIPAB en la columna "Nombre Asesor Gestion
-- Riesgos", que hasta ahora se descartaba, y el formato salía con la casilla en
-- blanco. Solo lo trae Bolívar: en AXA y Colmena queda NULL. En el BORRADOR no
-- lleva columna: viaja dentro de `metadatos_extraccion` (`CAMPOS_REVISION`),
-- como el tipo de actividad.
--
-- `tema_actividad` es el texto propio del tema o actividad, más largo que el
-- título del SIPAB, que en los AT-031 reales se escribía a mano en papel. Lo
-- teclea quien administra la orden; sale en "Temas desarrollados" del AT-031 y en
-- "Tema y/o actividad" del AT-028. Aplica a cualquier ARL, pero solo Bolívar
-- lo imprime.
--
-- ⚠️ Trampa 69: `vw_ordenes_expandidas` es `SELECT o.*` y congela la lista de
-- columnas al crearse. Más abajo se suelta y se recrea siempre, así que basta
-- con que estos ALTER queden ANTES de ella.
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS asesor_gestion_riesgo TEXT;
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS tema_actividad        TEXT;

-- 29-sep-2026 · Observaciones que el administrador escribe en la VISTA PREVIA de
-- los formatos, antes de enviarlos al profesional: `{ "<formato>": "texto" }`,
-- con la clave del formato de `formatos-arl.service.js` (at031, at028,
-- prestacionColmena, asistenciaColmena). Se guardan en la orden y no solo en el
-- PDF para que reprogramar o regenerar los formatos no las pierda.
ALTER TABLE sst.ordenes_servicio
  ADD COLUMN IF NOT EXISTS observaciones_formatos JSONB NOT NULL DEFAULT '{}'::jsonb;
-- Y las casillas que el formato deja abiertas, llenadas en esa misma vista previa:
-- `{ "<formato>": { "<campo del PDF>": "texto" } }`.
ALTER TABLE sst.ordenes_servicio
  ADD COLUMN IF NOT EXISTS campos_formatos JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ⭐ T0-07 · Estado ARL + n.º de prefactura (revisiones del cliente, 27-sep-2026).
--
-- Eje propio, independiente del ciclo operativo y del de cobro: dice si la ARL
-- APROBÓ en su plataforma los documentos de la orden. Esa aprobación es la
-- condición para facturar (`PATCH /orders/cobro` rechaza FACTURADA en una orden
-- PENDIENTE). Son DOS valores por decisión por defecto (Q-08 puede añadir más);
-- la lista está copiada en `orders.routes.js` y en `core/models.ts`: se tocan
-- los tres o ninguno.
--
-- `numero_prefactura` es el "código SIPAB" de Bolívar (160441…): una prefactura
-- agrupa varias órdenes, así que el mismo número se repite entre ellas. Solo
-- tiene sentido en Bolívar; las demás ARL lo dejan NULL.
DO $$ BEGIN
  CREATE TYPE sst.estado_arl AS ENUM ('PENDIENTE','APROBADO');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE sst.ordenes_servicio
  ADD COLUMN IF NOT EXISTS estado_arl sst.estado_arl NOT NULL DEFAULT 'PENDIENTE';
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS numero_prefactura TEXT;
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS estado_arl_en     TIMESTAMPTZ;
ALTER TABLE sst.ordenes_servicio
  ADD COLUMN IF NOT EXISTS estado_arl_por UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL;

-- Historial del eje, en el mismo espíritu que `historial_cobro_orden`. `origen`
-- distingue el cambio hecho a mano del que traiga la carga de la prefactura
-- (T0-09). Se escribe también cuando solo cambia el número de prefactura.
CREATE TABLE IF NOT EXISTS sst.historial_estado_arl (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  orden_id          UUID NOT NULL REFERENCES sst.ordenes_servicio(id) ON DELETE CASCADE,
  estado_anterior   sst.estado_arl,
  estado_nuevo      sst.estado_arl NOT NULL,
  numero_prefactura TEXT,
  usuario_id        UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL,
  origen            TEXT NOT NULL DEFAULT 'MANUAL' CHECK (origen IN ('MANUAL','PREFACTURA')),
  creado_en         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_historial_estado_arl ON sst.historial_estado_arl(orden_id, creado_en);

-- ⭐ SUP · QUÉ soportes tiene que entregar ESTA orden (ago-2026).
--
-- El portal pedía siempre las mismas tres casillas (acta, asistencia,
-- evidencias) a todas las órdenes. No es lo que exigen las ARL: una asesoría de
-- Bolívar no lleva registro fotográfico y una asistencia técnica sí lleva
-- informe de gestión. La lista sale de la misma regla que decide los formatos
-- (`services/entrega-arl.service.js`).
--
-- Se CONGELA al asignar, en vez de recalcularse cada vez que alguien abre el
-- portal: el profesional ya tiene el enlace en su correo, y cambiar una regla
-- mañana no puede alterar lo que se le pidió ayer. NULL = orden anterior al
-- cambio; el portal le sigue pidiendo las tres de siempre.
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS soportes_requeridos TEXT[];

-- ⭐ Viáticos de la orden (ago-2026, a pedido del cliente).
--
-- Algunas órdenes se ejecutan fuera de la ciudad y llevan un valor aparte de las
-- horas. Es OPCIONAL: NULL = la orden no lleva viáticos, que es el caso normal.
--
-- En Bolívar no hay que teclearlo: el propio SIPAB trae `Autoriza Viaticos` y
-- las columnas de valor, que hasta ahora se descartaban. En AXA y Colmena se
-- escribe a mano.
--
-- ⚠️ NO entra en `valor_cobro_total`, que es una columna GENERADA
-- (horas × valor_hora_cobro) y es lo que hace trazable la tarifa. Los viáticos
-- son un REEMBOLSO, no honorarios: van en su propia columna y se suman al final.
-- Mezclarlos dejaría un "valor hora" implícito que no es el que se pactó.
--
-- `viaticos_detalle` guarda el desglose tal como venía (transporte, alojamiento,
-- alimentación…). Es lo que permite justificar la cifra ante la ARL y ver de
-- dónde salió cuando alguien la discuta.
--
-- Desde ago-2026 la cifra NO se escribe a mano: se elige una categoría del
-- catálogo (`sst.tipos_viatico`) y de ella sale el valor. `viaticos_valor` es la
-- copia congelada en el momento de elegirla; `viaticos_tipo_id` dice cuál fue.
-- NULL en las dos = "No aplica", que es el caso de casi toda orden.
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS viaticos_valor       NUMERIC(14,2);
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS viaticos_detalle     JSONB;
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS viaticos_observacion TEXT;
ALTER TABLE sst.ordenes_servicio
  ADD COLUMN IF NOT EXISTS viaticos_tipo_id UUID REFERENCES sst.tipos_viatico(id);


-- ⭐ ASG · El profesional a cuyo NOMBRE salen los formatos (ago-2026).
--
-- Bolívar solo acepta profesionales registrados ante ella (ver
-- `sst.profesionales_arl`). Cuando la visita la ejecuta alguien sin registro, el
-- formato tiene que ir a nombre de un registrado, pero **todo lo demás sigue
-- siendo de quien ejecuta**: el correo, el enlace de soportes, la agenda, la
-- cuenta de cobro y la encuesta.
--
-- Por eso NO se invierte el significado de `profesional_asignado_id`, que sigue
-- siendo QUIEN EJECUTA: sobre esa columna están construidas la agenda, las
-- ocupaciones, `vw_horas_ejecutadas`, `vw_profesionales_desempeno`, la cuenta de
-- cobro, la encuesta, `/orders/mias` y la campanita. Darle otro sentido obligaría
-- a repasar todo eso y a equivocarse en algún sitio.
--
-- NULL = el caso normal: los formatos salen a nombre de quien ejecuta.
ALTER TABLE sst.ordenes_servicio
  ADD COLUMN IF NOT EXISTS profesional_formatos_id UUID REFERENCES sst.profesionales(id) ON DELETE SET NULL;

-- ⭐ Estado de FACTURACIÓN de la orden (ago-2026, petición 6 del cliente).
--
-- Es un EJE INDEPENDIENTE del ciclo operativo, no un estado más de
-- `sst.estado_orden`. Una OS FINALIZADA puede estar sin facturar o facturada;
-- meterlo en el mismo enum obligaría a un producto cartesiano de estados y a
-- rehacer la matriz de transiciones y el trigger de EST-06.
--
-- SON DOS, no cinco. Nació con cinco (NO FACTURADA → RADICADA → APROBADA →
-- FACTURADA → PAGADA) y el cliente los recortó el 23-ago-2026: de los otros tres
-- no lleva registro, y un estado que nadie mueve es un estado que miente. Si
-- alguna vez vuelven, se añaden con `ALTER TYPE ... ADD VALUE` y hay que tocar
-- también `ESTADOS_COBRO` en `orders.routes.js` y `ESTADOS_COBRO` en el
-- frontend (`core/models.ts`), que son las otras dos copias de esta lista.
--
-- No es la Cartera (RPT-06) que se retiró el 19-ago-2026: aquello era un REPORTE
-- con tres fechas sueltas que nadie llenaba; esto es un estado de la orden, con
-- su historial.
DO $$ BEGIN
  CREATE TYPE sst.estado_cobro AS ENUM ('NO FACTURADA','FACTURADA');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE sst.ordenes_servicio
  ADD COLUMN IF NOT EXISTS estado_cobro sst.estado_cobro NOT NULL DEFAULT 'NO FACTURADA';
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS cobro_numero_factura  TEXT;
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS cobro_observacion     TEXT;
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS cobro_actualizado_en  TIMESTAMPTZ;
ALTER TABLE sst.ordenes_servicio
  ADD COLUMN IF NOT EXISTS cobro_actualizado_por UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_ordenes_estado_cobro ON sst.ordenes_servicio(estado_cobro);

-- Espejo de `historial_estados_orden` para el eje de cobro. La pregunta que el
-- cliente va a hacer es «¿quién marcó esto como radicado y cuándo?», y una fecha
-- suelta en la orden no la responde: solo dice cuándo fue el ÚLTIMO cambio.
CREATE TABLE IF NOT EXISTS sst.historial_cobro_orden (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  orden_id        UUID NOT NULL REFERENCES sst.ordenes_servicio(id) ON DELETE CASCADE,
  estado_anterior sst.estado_cobro,
  estado_nuevo    sst.estado_cobro NOT NULL,
  numero_factura  TEXT,
  observacion     TEXT,
  cambiado_por    UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL,
  cambiado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_historial_cobro_orden ON sst.historial_cobro_orden(orden_id, cambiado_en);

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

-- El borrador arrastra el tipo elegido en la vista previa de Importar, para que
-- la OS nazca con él. Se guarda en columna y no en el JSON de la extracción: no
-- lo dice el documento de la ARL, lo decide quien revisa.
ALTER TABLE sst.borradores_extraccion ADD COLUMN IF NOT EXISTS tipo_orden_id UUID REFERENCES sst.tipos_orden(id);
-- Y la categoría del viático, por lo mismo: se elige en la vista previa y la OS
-- nace con ella. NULL = "No aplica" (la inmensa mayoría de las órdenes).
ALTER TABLE sst.borradores_extraccion ADD COLUMN IF NOT EXISTS tipo_viatico_id UUID REFERENCES sst.tipos_viatico(id);

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
-- los reportes, el periodo de la cuenta de cobro y el orden del listado)
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

-- 7-oct-2026 · De QUIÉN es la franja. Con varios asesores en la orden cada uno
-- tiene su horario (que puede coincidir con el de los demás o no) y sus formatos
-- salen con sus fechas y horas. NULL = del asesor principal de la orden, que es
-- el caso de siempre y lo que tienen todas las franjas anteriores.
ALTER TABLE sst.franjas_visita
  ADD COLUMN IF NOT EXISTS profesional_id UUID REFERENCES sst.profesionales(id);
CREATE INDEX IF NOT EXISTS idx_franjas_visita_profesional ON sst.franjas_visita(profesional_id);

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

-- 7-oct-2026 · Soportes POR ASESOR.
--
-- Petición de JD&D: cuando una orden la ejecutan varios asesores, TODOS suben sus
-- soportes (antes solo el principal tenía enlace). Cada asesor adicional recibe
-- su propio enlace público y la orden pasa a EJECUTADA cuando no falta ninguno.
--
--   enlaces_publicos.profesional_id  de quién es el enlace (NULL = del principal)
--   enlaces_publicos.rechazados      qué se le devolvió a ESE asesor adicional
--                                    (lo del principal sigue en la orden)
--   enlaces_publicos.entregado_en    cuándo envió lo suyo
--   archivos_soporte.profesional_id  quién subió el archivo (NULL = el principal)
ALTER TABLE sst.enlaces_publicos
  ADD COLUMN IF NOT EXISTS profesional_id UUID REFERENCES sst.profesionales(id),
  ADD COLUMN IF NOT EXISTS rechazados     TEXT[],
  ADD COLUMN IF NOT EXISTS entregado_en   TIMESTAMPTZ;
ALTER TABLE sst.archivos_soporte
  ADD COLUMN IF NOT EXISTS profesional_id UUID REFERENCES sst.profesionales(id);
CREATE INDEX IF NOT EXISTS idx_enlaces_publicos_profesional ON sst.enlaces_publicos(orden_id, profesional_id);

-- Las órdenes que YA entregaron (EJECUTADA o FINALIZADA) quedan con su enlace
-- marcado como entregado: sin esto, un rechazo posterior las trataría como si
-- el profesional nunca hubiera enviado nada.
UPDATE sst.enlaces_publicos e
   SET entregado_en = COALESCE(
         (SELECT max(s.subido_en) FROM sst.archivos_soporte s WHERE s.orden_id = e.orden_id), now())
  FROM sst.ordenes_servicio o
 WHERE o.id = e.orden_id AND e.entregado_en IS NULL
   AND o.estado::text IN ('EJECUTADA', 'FINALIZADA');

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

-- RPT-06 · Cartera: RETIRADA (19-ago-2026, a pedido del cliente).
--
-- Era la pestaña que marcaba a mano si una OS ejecutada estaba facturada y
-- validada por la ARL. Se elimina entera —pestaña, endpoints, vista y las tres
-- columnas—; ninguna llegó a tener datos. Las bajadas se dejan escritas para que
-- `npm run migrate` limpie también las bases que ya existían.
DROP VIEW IF EXISTS sst.vw_cartera;
-- `vw_ordenes_expandidas` es `SELECT o.*`, así que también depende de estas
-- columnas. Se suelta aquí y se vuelve a crear más abajo, ya sin ellas.
DROP VIEW IF EXISTS sst.vw_ordenes_expandidas CASCADE;
DROP INDEX IF EXISTS sst.idx_ordenes_cartera;
ALTER TABLE sst.ordenes_servicio DROP COLUMN IF EXISTS facturado_en;
ALTER TABLE sst.ordenes_servicio DROP COLUMN IF EXISTS validado_arl_en;
ALTER TABLE sst.ordenes_servicio DROP COLUMN IF EXISTS cartera_marcada_por;

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

-- ⭐ T0-10 · La tarifa apunta al TIPO DE ORDEN por id (27-sep-2026).
--
-- Antes se casaba `lower(actividad) = lower(tipo.nombre)`: texto libre contra
-- texto libre. "Capacitacion" (sin tilde), un doble espacio o un tipo renombrado
-- en el catálogo no casaban nunca, y la orden caía al valor del tipo —el
-- "estándar"— sin que nadie lo notara: la cuenta de cobro salía con el valor
-- equivocado y parecía correcta.
--
-- `actividad` se conserva como texto (historial y filas sin tipo), pero la
-- búsqueda es por `tipo_orden_id`. Las filas anteriores se enlazan por nombre
-- normalizado; las que no casen quedan en NULL —la pantalla las marca— y siguen
-- funcionando por el respaldo de nombre normalizado, no se pierden.
--
-- `sst.norm_texto` es LA ÚNICA normalización (minúsculas, sin tildes, espacios
-- colapsados y recortados): la usan la asignación, la cuenta de cobro y este
-- backfill, para que no vuelvan a haber tres copias que discrepen. Se escribe con
-- `translate` y no con la extensión `unaccent`, que no está en todos los
-- servidores.
CREATE OR REPLACE FUNCTION sst.norm_texto(t TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT btrim(regexp_replace(
    translate(lower(coalesce(t, '')), 'áéíóúüñ', 'aeiouun'), '\s+', ' ', 'g'))
$$;

ALTER TABLE sst.tarifas_actividad_profesional
  ADD COLUMN IF NOT EXISTS tipo_orden_id UUID REFERENCES sst.tipos_orden(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_tarifas_prof_tipo
  ON sst.tarifas_actividad_profesional(profesional_id, tipo_orden_id);

UPDATE sst.tarifas_actividad_profesional ta
   SET tipo_orden_id = t.id
  FROM sst.tipos_orden t
 WHERE ta.tipo_orden_id IS NULL
   AND sst.norm_texto(ta.actividad) = sst.norm_texto(t.nombre);

-- ⭐ T0-09 · Prefacturas de Bolívar, cargadas con IA (27-sep-2026).
--
-- Bolívar emite una prefactura POR PLAN (1 PECAT, 250 PECAT PYME, 170 PLAN MIA
-- P…) con un número propio y una fecha de corte; cada fila es una orden que le
-- tocó a esa prefactura, identificada por `(codigo_cronograma, secuencia)` —la
-- misma pareja que identifica la orden en `sst.ordenes_servicio` (Bolívar no usa
-- `numero_orden`). El PDF se extrae con IA (OpenAI) y se previsualiza antes de
-- aplicar: `sst.prefacturas` es el encabezado, `sst.prefactura_filas` el detalle.
--
-- `numero_prefactura` es ÚNICO: cargar el mismo PDF dos veces no duplica la
-- prefactura (se hace `ON CONFLICT` al aplicar), y las filas tienen su propio
-- único por `(prefactura_id, codigo_cronograma, secuencia)` por el mismo motivo.
-- `orden_id` queda NULL en las filas que no cruzaron con ninguna OS de Orbita
-- (la prefactura trae órdenes de OTROS proveedores además de JD&D — no todas
-- tienen por qué existir aquí).
CREATE TABLE IF NOT EXISTS sst.prefacturas (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  numero_prefactura TEXT NOT NULL,
  plan_codigo       TEXT,
  plan_descripcion  TEXT,
  fecha_corte       DATE,
  valor_total       NUMERIC(14,2),
  nombre_archivo    TEXT,
  cargada_por       UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL,
  cargada_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizada_en    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_prefacturas_numero ON sst.prefacturas(numero_prefactura);

CREATE TABLE IF NOT EXISTS sst.prefactura_filas (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prefactura_id      UUID NOT NULL REFERENCES sst.prefacturas(id) ON DELETE CASCADE,
  -- La orden de Orbita con la que cruzó, si existe. Se resuelve al previsualizar
  -- y se vuelve a resolver al aplicar (por si cambió algo entre medias).
  orden_id           UUID REFERENCES sst.ordenes_servicio(id) ON DELETE SET NULL,
  codigo_cronograma  TEXT NOT NULL,
  secuencia          TEXT NOT NULL,
  nit_empresa        TEXT,
  razon_social       TEXT,
  actividad_programa TEXT,
  valor_actividad    NUMERIC(14,2),
  alimentacion       NUMERIC(14,2) NOT NULL DEFAULT 0,
  alojamiento        NUMERIC(14,2) NOT NULL DEFAULT 0,
  transporte         NUMERIC(14,2) NOT NULL DEFAULT 0,
  material           NUMERIC(14,2) NOT NULL DEFAULT 0,
  tiempo_muerto      NUMERIC(14,2) NOT NULL DEFAULT 0,
  valor_a_facturar   NUMERIC(14,2),
  -- Si esta fila llegó a marcar la orden como APROBADA (quedó marcada y pasó las
  -- reglas al aplicar). Una fila sin aplicar puede volver a intentarse después.
  aplicada           BOOLEAN NOT NULL DEFAULT FALSE,
  creado_en          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_prefactura_filas_fila
  ON sst.prefactura_filas(prefactura_id, codigo_cronograma, secuencia);
CREATE INDEX IF NOT EXISTS idx_prefactura_filas_orden ON sst.prefactura_filas(orden_id);

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
-- PRE-01 · Puede haber MÁS DE UNA cuenta por profesional y mes.
--
-- Antes había un índice único (profesional_id, periodo) y con él una orden
-- finalizada tarde no tenía dónde ir: la cuenta del mes ya estaba cerrada y no
-- se podía emitir otra. Es el mismo caso de una factura: la aceptada no se
-- toca, se emite una complementaria. El índice se elimina y la vista numera las
-- cuentas del mes para poder decirlo en pantalla.
DROP INDEX IF EXISTS sst.uq_precuenta_prof_periodo;
CREATE INDEX IF NOT EXISTS idx_precuenta_prof_periodo
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

-- ⭐ Viáticos en la cuenta de cobro (ago-2026).
--
-- Van como línea APARTE de los honorarios, no sumados dentro de `monto`: el
-- profesional tiene que poder ver qué es pago por su trabajo y qué es reembolso
-- de un gasto, y la contadora los trata distinto. `monto` sigue siendo
-- horas × valor hora, exactamente como antes.
--
-- `precuentas.total_monto` SÍ los incluye: es lo que se le paga en total, que es
-- lo que el documento anuncia y lo que el profesional acepta. Las cuentas
-- anteriores quedan con 0 y su total no cambia.
ALTER TABLE sst.precuenta_items ADD COLUMN IF NOT EXISTS viaticos       NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE sst.precuentas      ADD COLUMN IF NOT EXISTS total_viaticos NUMERIC(14,2) NOT NULL DEFAULT 0;
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
-- ⚠️ Se crea AL FINAL del archivo (bloque A3-01): desde las órdenes particulares
-- cruza con `sst.terceros`, que se define más abajo, en el bloque de la Fase A.

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
  -- arriba porque lo usan los porcentajes por ARL.
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
           AND (ta.tipo_orden_id = tp.id
                OR (ta.tipo_orden_id IS NULL AND sst.norm_texto(ta.actividad) = sst.norm_texto(tp.nombre)))
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
-- 5-oct-2026 · Asesores ADICIONALES de una orden (varios asesores, mismas fechas).
--
-- Una orden de 8 h la pueden ejecutar dos asesores a la vez: van el mismo día y
-- a la misma hora, y cada uno cobra SUS horas (4 y 4). `profesional_asignado_id`
-- sigue siendo el asesor PRINCIPAL: de él son el enlace de soportes, la encuesta
-- y la firma de los formatos. Aquí van los demás, con las horas que se le
-- reconocen a cada uno y su valor hora congelado al asignar (igual que
-- `ordenes_servicio.valor_hora_cobro`).
--
-- Las horas del principal NO se guardan: son `horas_asignadas` menos la suma de
-- estas filas. Así una orden sin filas aquí se comporta exactamente como antes.
CREATE TABLE IF NOT EXISTS sst.orden_coasesores (
  orden_id          UUID NOT NULL REFERENCES sst.ordenes_servicio(id) ON DELETE CASCADE,
  profesional_id    UUID NOT NULL REFERENCES sst.profesionales(id),
  horas             NUMERIC(8,2) NOT NULL CHECK (horas > 0),
  valor_hora_cobro  NUMERIC(12,2),
  valor_hora_origen TEXT,
  creado_por        UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL,
  creado_en         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (orden_id, profesional_id)
);
CREATE INDEX IF NOT EXISTS idx_orden_coasesores_prof ON sst.orden_coasesores(profesional_id);

DROP VIEW IF EXISTS sst.vw_horas_ejecutadas CASCADE;
CREATE VIEW sst.vw_horas_ejecutadas AS
-- El asesor PRINCIPAL: las horas de la orden menos las de sus coasesores.
SELECT o.id                     AS orden_id,
       o.codigo                 AS orden_codigo,
       o.profesional_asignado_id AS profesional_id,
       p.nombre                 AS profesional_nombre,
       o.empresa_nombre,
       -- A3-01 · La orden particular no tiene ARL; la cuenta de cobro la enseña
       -- como tal en vez de dejar la casilla vacía.
       COALESCE(a.nombre, 'PARTICULAR') AS arl_nombre,
       o.tipo_actividad,
       o.actividad_economica,
       GREATEST(COALESCE(o.horas_asignadas, 0) - COALESCE(co.horas, 0), 0) AS horas,
       -- PRE-02 · Lo que se le paga por esta orden, congelado al asignarla. La
       -- cuenta de cobro lee esto y no el catálogo: cambiar el valor hora de un
       -- tipo no puede reescribir lo ya trabajado.
       o.tipo_orden_id,
       tp.nombre           AS tipo_orden,
       o.valor_hora_cobro,
       o.valor_hora_origen,
       -- Con coasesores ya no vale la columna generada de la orden (horas
       -- TOTALES × valor hora): al principal se le pagan solo las suyas.
       CASE WHEN co.horas IS NULL THEN o.valor_cobro_total
            ELSE round(GREATEST(COALESCE(o.horas_asignadas, 0) - co.horas, 0) * o.valor_hora_cobro, 2)
       END                 AS valor_cobro_total,
       -- Los viáticos viajan con las horas: la cuenta de cobro los cobra en la
       -- misma fila, como una línea aparte del mismo trabajo.
       o.viaticos_valor,
       COALESCE(o.fecha_ejecucion, o.fecha_programada, o.actualizado_en)::date AS fecha_ejecucion,
       to_char(COALESCE(o.fecha_ejecucion, o.fecha_programada, o.actualizado_en), 'YYYY-MM') AS periodo,
       o.soportes_aceptados_en
FROM sst.ordenes_servicio o
LEFT JOIN sst.arls a          ON a.id = o.arl_id
LEFT JOIN sst.profesionales p ON p.id = o.profesional_asignado_id
LEFT JOIN sst.tipos_orden tp  ON tp.id = o.tipo_orden_id
LEFT JOIN (SELECT orden_id, sum(horas) AS horas FROM sst.orden_coasesores GROUP BY orden_id) co
       ON co.orden_id = o.id
WHERE o.estado IN ('EJECUTADA','FINALIZADA') AND o.profesional_asignado_id IS NOT NULL
UNION ALL
-- Cada COASESOR: sus horas y su propio valor hora. Los viáticos de la orden son
-- del principal, así que aquí van en NULL (no se pagan dos veces).
SELECT o.id,
       o.codigo,
       c.profesional_id,
       p.nombre,
       o.empresa_nombre,
       COALESCE(a.nombre, 'PARTICULAR'),
       o.tipo_actividad,
       o.actividad_economica,
       c.horas,
       o.tipo_orden_id,
       tp.nombre,
       c.valor_hora_cobro,
       c.valor_hora_origen,
       round(c.horas * c.valor_hora_cobro, 2),
       NULL::numeric,
       COALESCE(o.fecha_ejecucion, o.fecha_programada, o.actualizado_en)::date,
       to_char(COALESCE(o.fecha_ejecucion, o.fecha_programada, o.actualizado_en), 'YYYY-MM'),
       o.soportes_aceptados_en
FROM sst.orden_coasesores c
JOIN sst.ordenes_servicio o   ON o.id = c.orden_id
JOIN sst.profesionales p      ON p.id = c.profesional_id
LEFT JOIN sst.arls a          ON a.id = o.arl_id
LEFT JOIN sst.tipos_orden tp  ON tp.id = o.tipo_orden_id
WHERE o.estado IN ('EJECUTADA','FINALIZADA') AND o.profesional_asignado_id IS NOT NULL;

-- ⭐ PRE-01 · Lo que de verdad está PENDIENTE de cobrar por un profesional.
--
-- Es `vw_horas_ejecutadas` más DOS condiciones:
--
--  1. los soportes tienen que estar aceptados. Que la OS esté EJECUTADA
--     significa que el profesional subió los archivos; que se le pueda pagar
--     significa que un administrador los revisó y los dio por buenos;
--  2. la orden no puede estar ya dentro de una cuenta de cobro. Sin esto, una
--     orden facturada seguía apareciendo como pendiente para siempre, y —peor—
--     el trabajo que se finalizaba DESPUÉS de cerrar la cuenta del mes quedaba
--     absorbido por la fila de esa cuenta y no se veía en ninguna parte.
--
-- Va en una vista aparte y no como filtro de `vw_horas_ejecutadas` a propósito:
-- los informes de horas (RPT-05) miden trabajo EJECUTADO, y colarles aquí la
-- facturación les cambiaría la cifra sin que nadie lo pidiera.
DROP VIEW IF EXISTS sst.vw_horas_por_cobrar;
CREATE VIEW sst.vw_horas_por_cobrar AS
SELECT h.* FROM sst.vw_horas_ejecutadas h
 WHERE h.soportes_aceptados_en IS NOT NULL
   -- 5-oct-2026 · "Ya cobrada" se mira POR PROFESIONAL: con coasesores la misma
   -- orden entra en la cuenta de cada uno, y que uno ya la tenga en la suya no
   -- puede dar por cobradas las horas del otro.
   AND NOT EXISTS (
     SELECT 1 FROM sst.precuenta_items i
       JOIN sst.precuentas pc ON pc.id = i.precuenta_id
      WHERE i.orden_id = h.orden_id AND pc.profesional_id = h.profesional_id);

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
       COALESCE(a.nombre, 'PARTICULAR') AS arl_nombre,
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
LEFT JOIN sst.arls a          ON a.id = o.arl_id
LEFT JOIN sst.profesionales p ON p.id = o.profesional_asignado_id
WHERE o.estado NOT IN ('EJECUTADA', 'FINALIZADA', 'CANCELADA');

-- PRE-08 · Pre-cuentas con los datos del profesional ya resueltos.
DROP VIEW IF EXISTS sst.vw_precuentas;
CREATE VIEW sst.vw_precuentas AS
SELECT pc.*,
       p.nombre  AS profesional_nombre,
       p.correo  AS profesional_correo,
       -- Cuál es dentro de su mes: la 2 en adelante son complementarias
       -- (trabajo que se finalizó después de cerrar la primera).
       row_number() OVER (PARTITION BY pc.profesional_id, pc.periodo ORDER BY pc.creado_en)::int AS numero,
       count(*)    OVER (PARTITION BY pc.profesional_id, pc.periodo)::int                        AS del_mes,
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

-- =============================================================================
-- Fase A · facturación
-- =============================================================================
-- Todo lo de la Fase A vive en este bloque, al final del archivo (a propósito: otra
-- rama edita el mismo schema.sql y así los cambios se juntan a mano sin conflictos).
-- Cada tabla nueva tiene además su migración fechada en db/migraciones/.

-- A0-04 · Catálogos DIAN (migración 2026-09-27-catalogos-dian.sql)
-- `factus_id` guarda lo que Factus espera recibir para ese registro. En la API
-- v2 (la única a la que tiene acceso la cuenta) no hay ids propios: se identifica
-- todo por el CÓDIGO (`municipality_code`, `unit_measure_code`,
-- `payment_method_code`…), así que ahí va ese código. La columna se conserva
-- separada de `codigo_dian` para no reescribir nada si un día Factus cambia.
CREATE TABLE IF NOT EXISTS sst.paises (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo_dian   TEXT NOT NULL UNIQUE,          -- ISO 3166 alfa-2 ('CO')
  nombre        TEXT NOT NULL,
  factus_id     TEXT,
  activo        BOOLEAN NOT NULL DEFAULT true,
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sst.departamentos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo_dian   TEXT NOT NULL UNIQUE,          -- DANE, 2 dígitos ('52')
  nombre        TEXT NOT NULL,
  factus_id     TEXT,
  activo        BOOLEAN NOT NULL DEFAULT true,
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sst.municipios (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo_dian     TEXT NOT NULL UNIQUE,        -- DANE, 5 dígitos ('52001' Pasto)
  nombre          TEXT NOT NULL,
  departamento_id UUID NOT NULL REFERENCES sst.departamentos(id),
  factus_id       TEXT,
  activo          BOOLEAN NOT NULL DEFAULT true,
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_municipios_departamento ON sst.municipios (departamento_id);

CREATE TABLE IF NOT EXISTS sst.formas_pago (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo_dian   TEXT NOT NULL UNIQUE,          -- '1' contado, '2' crédito
  nombre        TEXT NOT NULL,
  factus_id     TEXT,
  activo        BOOLEAN NOT NULL DEFAULT true,
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sst.medios_pago (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo_dian   TEXT NOT NULL UNIQUE,          -- '10' efectivo, '48' tarjeta crédito, 'ZZZ' otro…
  nombre        TEXT NOT NULL,
  factus_id     TEXT,
  activo        BOOLEAN NOT NULL DEFAULT true,
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sst.tipos_documento_identidad (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo_dian   TEXT NOT NULL UNIQUE,          -- '13' cédula, '31' NIT…
  nombre        TEXT NOT NULL,
  factus_id     TEXT,
  activo        BOOLEAN NOT NULL DEFAULT true,
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sst.unidades_medida (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo_dian   TEXT NOT NULL UNIQUE,          -- '94' unidad, 'HUR' hora, 'LUN' mes…
  nombre        TEXT NOT NULL,
  factus_id     TEXT,
  activo        BOOLEAN NOT NULL DEFAULT true,
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tributos: los impuestos que van en la línea ('01' IVA, '04' INC, '35') y el
-- 'ZZ' "No aplica" del cliente. Las retenciones ('05', '06') NO están aquí: son
-- la tabla editable de A0-07.
CREATE TABLE IF NOT EXISTS sst.tributos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo_dian   TEXT NOT NULL UNIQUE,
  nombre        TEXT NOT NULL,
  factus_id     TEXT,
  activo        BOOLEAN NOT NULL DEFAULT true,
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A0-05 · Terceros (migración 2026-09-27-terceros.sql)
-- Catálogo de responsabilidades fiscales que Factus v2 acepta en el cliente
-- (`customer.responsibilities`: O-13, O-15, O-23, O-47, R-99-PN). Mismo molde que
-- los catálogos de A0-04; se llena con scripts/sembrar-catalogos-dian.mjs.
CREATE TABLE IF NOT EXISTS sst.responsabilidades_fiscales (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo_dian   TEXT NOT NULL UNIQUE,
  nombre        TEXT NOT NULL,
  factus_id     TEXT,
  activo        BOOLEAN NOT NULL DEFAULT true,
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A0-05 · Terceros (PAR-03): a quién se FACTURA o se PAGA. No sustituye a
-- `empresas` (dónde se EJECUTA el servicio) ni a `profesionales`: se enlaza con
-- ellas por `tercero_id` y no se fusionan.
--
-- Los booleanos de rol NO son excluyentes: una ARL es cliente Y ARL, y
-- un asesor puede ser proveedor (documento soporte) y empleado.
CREATE TABLE IF NOT EXISTS sst.terceros (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo_persona       TEXT NOT NULL CHECK (tipo_persona IN ('NATURAL', 'JURIDICA')),
  tipo_documento_id  UUID NOT NULL REFERENCES sst.tipos_documento_identidad(id),
  -- Sin puntos ni guion ni DV. Alfanumérico solo porque el pasaporte y el
  -- documento extranjero pueden traer letras; la API exige dígitos para el resto.
  numero_documento   TEXT NOT NULL CHECK (numero_documento ~ '^[0-9A-Z]+$'),
  -- Solo para NIT: se calcula al guardar, nunca lo teclea nadie.
  dv                 SMALLINT CHECK (dv BETWEEN 0 AND 9),
  razon_social       TEXT,
  nombres            TEXT,
  apellidos          TEXT,
  nombre_comercial   TEXT,
  direccion          TEXT,
  municipio_id       UUID REFERENCES sst.municipios(id),
  telefono           TEXT,
  correo_facturacion TEXT,
  -- Códigos de responsabilidad fiscal tal como los pide Factus (O-13, R-99-PN…);
  -- vacío = Factus asume R-99-PN. Se validan contra sst.responsabilidades_fiscales.
  responsabilidades_fiscales TEXT[] NOT NULL DEFAULT '{}',
  regimen            TEXT NOT NULL DEFAULT 'RESPONSABLE_IVA'
                       CHECK (regimen IN ('RESPONSABLE_IVA', 'NO_RESPONSABLE')),
  es_cliente         BOOLEAN NOT NULL DEFAULT false,
  es_proveedor       BOOLEAN NOT NULL DEFAULT false,
  es_empleado        BOOLEAN NOT NULL DEFAULT false,
  es_arl             BOOLEAN NOT NULL DEFAULT false,
  -- 8-oct-2026 · Sustituye a «ARL» en el formulario (migración 2026-10-08-tercero-acreedor.sql).
  es_acreedor        BOOLEAN NOT NULL DEFAULT false,
  activo             BOOLEAN NOT NULL DEFAULT true,
  creado_por         UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL,
  actualizado_por    UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL,
  creado_en          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Una persona jurídica se llama por su razón social; una natural, por sus nombres.
  CONSTRAINT terceros_nombre_segun_persona CHECK (
    (tipo_persona = 'JURIDICA' AND razon_social IS NOT NULL)
    OR (tipo_persona = 'NATURAL' AND nombres IS NOT NULL)
  )
);
-- El mismo documento no puede ser dos terceros (ni siquiera con otro DV escrito).
CREATE UNIQUE INDEX IF NOT EXISTS uq_terceros_documento
  ON sst.terceros (tipo_documento_id, numero_documento);
CREATE INDEX IF NOT EXISTS idx_terceros_municipio ON sst.terceros (municipio_id);
CREATE INDEX IF NOT EXISTS idx_terceros_activo    ON sst.terceros (activo);

DO $$ BEGIN
  CREATE TRIGGER trg_terceros_tocar BEFORE UPDATE ON sst.terceros
    FOR EACH ROW EXECUTE FUNCTION sst.fn_tocar_actualizado_en();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Enlaces: ON DELETE SET NULL porque borrar un tercero no debe borrar la ARL,
-- la empresa ni el profesional; solo los deja sin enlace.
ALTER TABLE sst.arls          ADD COLUMN IF NOT EXISTS tercero_id UUID REFERENCES sst.terceros(id) ON DELETE SET NULL;
ALTER TABLE sst.empresas      ADD COLUMN IF NOT EXISTS tercero_id UUID REFERENCES sst.terceros(id) ON DELETE SET NULL;
ALTER TABLE sst.profesionales ADD COLUMN IF NOT EXISTS tercero_id UUID REFERENCES sst.terceros(id) ON DELETE SET NULL;

-- La vista `terceros` del sidebar: admin y contador operan, el auditor consulta,
-- el administrativo no ve lo contable (§5.3 del plan). ON CONFLICT para no pisar
-- lo que el Administrador Maestro ya haya ajustado desde Roles y permisos.
INSERT INTO sst.permisos_rol (rol, vista, permitido) VALUES
  ('admin',          'terceros', TRUE),
  ('contador',       'terceros', TRUE),
  ('auditor',        'terceros', TRUE),
  ('administrativo', 'terceros', FALSE)
ON CONFLICT (rol, vista) DO NOTHING;

-- A0-09 · Ficha del emisor (migración 2026-09-27-emisor.sql)
-- Una sola fila: `CHECK (id = 1)` hace imposible tener dos emisores.
CREATE TABLE IF NOT EXISTS sst.emisor (
  id              SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  tipo_persona    TEXT NOT NULL DEFAULT 'JURIDICA' CHECK (tipo_persona IN ('NATURAL', 'JURIDICA')),
  nit             TEXT NOT NULL CHECK (nit ~ '^[0-9]+$'),
  dv              SMALLINT NOT NULL CHECK (dv BETWEEN 0 AND 9),  -- calculado, nunca tecleado
  razon_social    TEXT NOT NULL,
  nombre_comercial TEXT,
  direccion       TEXT NOT NULL,
  municipio_id    UUID NOT NULL REFERENCES sst.municipios(id),
  correo          TEXT NOT NULL,
  telefono        TEXT,
  ciiu_principal  TEXT CHECK (ciiu_principal ~ '^[0-9]{4}$'),
  ciiu_secundarias TEXT[] NOT NULL DEFAULT '{}',
  -- Códigos de responsabilidad del RUT (05, 07, 14, 42, 48, 52, 55…): son los
  -- numéricos del formulario del RUT, no los O-xx que Factus pide para el cliente.
  responsabilidades_rut TEXT[] NOT NULL DEFAULT '{}',
  -- Ambiente en el que JD&D declara estar facturando. La URL del proveedor sale
  -- de .env; esto es lo que la pantalla contrasta con ella para avisar de una
  -- incoherencia (p. ej. PRODUCCION apuntando al sandbox).
  ambiente        TEXT NOT NULL DEFAULT 'PRUEBAS' CHECK (ambiente IN ('PRUEBAS', 'PRODUCCION')),
  -- FEL-14 · Vigencia del paquete del proveedor (genera alertas a 30 y 7 días).
  paquete_proveedor_vence DATE,
  -- Cuándo se le enviaron al proveedor los documentos para el certificado de
  -- firma. Solo informativo: Orbita no custodia certificado ni llave.
  documentos_certificado_enviados_en DATE,
  actualizado_por UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL,
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A0-08 · Resoluciones de numeración (migración 2026-09-27-resoluciones-numeracion.sql)
CREATE TABLE IF NOT EXISTS sst.resoluciones_numeracion (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo_documento    TEXT NOT NULL
                      CHECK (tipo_documento IN ('FACTURA', 'NOTA_CREDITO', 'DOC_SOPORTE', 'NOTA_AJUSTE_DS', 'NOMINA')),
  prefijo           TEXT,
  -- Sin tope (NULL) es lo que Factus devuelve para los rangos de notas del sandbox.
  desde             BIGINT,
  hasta             BIGINT,
  -- `current` tal como lo informa el proveedor. Factus no aclara si es el último
  -- usado o el siguiente: para las alertas de "quedan pocos números" da igual (±1).
  consecutivo_actual BIGINT NOT NULL DEFAULT 0,
  numero_resolucion TEXT,
  fecha_desde       DATE,
  fecha_hasta       DATE,
  -- id del rango en Factus; NULL si algún día se cargara una resolución a mano.
  factus_rango_id   BIGINT UNIQUE,
  activa            BOOLEAN NOT NULL DEFAULT true,
  sincronizada_en   TIMESTAMPTZ,
  creado_en         TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (desde IS NULL OR hasta IS NULL OR desde <= hasta)
);
CREATE INDEX IF NOT EXISTS idx_resoluciones_tipo ON sst.resoluciones_numeracion (tipo_documento, activa);

DO $$ BEGIN
  CREATE TRIGGER trg_resoluciones_tocar BEFORE UPDATE ON sst.resoluciones_numeracion
    FOR EACH ROW EXECUTE FUNCTION sst.fn_tocar_actualizado_en();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A0-06 · Productos y tarifas de venta (migración 2026-09-27-productos-tarifas.sql)
DO $$ BEGIN
  CREATE TYPE sst.tratamiento_iva AS ENUM ('GRAVADO', 'EXENTO', 'EXCLUIDO');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Servicios que se facturan. El código es texto libre (Siigo usa "1" y "2") para
-- poder seguir con la misma numeración que ya conoce la contadora.
CREATE TABLE IF NOT EXISTS sst.productos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo          TEXT NOT NULL,
  nombre          TEXT NOT NULL,
  tratamiento_iva sst.tratamiento_iva NOT NULL DEFAULT 'EXENTO',
  -- Solo tiene sentido si tratamiento_iva = GRAVADO; se guarda igual para no
  -- perderla si el día de mañana cambia el tratamiento.
  tarifa_iva      NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (tarifa_iva >= 0),
  unidad_medida_id UUID REFERENCES sst.unidades_medida(id),
  tributo_id      UUID REFERENCES sst.tributos(id),
  activo          BOOLEAN NOT NULL DEFAULT true,
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_productos_codigo ON sst.productos (codigo);

-- Precio de venta por pagador (ARL o privado) y, opcionalmente, por tipo de
-- orden. `tipo_orden_id NULL` = "cualquiera": sirve de tarifa por defecto del
-- pagador cuando no hay una más específica.
CREATE TABLE IF NOT EXISTS sst.tarifas_venta (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pagador_tercero_id UUID NOT NULL REFERENCES sst.terceros(id),
  tipo_orden_id     UUID REFERENCES sst.tipos_orden(id),
  unidad            TEXT NOT NULL CHECK (unidad IN ('HORA', 'UNIDAD')),
  valor             NUMERIC(14,2) NOT NULL CHECK (valor >= 0),
  vigente_desde     DATE NOT NULL DEFAULT CURRENT_DATE,
  activo            BOOLEAN NOT NULL DEFAULT true,
  creado_en         TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tarifas_venta_pagador ON sst.tarifas_venta (pagador_tercero_id, tipo_orden_id, vigente_desde DESC);
-- Dos tarifas vigentes desde el MISMO día para el mismo pagador+tipo+UNIDAD
-- serían ambiguas (¿cuál manda?); vigencias en fechas distintas sí conviven
-- (histórico). La unidad SÍ entra en la clave: Bolívar cobra a la vez por hora
-- y por unidad (investigación de accidente) para el mismo pagador y tipo de
-- orden, y sin `unidad` aquí la segunda tarifa chocaba con la primera.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tarifas_venta_vigencia
  ON sst.tarifas_venta (pagador_tercero_id, COALESCE(tipo_orden_id, '00000000-0000-0000-0000-000000000000'), unidad, vigente_desde);

DO $$ BEGIN
  CREATE TRIGGER trg_productos_tocar BEFORE UPDATE ON sst.productos
    FOR EACH ROW EXECUTE FUNCTION sst.fn_tocar_actualizado_en();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER trg_tarifas_venta_tocar BEFORE UPDATE ON sst.tarifas_venta
    FOR EACH ROW EXECUTE FUNCTION sst.fn_tocar_actualizado_en();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A0-07 · Retenciones, UVT y condiciones por pagador (migración 2026-09-27-retenciones-condiciones.sql)
DO $$ BEGIN
  CREATE TYPE sst.tipo_retencion AS ENUM ('RETEFUENTE', 'RETEICA', 'RETEIVA', 'AUTORRETENCION');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- La contadora la actualiza cada enero; sirve de base mínima en UVT de algunas
-- retenciones (p. ej. la base mínima de retefuente por honorarios).
CREATE TABLE IF NOT EXISTS sst.uvt (
  anio  SMALLINT PRIMARY KEY CHECK (anio BETWEEN 2000 AND 2100),
  valor NUMERIC(10,2) NOT NULL CHECK (valor > 0)
);

CREATE TABLE IF NOT EXISTS sst.retenciones (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo           TEXT NOT NULL,
  nombre           TEXT NOT NULL,
  tipo             sst.tipo_retencion NOT NULL,
  -- Admite decimales finos (1,1 % de autorretención; 5 ‰ = 0,5 de ReteICA).
  tarifa           NUMERIC(6,3) NOT NULL CHECK (tarifa >= 0),
  base_minima_uvt  NUMERIC(10,2) NOT NULL DEFAULT 0,
  aplica_a         TEXT NOT NULL CHECK (aplica_a IN ('VENTA', 'COMPRA')),
  -- NULL en las que Factus no modela (ReteICA); ver la nota de cabecera.
  factus_tributo_id TEXT,
  activa           BOOLEAN NOT NULL DEFAULT true,
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_retenciones_codigo ON sst.retenciones (codigo);

-- Qué le aplica CADA pagador: en la factura (retenciones_ids) y al pagar (ReteICA).
CREATE TABLE IF NOT EXISTS sst.condiciones_pagador (
  tercero_id             UUID PRIMARY KEY REFERENCES sst.terceros(id) ON DELETE CASCADE,
  retenciones_ids        UUID[] NOT NULL DEFAULT '{}',
  -- La que ese pagador retiene AL PAGAR (no va en la factura); referencia una
  -- fila `tipo = 'RETEICA'` de sst.retenciones.
  reteica_pago_id        UUID REFERENCES sst.retenciones(id),
  descuento_comercial_pct NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (descuento_comercial_pct >= 0),
  plazo_dias             SMALLINT NOT NULL DEFAULT 0 CHECK (plazo_dias >= 0),
  -- Plantilla de la descripción de línea (A1-04 la interpola); NULL = usar la
  -- descripción genérica del producto.
  formato_descripcion    TEXT,
  actualizado_en         TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  CREATE TRIGGER trg_retenciones_tocar BEFORE UPDATE ON sst.retenciones
    FOR EACH ROW EXECUTE FUNCTION sst.fn_tocar_actualizado_en();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER trg_condiciones_pagador_tocar BEFORE UPDATE ON sst.condiciones_pagador
    FOR EACH ROW EXECUTE FUNCTION sst.fn_tocar_actualizado_en();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A0-10 · Permiso de la vista parametrizacion (migración 2026-09-27-parametrizacion-permiso.sql)
INSERT INTO sst.permisos_rol (rol, vista, permitido) VALUES
  ('admin',          'parametrizacion', TRUE),
  ('contador',       'parametrizacion', TRUE),
  ('auditor',        'parametrizacion', TRUE),
  ('administrativo', 'parametrizacion', FALSE)
ON CONFLICT (rol, vista) DO NOTHING;
-- 29-sep-2026 · A1-08: la pantalla de Facturación. Es una de las "llaves" del
-- sistema Finanzas (junto con terceros y parametrización): quien la tiene, entra
-- a Finanzas. Mismo reparto que las otras dos.
INSERT INTO sst.permisos_rol (rol, vista, permitido) VALUES
  ('admin',          'facturacion', TRUE),
  ('contador',       'facturacion', TRUE),
  ('auditor',        'facturacion', TRUE),
  ('administrativo', 'facturacion', FALSE)
ON CONFLICT (rol, vista) DO NOTHING;

-- A1-01 · Esquema de documentos electrónicos (migración 2026-09-27-documentos-electronicos.sql)
-- El documento electrónico: factura, nota crédito, documento soporte, nota de
-- ajuste o nómina. `tipo` y `estado` van como TEXT + CHECK (no ENUM de Postgres)
-- a propósito, igual que `resoluciones_numeracion.tipo_documento`: un ENUM exige
-- tocar tres sitios a la vez (trampa de "enumerados duplicados", §1.2 del plan) y
-- aquí conviene poder sumar un estado sin una migración de tipo.
CREATE TABLE IF NOT EXISTS sst.documentos_electronicos (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo               TEXT NOT NULL
                       CHECK (tipo IN ('FACTURA', 'NOTA_CREDITO', 'DOC_SOPORTE', 'NOTA_AJUSTE_DS', 'NOMINA')),
  resolucion_id      UUID REFERENCES sst.resoluciones_numeracion(id),
  prefijo            TEXT,
  -- Lo asigna Factus al validar; antes de eso queda NULL (BORRADOR/ENVIANDO).
  numero             TEXT,
  -- Generado por Orbita, único: ORB-<tipo>-<uuid corto>. Es la clave de
  -- idempotencia frente al proveedor (§5.1 punto 5): nunca se reintenta una
  -- emisión con el mismo reference_code, y "Consultar estado" reconcilia por él.
  reference_code     TEXT NOT NULL,
  estado             TEXT NOT NULL DEFAULT 'BORRADOR'
                       CHECK (estado IN ('BORRADOR', 'ENVIANDO', 'VALIDADO', 'RECHAZADO', 'ANULADO')),
  tercero_id         UUID NOT NULL REFERENCES sst.terceros(id),
  fecha_emision      DATE,
  fecha_vencimiento  DATE,
  forma_pago_id      UUID REFERENCES sst.formas_pago(id),
  medio_pago_id      UUID REFERENCES sst.medios_pago(id),
  observaciones      TEXT,
  -- Todos en pesos (NUMERIC(16,2), como manda el §1.3 del plan): nunca se suman
  -- como float, se calculan con sst_ws/src/modules/facturacion/calculo.js.
  total_bruto        NUMERIC(16,2) NOT NULL DEFAULT 0,
  total_descuento    NUMERIC(16,2) NOT NULL DEFAULT 0,
  subtotal           NUMERIC(16,2) NOT NULL DEFAULT 0,
  total_iva          NUMERIC(16,2) NOT NULL DEFAULT 0,
  total_retenciones  NUMERIC(16,2) NOT NULL DEFAULT 0,
  total_a_pagar      NUMERIC(16,2) NOT NULL DEFAULT 0,
  -- CUFE (factura/NC/DS) o CUDE (nómina); lo devuelve el proveedor al validar.
  cufe               TEXT,
  qr_url             TEXT,
  -- Rutas dentro del almacenamiento de Orbita (storage.service.js): el PDF y el
  -- XML se descargan del proveedor y se guardan aquí; sus términos no garantizan
  -- conservarlos si la cuenta se elimina algún día (nota del §5.4 del plan).
  pdf_path           TEXT,
  xml_path           TEXT,
  respuesta_proveedor JSONB,
  errores            JSONB,
  -- NC apunta a la factura que corrige; nota de ajuste, al documento soporte.
  documento_referencia_id UUID REFERENCES sst.documentos_electronicos(id),
  -- Código DIAN de corrección, solo en notas crédito (1 devolución parcial, 2
  -- anulación, 3 rebaja, 4 ajuste de precio, 5/6 descuento comercial).
  causal             TEXT,
  -- NULL hasta que la Fase B exista: sst.comprobantes se crea en B1-01. Sin FK
  -- todavía porque la tabla no existe aún; se añade la restricción cuando llegue.
  comprobante_id     UUID,
  -- Bolívar: de qué prefactura sale (sst.prefacturas nace en T0-09, en la rama
  -- de Tanda 0). Sin FK por lo mismo: la tabla no existe en esta rama todavía.
  prefactura_id      UUID,
  creado_por         UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL,
  actualizado_por    UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL,
  creado_en          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- El reference_code es la clave de idempotencia: nunca puede repetirse.
CREATE UNIQUE INDEX IF NOT EXISTS uq_documentos_electronicos_reference_code
  ON sst.documentos_electronicos (reference_code);
-- Un número solo es único DENTRO de su tipo+prefijo; se dejan fuera los NULL
-- (documentos que aún no se validaron: casi todos, en BORRADOR o ENVIANDO).
CREATE UNIQUE INDEX IF NOT EXISTS uq_documentos_electronicos_numero
  ON sst.documentos_electronicos (tipo, prefijo, numero) WHERE numero IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documentos_electronicos_tercero ON sst.documentos_electronicos (tercero_id);
CREATE INDEX IF NOT EXISTS idx_documentos_electronicos_estado ON sst.documentos_electronicos (tipo, estado);

DO $$ BEGIN
  CREATE TRIGGER trg_documentos_electronicos_tocar BEFORE UPDATE ON sst.documentos_electronicos
    FOR EACH ROW EXECUTE FUNCTION sst.fn_tocar_actualizado_en();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Una línea por orden (o por fila de prefactura en Bolívar; orden_id NULL en
-- ese caso, según A1-03).
CREATE TABLE IF NOT EXISTS sst.documento_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  documento_id   UUID NOT NULL REFERENCES sst.documentos_electronicos(id) ON DELETE CASCADE,
  orden_id       UUID REFERENCES sst.ordenes_servicio(id),
  producto_id    UUID REFERENCES sst.productos(id),
  codigo         TEXT,
  descripcion    TEXT NOT NULL,
  cantidad       NUMERIC(14,4) NOT NULL DEFAULT 1,
  valor_unitario NUMERIC(16,2) NOT NULL DEFAULT 0,
  descuento      NUMERIC(16,2) NOT NULL DEFAULT 0,
  base           NUMERIC(16,2) NOT NULL DEFAULT 0,
  total_linea    NUMERIC(16,2) NOT NULL DEFAULT 0,
  -- Solo lo usa el documento soporte, y solo desde B2-01 (contabilización): la
  -- cuenta de costo depende de la ARL de la orden, que B2 resuelve.
  cuenta_costo_id UUID,
  orden          SMALLINT NOT NULL DEFAULT 0,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_documento_items_documento ON sst.documento_items (documento_id, orden);
CREATE INDEX IF NOT EXISTS idx_documento_items_orden ON sst.documento_items (orden_id);

-- Impuestos y retenciones de CADA línea: una fila por tributo (IVA) o por
-- retención aplicada. retencion_id es NULL cuando la fila es el IVA del
-- producto (no hay "producto" en sst.retenciones); en ese caso tributo_codigo
-- lleva el código DIAN del impuesto (01 IVA, 04 INC…).
CREATE TABLE IF NOT EXISTS sst.documento_item_tributos (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id        UUID NOT NULL REFERENCES sst.documento_items(id) ON DELETE CASCADE,
  retencion_id   UUID REFERENCES sst.retenciones(id),
  tributo_codigo TEXT,
  base           NUMERIC(16,2) NOT NULL DEFAULT 0,
  tarifa         NUMERIC(6,3) NOT NULL DEFAULT 0,
  valor          NUMERIC(16,2) NOT NULL DEFAULT 0,
  CHECK (retencion_id IS NOT NULL OR tributo_codigo IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_documento_item_tributos_item ON sst.documento_item_tributos (item_id);

-- Línea de tiempo del documento: eventos internos (CREADO, ENVIADO…) y eventos
-- DIAN reenviados por Factus (030..034, ver el §5.4 del plan).
CREATE TABLE IF NOT EXISTS sst.documento_eventos (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  documento_id UUID NOT NULL REFERENCES sst.documentos_electronicos(id) ON DELETE CASCADE,
  codigo       TEXT NOT NULL,
  descripcion  TEXT,
  fecha        TIMESTAMPTZ NOT NULL DEFAULT now(),
  datos        JSONB,
  usuario_id   UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_documento_eventos_documento ON sst.documento_eventos (documento_id, fecha);

-- Qué órdenes cubre cada documento (N:M, aunque hoy casi siempre es 1:N).
CREATE TABLE IF NOT EXISTS sst.documento_ordenes (
  documento_id UUID NOT NULL REFERENCES sst.documentos_electronicos(id) ON DELETE CASCADE,
  orden_id     UUID NOT NULL REFERENCES sst.ordenes_servicio(id),
  PRIMARY KEY (documento_id, orden_id)
);
-- Una orden solo puede estar en UNA factura VALIDADO (no anulada) a la vez: sin
-- esto, dos facturas podrían cobrar la misma orden por error. Postgres no deja
-- un índice parcial que mire OTRA tabla, así que una columna generada a mano
-- guarda el id del documento SOLO cuando es esa factura validada, y el índice
-- único parcial se apoya en ella.
ALTER TABLE sst.documento_ordenes ADD COLUMN IF NOT EXISTS documento_validado_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS uq_documento_ordenes_validado
  ON sst.documento_ordenes (orden_id) WHERE documento_validado_id IS NOT NULL;

-- Se mantiene con DOS disparadores porque el hecho relevante ("esta factura se
-- validó") ocurre en `documentos_electronicos`, no en `documento_ordenes`: el
-- primero recalcula al insertar la relación (por si el documento YA está
-- validado, caso raro pero posible); el segundo recalcula TODAS las relaciones
-- de un documento cuando su tipo o estado cambian después de creada la relación
-- (el caso normal: la relación nace con el BORRADOR y el documento pasa a
-- VALIDADO más tarde, en A1-05).
CREATE OR REPLACE FUNCTION sst.fn_documento_ordenes_sincronizar_validado() RETURNS trigger AS $$
DECLARE
  v_tipo TEXT;
  v_estado TEXT;
BEGIN
  SELECT tipo, estado INTO v_tipo, v_estado FROM sst.documentos_electronicos WHERE id = NEW.documento_id;
  NEW.documento_validado_id := CASE WHEN v_tipo = 'FACTURA' AND v_estado = 'VALIDADO' THEN NEW.documento_id ELSE NULL END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER trg_documento_ordenes_validado BEFORE INSERT OR UPDATE ON sst.documento_ordenes
    FOR EACH ROW EXECUTE FUNCTION sst.fn_documento_ordenes_sincronizar_validado();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION sst.fn_documentos_electronicos_propagar_validado() RETURNS trigger AS $$
BEGIN
  -- El trigger ya solo dispara en INSERT o en UPDATE que toque `estado`
  -- (cláusula "OF estado" de abajo), así que aquí siempre toca propagar.
  UPDATE sst.documento_ordenes
     SET documento_validado_id = CASE WHEN NEW.tipo = 'FACTURA' AND NEW.estado = 'VALIDADO' THEN NEW.id ELSE NULL END
   WHERE documento_id = NEW.id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER trg_documentos_electronicos_propagar_validado
    AFTER INSERT OR UPDATE OF estado ON sst.documentos_electronicos
    FOR EACH ROW EXECUTE FUNCTION sst.fn_documentos_electronicos_propagar_validado();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A1-05 · el historial de cobro (M13, tanda 22-ago) enlaza con el documento
-- electrónico que disparó el cambio (NULL en el marcado manual, ver la
-- migración 2026-09-28-historial-cobro-documento.sql).
ALTER TABLE sst.historial_cobro_orden
  ADD COLUMN IF NOT EXISTS documento_id UUID REFERENCES sst.documentos_electronicos(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_historial_cobro_orden_documento ON sst.historial_cobro_orden(documento_id);

-- A3-01 · Órdenes manuales para clientes particulares (sin ARL). Una orden la
-- paga una ARL o un tercero particular, nunca los dos ni ninguno. La vista
-- Órdenes lista borradores, así que el borrador del alta manual también
-- guarda su pagador. Ver la migración 2026-09-29-ordenes-particulares.sql.
ALTER TABLE sst.ordenes_servicio ALTER COLUMN arl_id DROP NOT NULL;
ALTER TABLE sst.ordenes_servicio
  ADD COLUMN IF NOT EXISTS pagador_tercero_id UUID REFERENCES sst.terceros(id);
CREATE INDEX IF NOT EXISTS idx_ordenes_pagador
  ON sst.ordenes_servicio(pagador_tercero_id) WHERE pagador_tercero_id IS NOT NULL;
DO $$ BEGIN
  ALTER TABLE sst.ordenes_servicio ADD CONSTRAINT chk_ordenes_un_pagador
    CHECK ((arl_id IS NULL) <> (pagador_tercero_id IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE sst.borradores_extraccion
  ADD COLUMN IF NOT EXISTS pagador_tercero_id UUID REFERENCES sst.terceros(id);

-- B0-01 · Plan de cuentas (migración 2026-09-29-plan-de-cuentas.sql)
-- El nivel ES la longitud del código (clase 1, grupo 2, cuenta 4, subcuenta 6,
-- auxiliar 8+), como lo numera Siigo. Solo las auxiliares reciben asientos.
CREATE TABLE IF NOT EXISTS sst.cuentas_contables (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo             TEXT NOT NULL CHECK (codigo ~ '^[0-9]{1,10}$'),
  nombre             TEXT NOT NULL CHECK (btrim(nombre) <> ''),
  naturaleza         TEXT NOT NULL CHECK (naturaleza IN ('DEBITO', 'CREDITO')),
  nivel              SMALLINT GENERATED ALWAYS AS (length(codigo)) STORED,
  padre_id           UUID REFERENCES sst.cuentas_contables(id),
  acepta_movimiento  BOOLEAN NOT NULL DEFAULT false,
  exige_tercero      BOOLEAN NOT NULL DEFAULT false,
  exige_centro_costo BOOLEAN NOT NULL DEFAULT false,
  -- La cuenta que lleva la cartera: su saldo se concilia con la de CXC/CXP (B3/B4).
  es_cartera         TEXT CHECK (es_cartera IN ('CXC', 'CXP')),
  es_banco           BOOLEAN NOT NULL DEFAULT false,
  -- Renglón de los estados financieros (C5-01); vacío hasta que la contadora lo defina.
  renglon_esf        TEXT,
  renglon_er         TEXT,
  activa             BOOLEAN NOT NULL DEFAULT true,
  creado_por         UUID REFERENCES sst.usuarios(id),
  actualizado_por    UUID REFERENCES sst.usuarios(id),
  creado_en          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Solo las clases (1 dígito) no tienen padre; todo lo demás cuelga de una cuenta.
  CONSTRAINT chk_cuentas_padre CHECK ((length(codigo) = 1) = (padre_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cuentas_contables_codigo ON sst.cuentas_contables (codigo);
CREATE INDEX IF NOT EXISTS idx_cuentas_contables_padre ON sst.cuentas_contables (padre_id);

DO $$ BEGIN
  CREATE TRIGGER trg_cuentas_contables_tocar BEFORE UPDATE ON sst.cuentas_contables
    FOR EACH ROW EXECUTE FUNCTION sst.fn_tocar_actualizado_en();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- La pantalla de Contabilidad en la matriz de Roles y permisos. Mismo reparto que
-- las demás de Finanzas: admin, contador y auditor sí; administrativo no.
INSERT INTO sst.permisos_rol (rol, vista, permitido) VALUES
  ('admin',          'contabilidad', TRUE),
  ('contador',       'contabilidad', TRUE),
  ('auditor',        'contabilidad', TRUE),
  ('administrativo', 'contabilidad', FALSE)
ON CONFLICT (rol, vista) DO NOTHING;

-- C1-01 · Informes contables (migración 2026-10-02-informes-contables-permiso.sql).
-- Solo consultan el libro: el mismo reparto que Contabilidad.
INSERT INTO sst.permisos_rol (rol, vista, permitido) VALUES
  ('admin',          'informes_contables', TRUE),
  ('contador',       'informes_contables', TRUE),
  ('auditor',        'informes_contables', TRUE),
  ('administrativo', 'informes_contables', FALSE)
ON CONFLICT (rol, vista) DO NOTHING;

-- B1-01 · Motor de comprobantes (migración 2026-09-29-comprobantes.sql)
-- Libro diario: comprobante + movimientos. Cuadre, cuentas válidas, tercero y
-- periodo abierto se verifican al commit (trigger diferido); lo contabilizado no
-- se edita, se anula.
-- Tipos de comprobante con su consecutivo. Los códigos son los que ya usa la
-- contadora en Siigo (FV-1-809, RC-1-101…). `manual` = se puede crear a mano
-- desde la pantalla; los demás los produce el sistema (B2-01 en adelante).
CREATE TABLE IF NOT EXISTS sst.tipos_comprobante (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo             TEXT NOT NULL UNIQUE CHECK (codigo ~ '^[A-Z]{2,4}$'),
  nombre             TEXT NOT NULL,
  consecutivo_actual INTEGER NOT NULL DEFAULT 0 CHECK (consecutivo_actual >= 0),
  manual             BOOLEAN NOT NULL DEFAULT false,
  activo             BOOLEAN NOT NULL DEFAULT true,
  creado_en          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO sst.tipos_comprobante (codigo, nombre, manual) VALUES
  ('FV', 'Factura de venta', false),
  ('NC', 'Nota crédito', false),
  ('DS', 'Documento soporte', false),
  ('NA', 'Nota de ajuste al documento soporte', false),
  ('RC', 'Recibo de caja', false),
  ('CE', 'Comprobante de egreso', false),
  ('RP', 'Anticipo a proveedores', false),
  ('FC', 'Factura de compra', false),
  ('CG', 'Comprobante de gasto interno', false),
  ('NI', 'Nota interna', true),
  ('NM', 'Nómina', false),
  ('SI', 'Saldos iniciales', false),
  ('CA', 'Cierre anual', false),
  ('DP', 'Depreciación', false)
ON CONFLICT (codigo) DO NOTHING;

-- Periodos contables (mes a mes). Un mes sin fila está ABIERTO: la fila nace al
-- cerrarlo por primera vez, así no hay que sembrar años por adelantado.
CREATE TABLE IF NOT EXISTS sst.periodos_contables (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  anio           SMALLINT NOT NULL CHECK (anio BETWEEN 2000 AND 2100),
  mes            SMALLINT NOT NULL CHECK (mes BETWEEN 1 AND 12),
  estado         TEXT NOT NULL DEFAULT 'ABIERTO' CHECK (estado IN ('ABIERTO', 'CERRADO')),
  cerrado_por    UUID REFERENCES sst.usuarios(id),
  cerrado_en     TIMESTAMPTZ,
  -- Reabrir un mes cerrado es excepcional (solo admin) y siempre deja el motivo.
  reabierto_por  UUID REFERENCES sst.usuarios(id),
  reabierto_en   TIMESTAMPTZ,
  motivo_reapertura TEXT,
  UNIQUE (anio, mes)
);

CREATE TABLE IF NOT EXISTS sst.comprobantes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo_id         UUID NOT NULL REFERENCES sst.tipos_comprobante(id),
  -- El consecutivo se asigna al CONTABILIZAR (un borrador no gasta número); el
  -- anulado conserva el suyo, así la numeración no tiene huecos.
  numero          INTEGER,
  fecha           DATE NOT NULL,
  anio            SMALLINT GENERATED ALWAYS AS (EXTRACT(YEAR FROM fecha)::smallint) STORED,
  mes             SMALLINT GENERATED ALWAYS AS (EXTRACT(MONTH FROM fecha)::smallint) STORED,
  descripcion     TEXT,
  estado          TEXT NOT NULL DEFAULT 'BORRADOR' CHECK (estado IN ('BORRADOR', 'CONTABILIZADO', 'ANULADO')),
  -- De dónde sale: un documento electrónico, un recibo… (NULL = nota manual).
  origen_tipo     TEXT,
  origen_id       UUID,
  total_debito    NUMERIC(16,2) NOT NULL DEFAULT 0,
  total_credito   NUMERIC(16,2) NOT NULL DEFAULT 0,
  contabilizado_por UUID REFERENCES sst.usuarios(id),
  contabilizado_en  TIMESTAMPTZ,
  anulado_por     UUID REFERENCES sst.usuarios(id),
  anulado_en      TIMESTAMPTZ,
  motivo_anulacion TEXT,
  creado_por      UUID REFERENCES sst.usuarios(id),
  actualizado_por UUID REFERENCES sst.usuarios(id),
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_comprobante_numero CHECK ((estado = 'BORRADOR') = (numero IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_comprobantes_tipo_numero ON sst.comprobantes (tipo_id, numero) WHERE numero IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_comprobantes_fecha ON sst.comprobantes (fecha);
CREATE INDEX IF NOT EXISTS idx_comprobantes_origen ON sst.comprobantes (origen_tipo, origen_id) WHERE origen_id IS NOT NULL;
-- Un documento se contabiliza una sola vez (lo anulado no cuenta: se puede rehacer).
CREATE UNIQUE INDEX IF NOT EXISTS uq_comprobantes_origen_vigente
  ON sst.comprobantes (origen_tipo, origen_id) WHERE origen_id IS NOT NULL AND estado <> 'ANULADO';

CREATE TABLE IF NOT EXISTS sst.movimientos (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  comprobante_id   UUID NOT NULL REFERENCES sst.comprobantes(id) ON DELETE CASCADE,
  linea            SMALLINT NOT NULL CHECK (linea > 0),
  cuenta_id        UUID NOT NULL REFERENCES sst.cuentas_contables(id),
  tercero_id       UUID REFERENCES sst.terceros(id),
  -- El maestro de centros de costo llega con B8-01; la FK se añade entonces.
  centro_costo_id  UUID,
  debito           NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (debito >= 0),
  credito          NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (credito >= 0),
  -- Base de la retención o del impuesto, cuando la línea es uno (la pide el auxiliar).
  base             NUMERIC(16,2),
  descripcion      TEXT,
  -- Documento con el que se cruza (FE-809, DS-1-1316): la cartera y el auxiliar lo muestran.
  documento_cruce    TEXT,
  documento_cruce_id UUID,
  CONSTRAINT chk_movimiento_un_lado CHECK ((debito > 0) <> (credito > 0)),
  UNIQUE (comprobante_id, linea)
);
CREATE INDEX IF NOT EXISTS idx_movimientos_cuenta ON sst.movimientos (cuenta_id);
CREATE INDEX IF NOT EXISTS idx_movimientos_tercero ON sst.movimientos (tercero_id) WHERE tercero_id IS NOT NULL;

DO $$ BEGIN
  CREATE TRIGGER trg_tipos_comprobante_tocar BEFORE UPDATE ON sst.tipos_comprobante
    FOR EACH ROW EXECUTE FUNCTION sst.fn_tocar_actualizado_en();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER trg_comprobantes_tocar BEFORE UPDATE ON sst.comprobantes
    FOR EACH ROW EXECUTE FUNCTION sst.fn_tocar_actualizado_en();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ¿Está cerrado el mes? (sin fila = abierto).
CREATE OR REPLACE FUNCTION sst.fn_periodo_cerrado(p_fecha DATE) RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM sst.periodos_contables
     WHERE anio = EXTRACT(YEAR FROM p_fecha) AND mes = EXTRACT(MONTH FROM p_fecha) AND estado = 'CERRADO'
  );
$$ LANGUAGE sql STABLE;

-- Lo contabilizado o anulado no se toca: ni sus líneas, ni su fecha, ni su tipo.
-- Las únicas transiciones válidas son BORRADOR → CONTABILIZADO → ANULADO.
CREATE OR REPLACE FUNCTION sst.fn_movimientos_inmutables() RETURNS trigger AS $$
DECLARE
  v_estado TEXT;
BEGIN
  SELECT estado INTO v_estado FROM sst.comprobantes
   WHERE id = COALESCE(NEW.comprobante_id, OLD.comprobante_id);
  -- Borrar el comprobante arrastra sus líneas (CASCADE): ahí ya no existe la fila.
  IF v_estado IS NOT NULL AND v_estado <> 'BORRADOR' THEN
    RAISE EXCEPTION 'El comprobante ya está % : sus movimientos no se modifican (anúlelo y haga otro).', lower(v_estado)
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER trg_movimientos_inmutables BEFORE INSERT OR UPDATE OR DELETE ON sst.movimientos
    FOR EACH ROW EXECUTE FUNCTION sst.fn_movimientos_inmutables();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION sst.fn_comprobante_transicion() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.estado <> 'BORRADOR' THEN
      RAISE EXCEPTION 'Un comprobante % no se borra: se anula.', lower(OLD.estado) USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.estado = 'ANULADO' THEN
    RAISE EXCEPTION 'El comprobante está anulado y no admite cambios.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.estado = 'CONTABILIZADO' THEN
    IF NEW.estado <> 'ANULADO'
       OR NEW.fecha <> OLD.fecha OR NEW.tipo_id <> OLD.tipo_id OR NEW.numero IS DISTINCT FROM OLD.numero
       OR NEW.total_debito <> OLD.total_debito OR NEW.total_credito <> OLD.total_credito THEN
      RAISE EXCEPTION 'Un comprobante contabilizado no se edita: se anula y se hace otro.' USING ERRCODE = 'check_violation';
    END IF;
    IF sst.fn_periodo_cerrado(OLD.fecha) THEN
      RAISE EXCEPTION 'El periodo %-% está cerrado: no se puede anular.', OLD.anio, lpad(OLD.mes::text, 2, '0')
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER trg_comprobante_transicion BEFORE UPDATE OR DELETE ON sst.comprobantes
    FOR EACH ROW EXECUTE FUNCTION sst.fn_comprobante_transicion();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Cuadre y validez de un comprobante CONTABILIZADO, al commit.
CREATE OR REPLACE FUNCTION sst.fn_validar_comprobante() RETURNS trigger AS $$
DECLARE
  v_id    UUID;
  c       RECORD;
  v_deb   NUMERIC(16,2);
  v_cred  NUMERIC(16,2);
  v_n     INTEGER;
  v_mala  TEXT;
BEGIN
  -- La misma función sirve a las dos tablas; NEW no tiene las mismas columnas en
  -- cada una, así que se lee según cuál disparó (un CASE las evaluaría ambas).
  IF TG_TABLE_NAME = 'comprobantes' THEN
    v_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    v_id := OLD.comprobante_id;
  ELSE
    v_id := NEW.comprobante_id;
  END IF;
  SELECT * INTO c FROM sst.comprobantes WHERE id = v_id;
  -- Solo se valida lo que se está contabilizando (el anulado ya se validó al nacer).
  IF c.id IS NULL OR c.estado <> 'CONTABILIZADO' THEN RETURN NULL; END IF;
  -- Anidado a propósito: PL/pgSQL no corta el AND, y OLD de un movimiento no tiene `estado`.
  IF TG_TABLE_NAME = 'comprobantes' AND TG_OP = 'UPDATE' THEN
    IF OLD.estado = 'CONTABILIZADO' THEN RETURN NULL; END IF;
  END IF;

  SELECT COALESCE(sum(debito), 0), COALESCE(sum(credito), 0), count(*) INTO v_deb, v_cred, v_n
    FROM sst.movimientos WHERE comprobante_id = v_id;
  IF v_n < 2 THEN
    RAISE EXCEPTION 'El comprobante necesita al menos dos movimientos.' USING ERRCODE = 'check_violation';
  END IF;
  IF v_deb <> v_cred THEN
    RAISE EXCEPTION 'El comprobante no cuadra: débitos % ≠ créditos %.', v_deb, v_cred USING ERRCODE = 'check_violation';
  END IF;
  IF v_deb <> c.total_debito OR v_cred <> c.total_credito THEN
    RAISE EXCEPTION 'Los totales guardados del comprobante no coinciden con sus movimientos.' USING ERRCODE = 'check_violation';
  END IF;

  SELECT cc.codigo INTO v_mala FROM sst.movimientos m JOIN sst.cuentas_contables cc ON cc.id = m.cuenta_id
   WHERE m.comprobante_id = v_id AND (NOT cc.acepta_movimiento OR NOT cc.activa) LIMIT 1;
  IF v_mala IS NOT NULL THEN
    RAISE EXCEPTION 'La cuenta % no recibe movimiento (o está inactiva).', v_mala USING ERRCODE = 'check_violation';
  END IF;
  SELECT cc.codigo INTO v_mala FROM sst.movimientos m JOIN sst.cuentas_contables cc ON cc.id = m.cuenta_id
   WHERE m.comprobante_id = v_id AND cc.exige_tercero AND m.tercero_id IS NULL LIMIT 1;
  IF v_mala IS NOT NULL THEN
    RAISE EXCEPTION 'La cuenta % exige tercero.', v_mala USING ERRCODE = 'check_violation';
  END IF;
  IF sst.fn_periodo_cerrado(c.fecha) THEN
    RAISE EXCEPTION 'El periodo %-% está cerrado.', c.anio, lpad(c.mes::text, 2, '0') USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE CONSTRAINT TRIGGER trg_validar_comprobante AFTER INSERT OR UPDATE ON sst.comprobantes
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sst.fn_validar_comprobante();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE CONSTRAINT TRIGGER trg_validar_movimientos AFTER INSERT OR UPDATE OR DELETE ON sst.movimientos
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sst.fn_validar_comprobante();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- B2-01 · Reglas de contabilización (migración 2026-09-30-reglas-contables.sql)
-- Qué cuenta usa cada concepto de un documento; la más específica (tercero,
-- producto) gana. Se cargan desde la pantalla, no aquí.
CREATE TABLE IF NOT EXISTS sst.reglas_contables (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  concepto        TEXT NOT NULL CHECK (concepto IN (
                    'FV_CXC', 'FV_INGRESO', 'FV_DESCUENTO', 'FV_IVA', 'FV_RETEFUENTE', 'FV_RETEIVA',
                    'FV_AUTORRET_DB', 'FV_AUTORRET_CR',
                    'NC_CXC', 'NC_DEVOLUCION', 'NC_DESCUENTO', 'NC_IVA', 'NC_RETEFUENTE', 'NC_RETEIVA')),
  cuenta_id       UUID NOT NULL REFERENCES sst.cuentas_contables(id),
  producto_id     UUID REFERENCES sst.productos(id),
  tercero_id      UUID REFERENCES sst.terceros(id),
  activa          BOOLEAN NOT NULL DEFAULT true,
  actualizado_por UUID REFERENCES sst.usuarios(id),
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Una sola regla por concepto y alcance (general, por producto o por tercero).
CREATE UNIQUE INDEX IF NOT EXISTS uq_reglas_contables_alcance ON sst.reglas_contables (
  concepto,
  COALESCE(producto_id, '00000000-0000-0000-0000-000000000000'),
  COALESCE(tercero_id, '00000000-0000-0000-0000-000000000000'));

DO $$ BEGIN
  CREATE TRIGGER trg_reglas_contables_tocar BEFORE UPDATE ON sst.reglas_contables
    FOR EACH ROW EXECUTE FUNCTION sst.fn_tocar_actualizado_en();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- El documento apunta a su asiento (la columna nació en A1-01 sin FK porque la
-- tabla de comprobantes aún no existía).
DO $$ BEGIN
  ALTER TABLE sst.documentos_electronicos
    ADD CONSTRAINT fk_documentos_comprobante FOREIGN KEY (comprobante_id) REFERENCES sst.comprobantes(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Por qué no se pudo contabilizar (falta una regla, el mes está cerrado…). La
-- factura ya es válida ante la DIAN: un asiento que falla NO la deshace; queda
-- pendiente con su motivo y se reintenta desde Contabilidad.
ALTER TABLE sst.documentos_electronicos ADD COLUMN IF NOT EXISTS contabilizacion_error TEXT;

-- B3-01 · Cartera y recibos de caja (migración 2026-09-30-cartera.sql)
-- Cada factura contabilizada abre su cuenta por cobrar; las notas crédito y los
-- recibos la bajan. Lo que el pagador retiene al pagar va a su cuenta de retención.
-- La cuenta contable de cada retención: adónde va lo que el cliente retiene al
-- pagar. En Siigo depende de la TARIFA (13551819 «Rete Ica 5» para el 5 ‰ de
-- Bolívar, 13551820 «Rete ica 6» para el 6 ‰ de AXA y Colmena), no del cliente.
ALTER TABLE sst.retenciones ADD COLUMN IF NOT EXISTS cuenta_id UUID REFERENCES sst.cuentas_contables(id);

CREATE TABLE IF NOT EXISTS sst.cartera_documentos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo            TEXT NOT NULL CHECK (tipo IN ('CXC', 'CXP')),
  tercero_id      UUID NOT NULL REFERENCES sst.terceros(id),
  -- De dónde nace: una factura (CXC) o, desde B4-01, un documento soporte o una compra.
  documento_id    UUID UNIQUE REFERENCES sst.documentos_electronicos(id),
  numero          TEXT NOT NULL,
  fecha           DATE NOT NULL,
  vencimiento     DATE NOT NULL,
  valor           NUMERIC(16,2) NOT NULL CHECK (valor > 0),
  saldo           NUMERIC(16,2) NOT NULL,
  -- La cuenta de cartera en que quedó (13050501): la conciliación la compara con el libro.
  cuenta_id       UUID NOT NULL REFERENCES sst.cuentas_contables(id),
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_cartera_saldo CHECK (saldo >= 0 AND saldo <= valor)
);
CREATE INDEX IF NOT EXISTS idx_cartera_tercero ON sst.cartera_documentos (tipo, tercero_id) WHERE saldo > 0;

DO $$ BEGIN
  CREATE TRIGGER trg_cartera_documentos_tocar BEFORE UPDATE ON sst.cartera_documentos
    FOR EACH ROW EXECUTE FUNCTION sst.fn_tocar_actualizado_en();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Recibo de caja: lo que consignó un cliente, a qué cuenta de banco y cuándo.
-- Su número es el del comprobante RC (el consecutivo lo da el libro).
CREATE TABLE IF NOT EXISTS sst.recibos_caja (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tercero_id       UUID NOT NULL REFERENCES sst.terceros(id),
  fecha            DATE NOT NULL,
  cuenta_banco_id  UUID NOT NULL REFERENCES sst.cuentas_contables(id),
  valor_consignado NUMERIC(16,2) NOT NULL CHECK (valor_consignado > 0),
  observaciones    TEXT,
  estado           TEXT NOT NULL DEFAULT 'CONTABILIZADO' CHECK (estado IN ('CONTABILIZADO', 'ANULADO')),
  comprobante_id   UUID REFERENCES sst.comprobantes(id),
  motivo_anulacion TEXT,
  anulado_por      UUID REFERENCES sst.usuarios(id),
  anulado_en       TIMESTAMPTZ,
  creado_por       UUID REFERENCES sst.usuarios(id),
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recibos_caja_tercero ON sst.recibos_caja (tercero_id, fecha DESC);

-- Lo que baja el saldo de un documento de cartera: una nota crédito, un recibo
-- de caja (y desde B4-01, un egreso). `valor_pagado` es la plata; `valor_retenciones`
-- lo que el pagador retuvo. Anular el recibo anula sus aplicaciones y devuelve el saldo.
CREATE TABLE IF NOT EXISTS sst.cartera_aplicaciones (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cartera_documento_id  UUID NOT NULL REFERENCES sst.cartera_documentos(id),
  origen_tipo           TEXT NOT NULL CHECK (origen_tipo IN ('NOTA_CREDITO', 'RECIBO_CAJA')),
  origen_id             UUID NOT NULL,
  fecha                 DATE NOT NULL,
  valor_pagado          NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (valor_pagado >= 0),
  valor_retenciones     NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (valor_retenciones >= 0),
  anulada               BOOLEAN NOT NULL DEFAULT false,
  creado_en             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_aplicacion_positiva CHECK (valor_pagado + valor_retenciones > 0)
);
CREATE INDEX IF NOT EXISTS idx_cartera_aplicaciones_doc ON sst.cartera_aplicaciones (cartera_documento_id) WHERE NOT anulada;
CREATE INDEX IF NOT EXISTS idx_cartera_aplicaciones_origen ON sst.cartera_aplicaciones (origen_tipo, origen_id);

-- El detalle de lo retenido en cada aplicación (qué retención, sobre qué base).
CREATE TABLE IF NOT EXISTS sst.cartera_aplicacion_retenciones (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aplicacion_id   UUID NOT NULL REFERENCES sst.cartera_aplicaciones(id) ON DELETE CASCADE,
  retencion_id    UUID NOT NULL REFERENCES sst.retenciones(id),
  cuenta_id       UUID NOT NULL REFERENCES sst.cuentas_contables(id),
  base            NUMERIC(16,2),
  valor           NUMERIC(16,2) NOT NULL CHECK (valor > 0)
);

-- La pantalla de Cartera en la matriz de Roles y permisos (mismo reparto que Finanzas).
INSERT INTO sst.permisos_rol (rol, vista, permitido) VALUES
  ('admin',          'cartera', TRUE),
  ('contador',       'cartera', TRUE),
  ('auditor',        'cartera', TRUE),
  ('administrativo', 'cartera', FALSE)
ON CONFLICT (rol, vista) DO NOTHING;

-- B5-01 + B4-01 · Compras, cuentas por pagar, anticipos y egresos (migración 2026-09-30-compras-cxp.sql)
-- Va DESPUÉS de B2-01 y B3-01: reemplaza las restricciones CHECK que ellas crean.
-- Conceptos de compras y pagos en las reglas de contabilización.
ALTER TABLE sst.reglas_contables DROP CONSTRAINT IF EXISTS reglas_contables_concepto_check;
ALTER TABLE sst.reglas_contables ADD CONSTRAINT reglas_contables_concepto_check CHECK (concepto IN (
  'FV_CXC', 'FV_INGRESO', 'FV_DESCUENTO', 'FV_IVA', 'FV_RETEFUENTE', 'FV_RETEIVA',
  'FV_AUTORRET_DB', 'FV_AUTORRET_CR',
  'NC_CXC', 'NC_DEVOLUCION', 'NC_DESCUENTO', 'NC_IVA', 'NC_RETEFUENTE', 'NC_RETEIVA',
  'CP_CXP', 'CP_CXP_HONORARIOS', 'CP_IVA_DESCONTABLE', 'CE_ANTICIPO'));

CREATE TABLE IF NOT EXISTS sst.compras (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo              TEXT NOT NULL CHECK (tipo IN ('COMPRA', 'SERVICIO', 'SERVICIO_PROFESIONAL', 'GASTO_INTERNO')),
  tercero_id        UUID NOT NULL REFERENCES sst.terceros(id),
  -- Número de la factura del proveedor (vacío en un gasto interno sin factura).
  numero_proveedor  TEXT,
  cufe              TEXT,
  fecha             DATE NOT NULL,
  -- CREDITO abre cuenta por pagar; CONTADO sale en el acto de `cuenta_pago_id` (banco o caja).
  forma_pago        TEXT NOT NULL CHECK (forma_pago IN ('CREDITO', 'CONTADO')),
  vencimiento       DATE,
  cuenta_pago_id    UUID REFERENCES sst.cuentas_contables(id),
  -- El maestro de centros de costo llega con B8-01; la FK se añade entonces.
  centro_costo_id   UUID,
  descripcion       TEXT,
  subtotal          NUMERIC(16,2) NOT NULL,
  total_iva         NUMERIC(16,2) NOT NULL DEFAULT 0,
  total_retenciones NUMERIC(16,2) NOT NULL DEFAULT 0,
  total_a_pagar     NUMERIC(16,2) NOT NULL,
  estado            TEXT NOT NULL DEFAULT 'CONTABILIZADO' CHECK (estado IN ('CONTABILIZADO', 'ANULADO')),
  comprobante_id    UUID REFERENCES sst.comprobantes(id),
  motivo_anulacion  TEXT,
  anulado_por       UUID REFERENCES sst.usuarios(id),
  anulado_en        TIMESTAMPTZ,
  creado_por        UUID REFERENCES sst.usuarios(id),
  creado_en         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_compra_pago CHECK ((forma_pago = 'CONTADO') = (cuenta_pago_id IS NOT NULL)),
  CONSTRAINT chk_compra_vencimiento CHECK (forma_pago = 'CONTADO' OR vencimiento IS NOT NULL)
);
-- La misma factura de un proveedor no se registra dos veces (lo anulado no cuenta).
CREATE UNIQUE INDEX IF NOT EXISTS uq_compras_factura_proveedor
  ON sst.compras (tercero_id, upper(numero_proveedor)) WHERE numero_proveedor IS NOT NULL AND estado <> 'ANULADO';
CREATE INDEX IF NOT EXISTS idx_compras_fecha ON sst.compras (fecha DESC);

CREATE TABLE IF NOT EXISTS sst.compra_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  compra_id   UUID NOT NULL REFERENCES sst.compras(id) ON DELETE CASCADE,
  orden       SMALLINT NOT NULL,
  cuenta_id   UUID NOT NULL REFERENCES sst.cuentas_contables(id),
  descripcion TEXT NOT NULL,
  valor       NUMERIC(16,2) NOT NULL CHECK (valor > 0),
  iva_pct     NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (iva_pct >= 0),
  iva_valor   NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (iva_valor >= 0)
);

-- Lo que JD&D le retiene al proveedor al causar la compra.
CREATE TABLE IF NOT EXISTS sst.compra_retenciones (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  compra_id    UUID NOT NULL REFERENCES sst.compras(id) ON DELETE CASCADE,
  retencion_id UUID NOT NULL REFERENCES sst.retenciones(id),
  cuenta_id    UUID NOT NULL REFERENCES sst.cuentas_contables(id),
  base         NUMERIC(16,2) NOT NULL,
  tarifa       NUMERIC(6,3) NOT NULL,
  valor        NUMERIC(16,2) NOT NULL CHECK (valor > 0)
);

-- La cuenta por pagar nace de una compra (y desde A4-01, de un documento soporte).
ALTER TABLE sst.cartera_documentos ADD COLUMN IF NOT EXISTS compra_id UUID UNIQUE REFERENCES sst.compras(id);
-- Una cuenta por pagar cuya compra se anuló queda con saldo cero y marcada (no se
-- borra: sus pagos anulados siguen apuntándole y el historial se conserva).
ALTER TABLE sst.cartera_documentos ADD COLUMN IF NOT EXISTS anulado BOOLEAN NOT NULL DEFAULT false;

-- Anticipo a un proveedor (RP): plata entregada antes de su factura, que luego se
-- cruza en un egreso. Lleva su propio saldo por cruzar.
CREATE TABLE IF NOT EXISTS sst.anticipos_proveedor (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tercero_id       UUID NOT NULL REFERENCES sst.terceros(id),
  fecha            DATE NOT NULL,
  cuenta_banco_id  UUID NOT NULL REFERENCES sst.cuentas_contables(id),
  cuenta_id        UUID NOT NULL REFERENCES sst.cuentas_contables(id),
  valor            NUMERIC(16,2) NOT NULL CHECK (valor > 0),
  saldo            NUMERIC(16,2) NOT NULL,
  observaciones    TEXT,
  estado           TEXT NOT NULL DEFAULT 'CONTABILIZADO' CHECK (estado IN ('CONTABILIZADO', 'ANULADO')),
  comprobante_id   UUID REFERENCES sst.comprobantes(id),
  motivo_anulacion TEXT,
  creado_por       UUID REFERENCES sst.usuarios(id),
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_anticipo_saldo CHECK (saldo >= 0 AND saldo <= valor)
);

-- Comprobante de egreso: el pago a un proveedor.
CREATE TABLE IF NOT EXISTS sst.egresos (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tercero_id       UUID NOT NULL REFERENCES sst.terceros(id),
  fecha            DATE NOT NULL,
  cuenta_banco_id  UUID REFERENCES sst.cuentas_contables(id),
  valor_pagado     NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (valor_pagado >= 0),
  valor_anticipos  NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (valor_anticipos >= 0),
  observaciones    TEXT,
  estado           TEXT NOT NULL DEFAULT 'CONTABILIZADO' CHECK (estado IN ('CONTABILIZADO', 'ANULADO')),
  comprobante_id   UUID REFERENCES sst.comprobantes(id),
  motivo_anulacion TEXT,
  anulado_por      UUID REFERENCES sst.usuarios(id),
  anulado_en       TIMESTAMPTZ,
  creado_por       UUID REFERENCES sst.usuarios(id),
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_egreso_banco CHECK (valor_pagado = 0 OR cuenta_banco_id IS NOT NULL)
);

-- Qué anticipos cruzó cada egreso (para devolverlos si se anula).
CREATE TABLE IF NOT EXISTS sst.egreso_anticipos (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  egreso_id    UUID NOT NULL REFERENCES sst.egresos(id),
  anticipo_id  UUID NOT NULL REFERENCES sst.anticipos_proveedor(id),
  valor        NUMERIC(16,2) NOT NULL CHECK (valor > 0)
);

-- Las aplicaciones de cartera también pueden venir de un egreso, y en ellas se
-- distingue lo cruzado con anticipo.
ALTER TABLE sst.cartera_aplicaciones DROP CONSTRAINT IF EXISTS cartera_aplicaciones_origen_tipo_check;
ALTER TABLE sst.cartera_aplicaciones ADD CONSTRAINT cartera_aplicaciones_origen_tipo_check
  CHECK (origen_tipo IN ('NOTA_CREDITO', 'RECIBO_CAJA', 'EGRESO'));
ALTER TABLE sst.cartera_aplicaciones ADD COLUMN IF NOT EXISTS valor_anticipo NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (valor_anticipo >= 0);
ALTER TABLE sst.cartera_aplicaciones DROP CONSTRAINT IF EXISTS chk_aplicacion_positiva;
ALTER TABLE sst.cartera_aplicaciones ADD CONSTRAINT chk_aplicacion_positiva CHECK (valor_pagado + valor_retenciones + valor_anticipo > 0);

-- La pantalla de Compras en la matriz de Roles y permisos (mismo reparto que Finanzas).
INSERT INTO sst.permisos_rol (rol, vista, permitido) VALUES
  ('admin',          'compras', TRUE),
  ('contador',       'compras', TRUE),
  ('auditor',        'compras', TRUE),
  ('administrativo', 'compras', FALSE)
ON CONFLICT (rol, vista) DO NOTHING;

-- B8-01 · Centros de costo (migración 2026-09-30-centros-costo.sql)
-- Reemplaza fn_validar_comprobante (B1-01) para exigir el centro de costo donde la cuenta lo pida.
CREATE TABLE IF NOT EXISTS sst.centros_costo (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo          TEXT NOT NULL CHECK (btrim(codigo) <> ''),
  nombre          TEXT NOT NULL CHECK (btrim(nombre) <> ''),
  activo          BOOLEAN NOT NULL DEFAULT true,
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_centros_costo_codigo ON sst.centros_costo (upper(codigo));

DO $$ BEGIN
  CREATE TRIGGER trg_centros_costo_tocar BEFORE UPDATE ON sst.centros_costo
    FOR EACH ROW EXECUTE FUNCTION sst.fn_tocar_actualizado_en();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Las columnas ya existían (B1-01, B5-01) esperando el maestro.
DO $$ BEGIN
  ALTER TABLE sst.movimientos ADD CONSTRAINT fk_movimientos_centro_costo FOREIGN KEY (centro_costo_id) REFERENCES sst.centros_costo(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE sst.compras ADD CONSTRAINT fk_compras_centro_costo FOREIGN KEY (centro_costo_id) REFERENCES sst.centros_costo(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_movimientos_centro_costo ON sst.movimientos (centro_costo_id) WHERE centro_costo_id IS NOT NULL;

-- El cuadre del comprobante, ahora también con el centro de costo obligatorio.
CREATE OR REPLACE FUNCTION sst.fn_validar_comprobante() RETURNS trigger AS $$
DECLARE
  v_id    UUID;
  c       RECORD;
  v_deb   NUMERIC(16,2);
  v_cred  NUMERIC(16,2);
  v_n     INTEGER;
  v_mala  TEXT;
BEGIN
  -- La misma función sirve a las dos tablas; NEW no tiene las mismas columnas en
  -- cada una, así que se lee según cuál disparó (un CASE las evaluaría ambas).
  IF TG_TABLE_NAME = 'comprobantes' THEN
    v_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    v_id := OLD.comprobante_id;
  ELSE
    v_id := NEW.comprobante_id;
  END IF;
  SELECT * INTO c FROM sst.comprobantes WHERE id = v_id;
  -- Solo se valida lo que se está contabilizando (el anulado ya se validó al nacer).
  IF c.id IS NULL OR c.estado <> 'CONTABILIZADO' THEN RETURN NULL; END IF;
  -- Anidado a propósito: PL/pgSQL no corta el AND, y OLD de un movimiento no tiene `estado`.
  IF TG_TABLE_NAME = 'comprobantes' AND TG_OP = 'UPDATE' THEN
    IF OLD.estado = 'CONTABILIZADO' THEN RETURN NULL; END IF;
  END IF;

  SELECT COALESCE(sum(debito), 0), COALESCE(sum(credito), 0), count(*) INTO v_deb, v_cred, v_n
    FROM sst.movimientos WHERE comprobante_id = v_id;
  IF v_n < 2 THEN
    RAISE EXCEPTION 'El comprobante necesita al menos dos movimientos.' USING ERRCODE = 'check_violation';
  END IF;
  IF v_deb <> v_cred THEN
    RAISE EXCEPTION 'El comprobante no cuadra: débitos % ≠ créditos %.', v_deb, v_cred USING ERRCODE = 'check_violation';
  END IF;
  IF v_deb <> c.total_debito OR v_cred <> c.total_credito THEN
    RAISE EXCEPTION 'Los totales guardados del comprobante no coinciden con sus movimientos.' USING ERRCODE = 'check_violation';
  END IF;

  SELECT cc.codigo INTO v_mala FROM sst.movimientos m JOIN sst.cuentas_contables cc ON cc.id = m.cuenta_id
   WHERE m.comprobante_id = v_id AND (NOT cc.acepta_movimiento OR NOT cc.activa) LIMIT 1;
  IF v_mala IS NOT NULL THEN
    RAISE EXCEPTION 'La cuenta % no recibe movimiento (o está inactiva).', v_mala USING ERRCODE = 'check_violation';
  END IF;
  SELECT cc.codigo INTO v_mala FROM sst.movimientos m JOIN sst.cuentas_contables cc ON cc.id = m.cuenta_id
   WHERE m.comprobante_id = v_id AND cc.exige_tercero AND m.tercero_id IS NULL LIMIT 1;
  IF v_mala IS NOT NULL THEN
    RAISE EXCEPTION 'La cuenta % exige tercero.', v_mala USING ERRCODE = 'check_violation';
  END IF;
  -- B8-01 · La cuenta marcada "exige centro de costo" no admite una línea sin él.
  SELECT cc.codigo INTO v_mala FROM sst.movimientos m JOIN sst.cuentas_contables cc ON cc.id = m.cuenta_id
   WHERE m.comprobante_id = v_id AND cc.exige_centro_costo AND m.centro_costo_id IS NULL LIMIT 1;
  IF v_mala IS NOT NULL THEN
    RAISE EXCEPTION 'La cuenta % exige centro de costo.', v_mala USING ERRCODE = 'check_violation';
  END IF;
  IF sst.fn_periodo_cerrado(c.fecha) THEN
    RAISE EXCEPTION 'El periodo %-% está cerrado.', c.anio, lpad(c.mes::text, 2, '0') USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- 30-sep-2026 · «Validado plataforma» (check a mano, no bloquea) y el cobro de la
-- orden desglosado + aprobado por operación. Por qué y cómo: ver
-- db/migraciones/2026-09-30-validado-y-aprobacion-cobro.sql. Va ANTES de la vista
-- de abajo porque es `SELECT o.*` (trampa 69).
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS validado_plataforma_en  TIMESTAMPTZ;
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS validado_plataforma_por UUID REFERENCES sst.usuarios(id);
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS cobro_transporte    NUMERIC(14,2);
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS cobro_alojamiento   NUMERIC(14,2);
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS cobro_alimentacion  NUMERIC(14,2);
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS cobro_tiempo_muerto NUMERIC(14,2);
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS cobro_material      NUMERIC(14,2);
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS cobro_aprobado_en    TIMESTAMPTZ;
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS cobro_aprobado_por   UUID REFERENCES sst.usuarios(id);
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS cobro_aprobado_total NUMERIC(14,2);
-- 1-oct-2026 · N.º de radicado ante Bolívar (a mano). Ver
-- db/migraciones/2026-10-01-numero-radicado.sql.
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS numero_radicado     TEXT;
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS numero_radicado_en  TIMESTAMPTZ;
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS numero_radicado_por UUID REFERENCES sst.usuarios(id);
CREATE TABLE IF NOT EXISTS sst.historial_aprobacion_cobro (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  orden_id    UUID NOT NULL REFERENCES sst.ordenes_servicio(id) ON DELETE CASCADE,
  accion      TEXT NOT NULL CHECK (accion IN ('APROBADA', 'RETIRADA', 'ANULADA_POR_CAMBIO')),
  total       NUMERIC(14,2),
  observacion TEXT,
  usuario_id  UUID REFERENCES sst.usuarios(id),
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_hist_aprob_cobro_orden ON sst.historial_aprobacion_cobro(orden_id, creado_en);

-- Listado expandido de OS con nombres legibles (apoya M3 / Informes).
-- Se re-crea desde cero (no OR REPLACE) porque `o.*` cambia de columnas cuando
-- se agregan campos a ordenes_servicio, y CREATE OR REPLACE no admite reordenar.
-- Vive aquí, al final, porque cruza con `sst.terceros` (A3-01).
DROP VIEW IF EXISTS sst.vw_ordenes_expandidas;
CREATE VIEW sst.vw_ordenes_expandidas AS
SELECT o.*,
       a.nombre         AS arl_nombre,
       a.formato_origen AS arl_formato,
       -- A3-01 · Quién paga la orden, para los textos (correos, agenda, PDF):
       -- la ARL o, en una orden particular, el cliente. `arl_nombre` sigue NULL
       -- en las particulares a propósito: la matriz de formatos se decide por él
       -- y un cliente no tiene formatos de ARL.
       COALESCE(a.nombre, tp_pag.razon_social,
                NULLIF(btrim(concat_ws(' ', tp_pag.nombres, tp_pag.apellidos)), '')) AS pagador_nombre,
       p.nombre         AS profesional_nombre,
       p.correo         AS profesional_correo,
       -- ASG · Quién firma los formatos cuando NO es quien ejecuta (el
       -- profesional registrado ante la ARL). NULL en el caso normal.
       pf.nombre        AS profesional_formatos_nombre,
       -- CFG-04 · El NOMBRE del tipo de orden viaja resuelto: la vista de
       -- Órdenes lo enseña en cada fila y pedir el catálogo aparte para
       -- traducir un id sería un viaje por pantalla.
       tp.nombre        AS tipo_orden,
       tp.valor_hora    AS tipo_orden_valor_hora,
       -- La categoría del viático, resuelta por el mismo motivo: el detalle de
       -- la orden y el informe de facturación la enseñan junto a la cifra, y sin
       -- el nombre un importe suelto no dice de qué es.
       tv.nombre        AS viaticos_tipo,
       tv.valor         AS viaticos_tipo_valor
FROM sst.ordenes_servicio o
LEFT JOIN sst.arls a          ON a.id = o.arl_id
LEFT JOIN sst.terceros tp_pag ON tp_pag.id = o.pagador_tercero_id
LEFT JOIN sst.profesionales p ON p.id = o.profesional_asignado_id
LEFT JOIN sst.profesionales pf ON pf.id = o.profesional_formatos_id
LEFT JOIN sst.tipos_orden tp  ON tp.id = o.tipo_orden_id
LEFT JOIN sst.tipos_viatico tv ON tv.id = o.viaticos_tipo_id;

-- C7-01 · Activos fijos, depreciación mensual y QR (migración 2026-10-02-activos-fijos.sql).
CREATE SEQUENCE IF NOT EXISTS sst.seq_activos_fijos;

CREATE TABLE IF NOT EXISTS sst.activos_fijos (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- AF-0001…: lo que va impreso en la etiqueta con el QR.
  codigo                 TEXT NOT NULL UNIQUE DEFAULT ('AF-' || lpad(nextval('sst.seq_activos_fijos')::text, 4, '0')),
  descripcion            TEXT NOT NULL CHECK (btrim(descripcion) <> ''),
  serial                 TEXT,
  ubicacion              TEXT,
  responsable            TEXT,
  proveedor_id           UUID REFERENCES sst.terceros(id),
  fecha_compra           DATE NOT NULL,
  valor_compra           NUMERIC(16,2) NOT NULL CHECK (valor_compra > 0),
  valor_residual         NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (valor_residual >= 0),
  vida_util_meses        SMALLINT NOT NULL CHECK (vida_util_meses BETWEEN 1 AND 1200),
  -- Primer mes que se deprecia (siempre día 1). Por defecto el mes siguiente a la
  -- compra; la contadora lo cambia si el activo empezó a usarse en otra fecha.
  inicio_depreciacion    DATE NOT NULL CHECK (EXTRACT(DAY FROM inicio_depreciacion) = 1),
  cuenta_activo_id       UUID NOT NULL REFERENCES sst.cuentas_contables(id),
  cuenta_depreciacion_id UUID NOT NULL REFERENCES sst.cuentas_contables(id),
  cuenta_gasto_id        UUID NOT NULL REFERENCES sst.cuentas_contables(id),
  centro_costo_id        UUID REFERENCES sst.centros_costo(id),
  observaciones          TEXT,
  creado_por             UUID REFERENCES sst.usuarios(id),
  actualizado_por        UUID REFERENCES sst.usuarios(id),
  creado_en              TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_activo_residual CHECK (valor_residual < valor_compra)
);

-- Una corrida de depreciación por mes: es el «documento» del que nace el DP
-- (origen_tipo = 'DEPRECIACION'), así el DP no se anula suelto desde Contabilidad.
CREATE TABLE IF NOT EXISTS sst.depreciaciones_mes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  anio            SMALLINT NOT NULL CHECK (anio BETWEEN 2000 AND 2100),
  mes             SMALLINT NOT NULL CHECK (mes BETWEEN 1 AND 12),
  comprobante_id  UUID REFERENCES sst.comprobantes(id),
  total           NUMERIC(16,2) NOT NULL DEFAULT 0,
  creado_por      UUID REFERENCES sst.usuarios(id),
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (anio, mes)
);

-- Cuota de cada activo en cada mes. Un activo dado de alta tarde se pone al día
-- en la siguiente corrida: sus meses atrasados quedan aquí uno por uno.
CREATE TABLE IF NOT EXISTS sst.depreciaciones_activo (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  corrida_id      UUID NOT NULL REFERENCES sst.depreciaciones_mes(id) ON DELETE CASCADE,
  activo_id       UUID NOT NULL REFERENCES sst.activos_fijos(id),
  anio            SMALLINT NOT NULL,
  mes             SMALLINT NOT NULL,
  -- Número de cuota (1 = primer mes de vida útil).
  cuota           SMALLINT NOT NULL CHECK (cuota > 0),
  valor           NUMERIC(16,2) NOT NULL CHECK (valor > 0),
  UNIQUE (activo_id, anio, mes),
  UNIQUE (activo_id, cuota)
);
CREATE INDEX IF NOT EXISTS idx_depreciaciones_activo_corrida ON sst.depreciaciones_activo (corrida_id);

DO $$ BEGIN
  CREATE TRIGGER trg_activos_fijos_tocar BEFORE UPDATE ON sst.activos_fijos
    FOR EACH ROW EXECUTE FUNCTION sst.fn_tocar_actualizado_en();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================================
-- 7-oct-2026 · Peticiones de la reunión de contabilidad con JD&D.
-- Espejo de db/migraciones/2026-10-07-codigo-postal.sql (los 1.122 códigos son
-- datos y viven solo en la migración) y 2026-10-07-radicados.sql.
-- ============================================================================
ALTER TABLE sst.municipios ADD COLUMN IF NOT EXISTS codigo_postal TEXT;
ALTER TABLE sst.terceros   ADD COLUMN IF NOT EXISTS codigo_postal TEXT;
ALTER TABLE sst.emisor     ADD COLUMN IF NOT EXISTS codigo_postal TEXT;

-- Cada radicado de una orden es una fila; el vigente es el más reciente y la orden
-- guarda una copia para pintarlo en la bandeja sin abrir nada.
CREATE TABLE IF NOT EXISTS sst.orden_radicados (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  orden_id       UUID NOT NULL REFERENCES sst.ordenes_servicio(id) ON DELETE CASCADE,
  numero         TEXT NOT NULL CHECK (btrim(numero) <> ''),
  fecha          DATE,
  aprobado       BOOLEAN NOT NULL DEFAULT false,
  creado_por     UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orden_radicados_orden ON sst.orden_radicados (orden_id, creado_en DESC);
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS radicado_fecha    DATE;
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS radicado_aprobado BOOLEAN NOT NULL DEFAULT false;
