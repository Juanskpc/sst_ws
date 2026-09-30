-- 30-sep-2026 · Fase B · B5-01 + B4-01 · Compras y gastos, cuentas por pagar,
-- anticipos y comprobantes de egreso (CYG-01..03, CXP-01..04, CNT-04).
--
-- Una compra (factura de proveedor, servicio, honorarios o un gasto interno que no
-- va a la DIAN) se contabiliza al registrarla (FC; el gasto interno, CG) y, si es a
-- crédito, abre su cuenta por pagar. El egreso (CE) la paga — total o parcial,
-- descontando lo que JD&D le retiene y cruzando anticipos —; el anticipo (RP) es
-- plata que se le entrega antes al proveedor.
--
-- Asientos que ya usa Siigo: FC-1-10 (gasto 51953501 D / 23359501 C) y RP-1-2
-- (13300501 D / banco C). En septiembre no hubo egresos: el CE sigue el espejo del
-- recibo de caja.
--
-- ADITIVO e idempotente.
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-09-30-compras-cxp.sql

BEGIN;

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

COMMIT;
