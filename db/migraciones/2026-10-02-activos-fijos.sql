-- Fase C · C7-01 (ACT-01..03) · Activos fijos, depreciación mensual y QR.
-- Solo el cambio; el mismo bloque está en db/schema.sql. Idempotente.
--
-- Registrar el activo NO genera asiento: la compra ya se contabilizó (Compras,
-- B5-01). Lo que contabiliza este módulo es la depreciación: un comprobante DP
-- por mes, D gasto / C depreciación acumulada, con las cuentas que la contadora
-- elige en cada ficha (nada de cuentas en duro).
BEGIN;

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

COMMIT;
