-- Fase A · facturación · A0-07 · retenciones, UVT y condiciones por pagador (27-sep-2026).
--
-- Solo el cambio (no correr `npm run migrate` entero: trampa 86). Aditivo: tres
-- tablas nuevas.
--
-- `factus_tributo_id` es el código que Factus v2 pide en `items.*.withholding_taxes[].code`
-- (confirmado en su ejemplo "estandar-autorrentenciones": 05 = Retención sobre el
-- IVA, 06 = Retención sobre renta — tabla "Códigos de retenciones" de su
-- documentación). El ReteICA NO tiene código ahí: Factus no lo modela porque se
-- practica AL PAGAR, no en la factura (confirma lo que ya decía §3.5 del plan);
-- por eso su fila queda con `factus_tributo_id NULL` a propósito, nunca se manda
-- en el XML y solo sirve para calcular el recibo de caja (Fase B).
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-09-27-retenciones-condiciones.sql

BEGIN;

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

COMMIT;
