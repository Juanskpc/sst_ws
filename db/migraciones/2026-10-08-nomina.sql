-- 8-oct-2026 · A5-01 · Nómina electrónica: empleados y liquidaciones mensuales.
--
-- `sst.empleados` es la ficha laboral de un TERCERO (la persona ya vive en Terceros con
-- su documento, dirección y municipio; aquí va solo lo del contrato y cómo se le paga).
-- `sst.nomina_liquidaciones` guarda una liquidación por empleado y mes: las novedades que
-- se escribieron, el resultado de `nomina/calculo.js` congelado y lo que respondió la DIAN.
-- No usa `documentos_electronicos`: la nómina no tiene ítems, impuestos ni cartera.
--
-- Aditivo e idempotente.
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-10-08-nomina.sql
BEGIN;

CREATE TABLE IF NOT EXISTS sst.empleados (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tercero_id         UUID NOT NULL UNIQUE REFERENCES sst.terceros(id),
  cargo              TEXT,
  salario            NUMERIC(16,2) NOT NULL CHECK (salario > 0),
  salario_integral   BOOLEAN NOT NULL DEFAULT false,
  -- Códigos de las tablas de la nómina electrónica (ver nomina/catalogos.js).
  tipo_contrato      TEXT NOT NULL DEFAULT '2' CHECK (tipo_contrato IN ('1', '2', '3', '4', '5')),
  tipo_trabajador    TEXT NOT NULL DEFAULT '01',
  subtipo_trabajador TEXT NOT NULL DEFAULT '00' CHECK (subtipo_trabajador IN ('00', '01')),
  alto_riesgo        BOOLEAN NOT NULL DEFAULT false,
  fecha_ingreso      DATE NOT NULL,
  fecha_retiro       DATE,
  -- Cómo se le paga: 10 efectivo, 42 consignación, 47 transferencia. Los dos últimos exigen la cuenta.
  metodo_pago        TEXT NOT NULL DEFAULT '47' CHECK (metodo_pago IN ('10', '42', '47')),
  banco              TEXT,
  tipo_cuenta        TEXT CHECK (tipo_cuenta IN ('1', '2', '3')),  -- 1 nómina, 2 ahorros, 3 corriente
  numero_cuenta      TEXT,
  -- Informativo (no viaja en el documento electrónico): a dónde se le aporta.
  eps                TEXT,
  fondo_pension      TEXT,
  fondo_cesantias    TEXT,
  arl                TEXT,
  caja_compensacion  TEXT,
  activo             BOOLEAN NOT NULL DEFAULT true,
  creado_por         UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL,
  actualizado_por    UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL,
  creado_en          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT empleados_cuenta_si_no_es_efectivo CHECK (
    metodo_pago = '10' OR (banco IS NOT NULL AND tipo_cuenta IS NOT NULL AND numero_cuenta IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS sst.nomina_liquidaciones (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empleado_id         UUID NOT NULL REFERENCES sst.empleados(id),
  anio                SMALLINT NOT NULL CHECK (anio BETWEEN 2020 AND 2100),
  mes                 SMALLINT NOT NULL CHECK (mes BETWEEN 1 AND 12),
  estado              TEXT NOT NULL DEFAULT 'BORRADOR'
                        CHECK (estado IN ('BORRADOR', 'ENVIANDO', 'VALIDADO', 'RECHAZADO', 'ANULADO')),
  -- El salario del mes liquidado: la ficha del empleado puede cambiar después.
  salario             NUMERIC(16,2) NOT NULL,
  salario_integral    BOOLEAN NOT NULL DEFAULT false,
  -- Lo que escribió quien liquida (horas extra, vacaciones, licencias, prima…).
  novedades           JSONB NOT NULL DEFAULT '{}',
  -- El resultado de calculo.js en el momento de guardar (lo que se emite).
  liquidacion         JSONB NOT NULL,
  dias_trabajados     NUMERIC(5,2) NOT NULL,
  total_devengado     NUMERIC(16,2) NOT NULL,
  total_deducido      NUMERIC(16,2) NOT NULL,
  neto                NUMERIC(16,2) NOT NULL,
  fecha_pago          DATE NOT NULL,
  observaciones       TEXT,
  -- Emisión ante la DIAN. La referencia es la clave de idempotencia frente al proveedor:
  -- un reintento usa la MISMA; tras un rechazo se genera otra.
  reference_code      TEXT UNIQUE,
  numero              TEXT,
  cune                TEXT,
  qr_url              TEXT,
  errores             JSONB,
  respuesta_proveedor JSONB,
  validada_en         TIMESTAMPTZ,
  -- Nota de ajuste de eliminación (anula la nómina validada).
  nota_reference_code TEXT UNIQUE,
  nota_numero         TEXT,
  nota_cune           TEXT,
  anulada_en          TIMESTAMPTZ,
  creado_por          UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL,
  actualizado_por     UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL,
  creado_en           TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Una sola liquidación viva por empleado y mes (las anuladas no cuentan: se vuelve a liquidar).
CREATE UNIQUE INDEX IF NOT EXISTS uq_nomina_empleado_periodo
  ON sst.nomina_liquidaciones (empleado_id, anio, mes) WHERE estado <> 'ANULADO';
CREATE INDEX IF NOT EXISTS idx_nomina_periodo ON sst.nomina_liquidaciones (anio, mes);

DO $$ BEGIN
  CREATE TRIGGER trg_empleados_tocar BEFORE UPDATE ON sst.empleados
    FOR EACH ROW EXECUTE FUNCTION sst.fn_tocar_actualizado_en();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER trg_nomina_liquidaciones_tocar BEFORE UPDATE ON sst.nomina_liquidaciones
    FOR EACH ROW EXECUTE FUNCTION sst.fn_tocar_actualizado_en();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Vista «Nómina» del menú de Finanzas, con el mismo reparto que Facturación.
INSERT INTO sst.permisos_rol (rol, vista, permitido) VALUES
  ('admin',          'nomina', TRUE),
  ('contador',       'nomina', TRUE),
  ('auditor',        'nomina', TRUE),
  ('administrativo', 'nomina', FALSE)
ON CONFLICT (rol, vista) DO NOTHING;

COMMIT;
