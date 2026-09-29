-- Fase A · facturación · A0-05 · terceros (27-sep-2026).
--
-- Solo el cambio (no correr `npm run migrate` entero: trampa 86).
--
-- Es ADITIVO: dos tablas nuevas y tres columnas NULL (`tercero_id`) en `arls`,
-- `empresas` y `profesionales`. Trampa 69 revisada: ninguna vista lee esas tres
-- tablas con `*` (`vw_ordenes_expandidas` es `SELECT o.*` sobre órdenes y
-- nombra una a una las columnas que toma de `arls`/`profesionales`), así que no
-- hay vistas que rehacer.
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-09-27-terceros.sql

BEGIN;

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
-- Los cuatro booleanos de rol NO son excluyentes: una ARL es cliente Y ARL, y
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

COMMIT;
