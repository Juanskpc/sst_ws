-- 29-sep-2026 · Fase B · B0-01 · Plan de cuentas (CNT-01).
--
-- El PUC de la empresa: el árbol clase (1 dígito) → grupo (2) → cuenta (4) →
-- subcuenta (6) → auxiliar (8 o más). El nivel ES la longitud del código: así lo
-- numera Siigo (13050501, 2510100101) y así lo lee la contadora, sin una columna
-- aparte que se pueda desincronizar.
--
-- Solo las cuentas con `acepta_movimiento` reciben asientos (B1-01). Una cuenta
-- con movimientos no se borra: se inactiva.
--
-- ADITIVO e idempotente.
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-09-29-plan-de-cuentas.sql

BEGIN;

CREATE TABLE IF NOT EXISTS sst.cuentas_contables (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo             TEXT NOT NULL CHECK (codigo ~ '^[0-9]{1,10}$'),
  nombre             TEXT NOT NULL CHECK (btrim(nombre) <> ''),
  naturaleza         TEXT NOT NULL CHECK (naturaleza IN ('DEBITO', 'CREDITO')),
  nivel              SMALLINT GENERATED ALWAYS AS (length(codigo)) STORED,
  padre_id           UUID REFERENCES sst.cuentas_contables(id),
  acepta_movimiento  BOOLEAN NOT NULL DEFAULT false,
  exige_tercero      BOOLEAN NOT NULL DEFAULT false,
  exige_centro_costo BOOLEAN NOT NULL DEFAULT false,
  -- La cuenta que lleva la cartera: su saldo se concilia con la de CXC/CXP (B3/B4).
  es_cartera         TEXT CHECK (es_cartera IN ('CXC', 'CXP')),
  es_banco           BOOLEAN NOT NULL DEFAULT false,
  -- Renglón de los estados financieros (C5-01); vacío hasta que la contadora lo defina.
  renglon_esf        TEXT,
  renglon_er         TEXT,
  activa             BOOLEAN NOT NULL DEFAULT true,
  creado_por         UUID REFERENCES sst.usuarios(id),
  actualizado_por    UUID REFERENCES sst.usuarios(id),
  creado_en          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Solo las clases (1 dígito) no tienen padre; todo lo demás cuelga de una cuenta.
  CONSTRAINT chk_cuentas_padre CHECK ((length(codigo) = 1) = (padre_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cuentas_contables_codigo ON sst.cuentas_contables (codigo);
CREATE INDEX IF NOT EXISTS idx_cuentas_contables_padre ON sst.cuentas_contables (padre_id);

DO $$ BEGIN
  CREATE TRIGGER trg_cuentas_contables_tocar BEFORE UPDATE ON sst.cuentas_contables
    FOR EACH ROW EXECUTE FUNCTION sst.fn_tocar_actualizado_en();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- La pantalla de Contabilidad en la matriz de Roles y permisos. Mismo reparto que
-- las demás de Finanzas: admin, contador y auditor sí; administrativo no.
INSERT INTO sst.permisos_rol (rol, vista, permitido) VALUES
  ('admin',          'contabilidad', TRUE),
  ('contador',       'contabilidad', TRUE),
  ('auditor',        'contabilidad', TRUE),
  ('administrativo', 'contabilidad', FALSE)
ON CONFLICT (rol, vista) DO NOTHING;

COMMIT;
