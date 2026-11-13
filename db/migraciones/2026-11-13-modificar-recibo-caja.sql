-- 13-nov-2026 · Modificar un recibo de caja CONSERVANDO su número (pedido de la contadora).
--
-- Hasta hoy un comprobante contabilizado no se tocaba: se anulaba y se hacía otro. Para
-- los recibos de caja (como en Siigo) ahora se puede reescribir en el sitio: cliente,
-- fecha, cuenta donde entró la plata, facturas, valores y retenciones. El RC conserva
-- su número; el cambio queda registrado en sst.recibos_caja_cambios (antes y después).
--
-- La excepción es estrecha y la decide el servidor, no la base: solo vale dentro de una
-- transacción que marcó ESE comprobante con
--     SELECT set_config('sst.reescribir_comprobante', '<id>', true)
-- y solo para comprobantes de origen RECIBO_CAJA, que siguen CONTABILIZADOS, con el
-- mismo tipo y número, y con el mes viejo y el nuevo abiertos. El cuadre y la validez
-- de las líneas los sigue comprobando el trigger diferido al commit.
--
-- ADITIVO e idempotente.
--   psql "$DATABASE_URL" -f db/migraciones/2026-11-13-modificar-recibo-caja.sql
BEGIN;

ALTER TABLE sst.recibos_caja ADD COLUMN IF NOT EXISTS modificado_por UUID REFERENCES sst.usuarios(id);
ALTER TABLE sst.recibos_caja ADD COLUMN IF NOT EXISTS modificado_en  TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS sst.recibos_caja_cambios (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recibo_id   UUID NOT NULL REFERENCES sst.recibos_caja(id),
  usuario_id  UUID REFERENCES sst.usuarios(id),
  motivo      TEXT,
  antes       JSONB NOT NULL,
  despues     JSONB NOT NULL,
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recibos_caja_cambios_recibo ON sst.recibos_caja_cambios (recibo_id, creado_en DESC);

-- ¿Esta transacción está reescribiendo ESE comprobante de recibo?
CREATE OR REPLACE FUNCTION sst.fn_reescritura_permitida(p_id UUID) RETURNS BOOLEAN AS $$
  SELECT COALESCE(current_setting('sst.reescribir_comprobante', true), '') = p_id::text
     AND EXISTS (SELECT 1 FROM sst.comprobantes WHERE id = p_id AND origen_tipo = 'RECIBO_CAJA');
$$ LANGUAGE sql STABLE;

-- Igual que la del 29-sep, más la excepción del recibo que se está modificando.
CREATE OR REPLACE FUNCTION sst.fn_movimientos_inmutables() RETURNS trigger AS $$
DECLARE
  v_estado TEXT;
  v_id     UUID := COALESCE(NEW.comprobante_id, OLD.comprobante_id);
BEGIN
  SELECT estado INTO v_estado FROM sst.comprobantes WHERE id = v_id;
  -- Borrar el comprobante arrastra sus líneas (CASCADE): ahí ya no existe la fila.
  IF v_estado IS NOT NULL AND v_estado <> 'BORRADOR' THEN
    IF v_estado = 'CONTABILIZADO' AND sst.fn_reescritura_permitida(v_id) THEN
      RETURN COALESCE(NEW, OLD);
    END IF;
    RAISE EXCEPTION 'El comprobante ya está % : sus movimientos no se modifican (anúlelo y haga otro).', lower(v_estado)
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sst.fn_comprobante_transicion() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.estado <> 'BORRADOR' THEN
      RAISE EXCEPTION 'Un comprobante % no se borra: se anula.', lower(OLD.estado) USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.estado = 'ANULADO' THEN
    RAISE EXCEPTION 'El comprobante está anulado y no admite cambios.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.estado = 'CONTABILIZADO' THEN
    -- 13-nov-2026 · Recibo de caja que se modifica: sigue contabilizado, con su tipo y su número.
    IF NEW.estado = 'CONTABILIZADO' AND NEW.tipo_id = OLD.tipo_id AND NEW.numero IS NOT DISTINCT FROM OLD.numero
       AND sst.fn_reescritura_permitida(OLD.id) THEN
      IF sst.fn_periodo_cerrado(OLD.fecha) OR sst.fn_periodo_cerrado(NEW.fecha) THEN
        RAISE EXCEPTION 'El periodo está cerrado: el recibo no se puede modificar.' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.estado <> 'ANULADO'
       OR NEW.fecha <> OLD.fecha OR NEW.tipo_id <> OLD.tipo_id OR NEW.numero IS DISTINCT FROM OLD.numero
       OR NEW.total_debito <> OLD.total_debito OR NEW.total_credito <> OLD.total_credito THEN
      RAISE EXCEPTION 'Un comprobante contabilizado no se edita: se anula y se hace otro.' USING ERRCODE = 'check_violation';
    END IF;
    IF sst.fn_periodo_cerrado(OLD.fecha) THEN
      RAISE EXCEPTION 'El periodo %-% está cerrado: no se puede anular.', OLD.anio, lpad(OLD.mes::text, 2, '0')
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
