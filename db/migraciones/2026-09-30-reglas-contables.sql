-- 30-sep-2026 · Fase B · B2-01 · Reglas de contabilización (CNT-13, FEL-18).
--
-- Qué cuenta usa cada concepto de un documento (el total por cobrar, el ingreso de
-- cada ítem, el IVA, la retención…). Es lo que hoy decide Siigo por dentro; aquí
-- queda en una tabla que la contadora edita. Una regla puede ser GENERAL o
-- específica de un producto o de un tercero (la más específica gana), p. ej. el
-- ingreso de cierto servicio a otra cuenta.
--
-- Las reglas NO se siembran aquí: dependen de que el plan de cuentas exista, y en
-- producción todavía no está cargado. Se cargan con "Cargar las reglas de Siigo"
-- en la pantalla (POST /contabilidad/reglas/por-defecto), que usa las cuentas de
-- §3.5 del plan que ya existan.
--
-- ADITIVO e idempotente.
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-09-30-reglas-contables.sql

BEGIN;

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

COMMIT;
