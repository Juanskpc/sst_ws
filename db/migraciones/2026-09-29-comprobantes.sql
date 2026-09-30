-- 29-sep-2026 · Fase B · B1-01 · Motor de comprobantes (CNT-02, CNT-03).
--
-- El libro diario: cada hecho contable es un COMPROBANTE (tipo + consecutivo) con
-- sus MOVIMIENTOS (cuenta, tercero, débito o crédito). Toda cifra contable de
-- Orbita sale de aquí (§5.1 del plan: libro único).
--
-- Reglas duras, en el servicio Y en la base (la base es la última defensa, por si
-- un día un script escribe directo):
--   · un comprobante CONTABILIZADO cuadra: débitos = créditos, y tiene ≥ 2 líneas;
--   · cada línea va a una cuenta activa que recibe movimiento, con tercero si la
--     cuenta lo exige, y lleva débito O crédito, nunca los dos;
--   · no se contabiliza ni se anula en un periodo CERRADO;
--   · lo contabilizado no se edita: se anula (queda el número usado) y se hace otro.
-- El cuadre se verifica AL COMMIT (trigger diferido): las líneas se insertan una a
-- una y a mitad de camino el comprobante todavía no cuadra.
--
-- ADITIVO e idempotente.
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-09-29-comprobantes.sql

BEGIN;

-- Tipos de comprobante con su consecutivo. Los códigos son los que ya usa la
-- contadora en Siigo (FV-1-809, RC-1-101…). `manual` = se puede crear a mano
-- desde la pantalla; los demás los produce el sistema (B2-01 en adelante).
CREATE TABLE IF NOT EXISTS sst.tipos_comprobante (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo             TEXT NOT NULL UNIQUE CHECK (codigo ~ '^[A-Z]{2,4}$'),
  nombre             TEXT NOT NULL,
  consecutivo_actual INTEGER NOT NULL DEFAULT 0 CHECK (consecutivo_actual >= 0),
  manual             BOOLEAN NOT NULL DEFAULT false,
  activo             BOOLEAN NOT NULL DEFAULT true,
  creado_en          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO sst.tipos_comprobante (codigo, nombre, manual) VALUES
  ('FV', 'Factura de venta', false),
  ('NC', 'Nota crédito', false),
  ('DS', 'Documento soporte', false),
  ('NA', 'Nota de ajuste al documento soporte', false),
  ('RC', 'Recibo de caja', false),
  ('CE', 'Comprobante de egreso', false),
  ('RP', 'Anticipo a proveedores', false),
  ('FC', 'Factura de compra', false),
  ('CG', 'Comprobante de gasto interno', false),
  ('NI', 'Nota interna', true),
  ('NM', 'Nómina', false),
  ('SI', 'Saldos iniciales', false),
  ('CA', 'Cierre anual', false),
  ('DP', 'Depreciación', false)
ON CONFLICT (codigo) DO NOTHING;

-- Periodos contables (mes a mes). Un mes sin fila está ABIERTO: la fila nace al
-- cerrarlo por primera vez, así no hay que sembrar años por adelantado.
CREATE TABLE IF NOT EXISTS sst.periodos_contables (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  anio           SMALLINT NOT NULL CHECK (anio BETWEEN 2000 AND 2100),
  mes            SMALLINT NOT NULL CHECK (mes BETWEEN 1 AND 12),
  estado         TEXT NOT NULL DEFAULT 'ABIERTO' CHECK (estado IN ('ABIERTO', 'CERRADO')),
  cerrado_por    UUID REFERENCES sst.usuarios(id),
  cerrado_en     TIMESTAMPTZ,
  -- Reabrir un mes cerrado es excepcional (solo admin) y siempre deja el motivo.
  reabierto_por  UUID REFERENCES sst.usuarios(id),
  reabierto_en   TIMESTAMPTZ,
  motivo_reapertura TEXT,
  UNIQUE (anio, mes)
);

CREATE TABLE IF NOT EXISTS sst.comprobantes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo_id         UUID NOT NULL REFERENCES sst.tipos_comprobante(id),
  -- El consecutivo se asigna al CONTABILIZAR (un borrador no gasta número); el
  -- anulado conserva el suyo, así la numeración no tiene huecos.
  numero          INTEGER,
  fecha           DATE NOT NULL,
  anio            SMALLINT GENERATED ALWAYS AS (EXTRACT(YEAR FROM fecha)::smallint) STORED,
  mes             SMALLINT GENERATED ALWAYS AS (EXTRACT(MONTH FROM fecha)::smallint) STORED,
  descripcion     TEXT,
  estado          TEXT NOT NULL DEFAULT 'BORRADOR' CHECK (estado IN ('BORRADOR', 'CONTABILIZADO', 'ANULADO')),
  -- De dónde sale: un documento electrónico, un recibo… (NULL = nota manual).
  origen_tipo     TEXT,
  origen_id       UUID,
  total_debito    NUMERIC(16,2) NOT NULL DEFAULT 0,
  total_credito   NUMERIC(16,2) NOT NULL DEFAULT 0,
  contabilizado_por UUID REFERENCES sst.usuarios(id),
  contabilizado_en  TIMESTAMPTZ,
  anulado_por     UUID REFERENCES sst.usuarios(id),
  anulado_en      TIMESTAMPTZ,
  motivo_anulacion TEXT,
  creado_por      UUID REFERENCES sst.usuarios(id),
  actualizado_por UUID REFERENCES sst.usuarios(id),
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_comprobante_numero CHECK ((estado = 'BORRADOR') = (numero IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_comprobantes_tipo_numero ON sst.comprobantes (tipo_id, numero) WHERE numero IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_comprobantes_fecha ON sst.comprobantes (fecha);
CREATE INDEX IF NOT EXISTS idx_comprobantes_origen ON sst.comprobantes (origen_tipo, origen_id) WHERE origen_id IS NOT NULL;
-- Un documento se contabiliza una sola vez (lo anulado no cuenta: se puede rehacer).
CREATE UNIQUE INDEX IF NOT EXISTS uq_comprobantes_origen_vigente
  ON sst.comprobantes (origen_tipo, origen_id) WHERE origen_id IS NOT NULL AND estado <> 'ANULADO';

CREATE TABLE IF NOT EXISTS sst.movimientos (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  comprobante_id   UUID NOT NULL REFERENCES sst.comprobantes(id) ON DELETE CASCADE,
  linea            SMALLINT NOT NULL CHECK (linea > 0),
  cuenta_id        UUID NOT NULL REFERENCES sst.cuentas_contables(id),
  tercero_id       UUID REFERENCES sst.terceros(id),
  -- El maestro de centros de costo llega con B8-01; la FK se añade entonces.
  centro_costo_id  UUID,
  debito           NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (debito >= 0),
  credito          NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (credito >= 0),
  -- Base de la retención o del impuesto, cuando la línea es uno (la pide el auxiliar).
  base             NUMERIC(16,2),
  descripcion      TEXT,
  -- Documento con el que se cruza (FE-809, DS-1-1316): la cartera y el auxiliar lo muestran.
  documento_cruce    TEXT,
  documento_cruce_id UUID,
  CONSTRAINT chk_movimiento_un_lado CHECK ((debito > 0) <> (credito > 0)),
  UNIQUE (comprobante_id, linea)
);
CREATE INDEX IF NOT EXISTS idx_movimientos_cuenta ON sst.movimientos (cuenta_id);
CREATE INDEX IF NOT EXISTS idx_movimientos_tercero ON sst.movimientos (tercero_id) WHERE tercero_id IS NOT NULL;

DO $$ BEGIN
  CREATE TRIGGER trg_tipos_comprobante_tocar BEFORE UPDATE ON sst.tipos_comprobante
    FOR EACH ROW EXECUTE FUNCTION sst.fn_tocar_actualizado_en();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER trg_comprobantes_tocar BEFORE UPDATE ON sst.comprobantes
    FOR EACH ROW EXECUTE FUNCTION sst.fn_tocar_actualizado_en();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ¿Está cerrado el mes? (sin fila = abierto).
CREATE OR REPLACE FUNCTION sst.fn_periodo_cerrado(p_fecha DATE) RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM sst.periodos_contables
     WHERE anio = EXTRACT(YEAR FROM p_fecha) AND mes = EXTRACT(MONTH FROM p_fecha) AND estado = 'CERRADO'
  );
$$ LANGUAGE sql STABLE;

-- Lo contabilizado o anulado no se toca: ni sus líneas, ni su fecha, ni su tipo.
-- Las únicas transiciones válidas son BORRADOR → CONTABILIZADO → ANULADO.
CREATE OR REPLACE FUNCTION sst.fn_movimientos_inmutables() RETURNS trigger AS $$
DECLARE
  v_estado TEXT;
BEGIN
  SELECT estado INTO v_estado FROM sst.comprobantes
   WHERE id = COALESCE(NEW.comprobante_id, OLD.comprobante_id);
  -- Borrar el comprobante arrastra sus líneas (CASCADE): ahí ya no existe la fila.
  IF v_estado IS NOT NULL AND v_estado <> 'BORRADOR' THEN
    RAISE EXCEPTION 'El comprobante ya está % : sus movimientos no se modifican (anúlelo y haga otro).', lower(v_estado)
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER trg_movimientos_inmutables BEFORE INSERT OR UPDATE OR DELETE ON sst.movimientos
    FOR EACH ROW EXECUTE FUNCTION sst.fn_movimientos_inmutables();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

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

DO $$ BEGIN
  CREATE TRIGGER trg_comprobante_transicion BEFORE UPDATE OR DELETE ON sst.comprobantes
    FOR EACH ROW EXECUTE FUNCTION sst.fn_comprobante_transicion();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Cuadre y validez de un comprobante CONTABILIZADO, al commit.
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
  IF sst.fn_periodo_cerrado(c.fecha) THEN
    RAISE EXCEPTION 'El periodo %-% está cerrado.', c.anio, lpad(c.mes::text, 2, '0') USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE CONSTRAINT TRIGGER trg_validar_comprobante AFTER INSERT OR UPDATE ON sst.comprobantes
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sst.fn_validar_comprobante();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE CONSTRAINT TRIGGER trg_validar_movimientos AFTER INSERT OR UPDATE OR DELETE ON sst.movimientos
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sst.fn_validar_comprobante();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
