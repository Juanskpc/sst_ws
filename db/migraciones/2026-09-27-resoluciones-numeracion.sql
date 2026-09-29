-- Fase A · facturación · A0-08 · resoluciones de numeración (27-sep-2026).
--
-- Solo el cambio (no correr `npm run migrate` entero: trampa 86). Aditivo: una
-- tabla nueva.
--
-- Las resoluciones reales de JD&D NO se siembran (riesgo R-01: la de factura
-- vence el 11-oct-2026 y hay que asociar la vigente al proveedor nuevo). Las
-- trae el botón "Sincronizar con el proveedor" de GET /v2/numbering-ranges.
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-09-27-resoluciones-numeracion.sql

BEGIN;

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

COMMIT;
