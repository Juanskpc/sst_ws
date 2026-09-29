-- Fase A · facturación · A0-04 · catálogos DIAN (27-sep-2026).
--
-- Solo el cambio, como las migraciones anteriores: NO correr `npm run migrate`
-- entero (siembra datos inventados y reescribe la cuenta admin, trampa 86).
--
-- Es ADITIVO: ocho tablas nuevas, ninguna existente se toca, así que no hay que
-- rehacer vistas (trampa 69). Las tablas nacen vacías: se llenan con
-- `node scripts/sembrar-catalogos-dian.mjs`.
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-09-27-catalogos-dian.sql

BEGIN;

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

COMMIT;
