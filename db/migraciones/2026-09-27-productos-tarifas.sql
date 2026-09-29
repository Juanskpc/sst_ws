-- Fase A · facturación · A0-06 · productos y tarifas de venta (27-sep-2026).
--
-- Solo el cambio (no correr `npm run migrate` entero: trampa 86). Aditivo: dos
-- tablas nuevas. Ni productos ni tarifas se siembran aquí: se cargan desde la
-- pantalla de Parametrización (A0-10), como dice la ficha.
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-09-27-productos-tarifas.sql

BEGIN;

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

COMMIT;
