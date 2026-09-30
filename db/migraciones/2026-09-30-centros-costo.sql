-- 30-sep-2026 · Fase B · B8-01 · Centros de costo (CNT-09).
--
-- Para controlar los gastos por actividad (honorarios, transporte, materiales…):
-- un maestro sencillo y un campo OPCIONAL en cada movimiento y en cada compra
-- (decisión por defecto D-12 de la v2). Solo es obligatorio en las cuentas que la
-- contadora marque «exige centro de costo»: el servicio lo valida y, como con el
-- tercero, el trigger del comprobante también.
--
-- ADITIVO e idempotente.
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-09-30-centros-costo.sql

BEGIN;

CREATE TABLE IF NOT EXISTS sst.centros_costo (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo          TEXT NOT NULL CHECK (btrim(codigo) <> ''),
  nombre          TEXT NOT NULL CHECK (btrim(nombre) <> ''),
  activo          BOOLEAN NOT NULL DEFAULT true,
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_centros_costo_codigo ON sst.centros_costo (upper(codigo));

DO $$ BEGIN
  CREATE TRIGGER trg_centros_costo_tocar BEFORE UPDATE ON sst.centros_costo
    FOR EACH ROW EXECUTE FUNCTION sst.fn_tocar_actualizado_en();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Las columnas ya existían (B1-01, B5-01) esperando el maestro.
DO $$ BEGIN
  ALTER TABLE sst.movimientos ADD CONSTRAINT fk_movimientos_centro_costo FOREIGN KEY (centro_costo_id) REFERENCES sst.centros_costo(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE sst.compras ADD CONSTRAINT fk_compras_centro_costo FOREIGN KEY (centro_costo_id) REFERENCES sst.centros_costo(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_movimientos_centro_costo ON sst.movimientos (centro_costo_id) WHERE centro_costo_id IS NOT NULL;

-- El cuadre del comprobante, ahora también con el centro de costo obligatorio.
CREATE OR REPLACE FUNCTION sst.fn_validar_comprobante() RETURNS trigger AS $$
DECLARE
  v_id    UUID;
  c       RECORD;
  v_deb   NUMERIC(16,2);
  v_cred  NUMERIC(16,2);
  v_n     INTEGER;
  v_mala  TEXT;
BEGIN
  -- La misma función sirve a las dos tablas; NEW no tiene las mismas columnas en
  -- cada una, así que se lee según cuál disparó (un CASE las evaluaría ambas).
  IF TG_TABLE_NAME = 'comprobantes' THEN
    v_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    v_id := OLD.comprobante_id;
  ELSE
    v_id := NEW.comprobante_id;
  END IF;
  SELECT * INTO c FROM sst.comprobantes WHERE id = v_id;
  -- Solo se valida lo que se está contabilizando (el anulado ya se validó al nacer).
  IF c.id IS NULL OR c.estado <> 'CONTABILIZADO' THEN RETURN NULL; END IF;
  -- Anidado a propósito: PL/pgSQL no corta el AND, y OLD de un movimiento no tiene `estado`.
  IF TG_TABLE_NAME = 'comprobantes' AND TG_OP = 'UPDATE' THEN
    IF OLD.estado = 'CONTABILIZADO' THEN RETURN NULL; END IF;
  END IF;

  SELECT COALESCE(sum(debito), 0), COALESCE(sum(credito), 0), count(*) INTO v_deb, v_cred, v_n
    FROM sst.movimientos WHERE comprobante_id = v_id;
  IF v_n < 2 THEN
    RAISE EXCEPTION 'El comprobante necesita al menos dos movimientos.' USING ERRCODE = 'check_violation';
  END IF;
  IF v_deb <> v_cred THEN
    RAISE EXCEPTION 'El comprobante no cuadra: débitos % ≠ créditos %.', v_deb, v_cred USING ERRCODE = 'check_violation';
  END IF;
  IF v_deb <> c.total_debito OR v_cred <> c.total_credito THEN
    RAISE EXCEPTION 'Los totales guardados del comprobante no coinciden con sus movimientos.' USING ERRCODE = 'check_violation';
  END IF;

  SELECT cc.codigo INTO v_mala FROM sst.movimientos m JOIN sst.cuentas_contables cc ON cc.id = m.cuenta_id
   WHERE m.comprobante_id = v_id AND (NOT cc.acepta_movimiento OR NOT cc.activa) LIMIT 1;
  IF v_mala IS NOT NULL THEN
    RAISE EXCEPTION 'La cuenta % no recibe movimiento (o está inactiva).', v_mala USING ERRCODE = 'check_violation';
  END IF;
  SELECT cc.codigo INTO v_mala FROM sst.movimientos m JOIN sst.cuentas_contables cc ON cc.id = m.cuenta_id
   WHERE m.comprobante_id = v_id AND cc.exige_tercero AND m.tercero_id IS NULL LIMIT 1;
  IF v_mala IS NOT NULL THEN
    RAISE EXCEPTION 'La cuenta % exige tercero.', v_mala USING ERRCODE = 'check_violation';
  END IF;
  -- B8-01 · La cuenta marcada "exige centro de costo" no admite una línea sin él.
  SELECT cc.codigo INTO v_mala FROM sst.movimientos m JOIN sst.cuentas_contables cc ON cc.id = m.cuenta_id
   WHERE m.comprobante_id = v_id AND cc.exige_centro_costo AND m.centro_costo_id IS NULL LIMIT 1;
  IF v_mala IS NOT NULL THEN
    RAISE EXCEPTION 'La cuenta % exige centro de costo.', v_mala USING ERRCODE = 'check_violation';
  END IF;
  IF sst.fn_periodo_cerrado(c.fecha) THEN
    RAISE EXCEPTION 'El periodo %-% está cerrado.', c.anio, lpad(c.mes::text, 2, '0') USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

COMMIT;
