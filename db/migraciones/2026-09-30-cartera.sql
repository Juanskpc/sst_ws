-- 30-sep-2026 · Fase B · B3-01 · Cuentas por cobrar y recibos de caja (CXC-01..04, CNT-05).
--
-- La cartera lleva, factura por factura, cuánto se debe. Nace con cada factura
-- contabilizada (también las "de contado": su asiento va igual a 13050501 y se
-- cancela con el recibo, como en Siigo) y baja con las notas crédito y los
-- recibos de caja. Su saldo total tiene que cuadrar con el de la cuenta de
-- clientes (conciliación de la pantalla).
--
-- El recibo de caja aplica lo consignado a una o varias facturas, y por cada una
-- lo que el pagador RETUVO al pagar (ReteICA, a veces retefuente): esa diferencia
-- va a una cuenta de retención a favor, no queda como saldo pendiente (§3.5,
-- RC-1-97, RC-1-101, RC-1-105).
--
-- ADITIVO e idempotente.
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-09-30-cartera.sql

BEGIN;

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

COMMIT;
