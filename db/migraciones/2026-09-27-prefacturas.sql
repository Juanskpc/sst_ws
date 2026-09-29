-- Tanda 0 de correcciones (27-sep-2026) · ficha T0-09: cargar la prefactura de
-- Bolívar con IA y previsualizar antes de aplicar.
--
-- Dos tablas nuevas, sin tocar ninguna existente:
--   · sst.prefacturas: el encabezado del PDF (n.º, plan, fecha de corte, valor,
--     archivo, quién y cuándo la cargó). `numero_prefactura` es ÚNICO: cargar el
--     mismo PDF dos veces no duplica la prefactura.
--   · sst.prefactura_filas: una fila por orden que trajo la prefactura,
--     identificada por (codigo_cronograma, secuencia) — como en Bolívar no hay
--     `numero_orden`, es la misma pareja que identifica la OS en
--     `sst.ordenes_servicio`. `orden_id` queda NULL si no cruzó con ninguna OS
--     de Orbita (la prefactura trae órdenes de otros proveedores, no solo JD&D).
--
-- Es ADITIVO: no toca `ordenes_servicio` ni ninguna vista. No usa
-- `npm run migrate` (trampa 86).
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-09-27-prefacturas.sql

BEGIN;

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
  aplicada           BOOLEAN NOT NULL DEFAULT FALSE,
  creado_en          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_prefactura_filas_fila
  ON sst.prefactura_filas(prefactura_id, codigo_cronograma, secuencia);
CREATE INDEX IF NOT EXISTS idx_prefactura_filas_orden ON sst.prefactura_filas(orden_id);

COMMIT;
