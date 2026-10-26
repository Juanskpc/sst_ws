-- 24-oct-2026 · Cuentas bancarias de los terceros.
--
-- Petición de JD&D: poder guardar en Terceros el banco y la cuenta de cada
-- tercero (sobre todo de los profesionales, a quienes se les paga), y poder
-- eliminar las que ya no sirven: los asesores cambian de cuenta a menudo y no
-- puede quedar más de una «principal» ni cuentas viejas a la vista.
--
-- `sst.bancos` es un catálogo editable de los bancos colombianos más usados.
--
-- ADITIVA e idempotente.
--
--   node scripts/aplicar-migracion.mjs db/migraciones/2026-10-24-terceros-bancos.sql

BEGIN;

CREATE TABLE IF NOT EXISTS sst.bancos (
  id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre  TEXT NOT NULL,
  activo  BOOLEAN NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bancos_nombre ON sst.bancos (lower(btrim(nombre)));

INSERT INTO sst.bancos (nombre) VALUES
  ('Bancolombia'), ('Banco de Bogotá'), ('Davivienda'), ('BBVA Colombia'), ('Banco de Occidente'),
  ('Banco Popular'), ('Banco AV Villas'), ('Banco Caja Social'), ('Itaú'), ('Scotiabank Colpatria'),
  ('Banco Agrario de Colombia'), ('Banco GNB Sudameris'), ('Banco Falabella'), ('Banco Pichincha'),
  ('Bancoomeva'), ('Banco Finandina'), ('Banco Santander'), ('Banco Serfinanza'), ('Banco W'),
  ('Bancamía'), ('Banco Mundo Mujer'), ('Coopcentral'), ('Confiar Cooperativa'),
  ('Nequi'), ('Daviplata'), ('Lulo Bank'), ('Nu Colombia'), ('RappiPay'), ('Movii')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS sst.terceros_cuentas_bancarias (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tercero_id   UUID NOT NULL REFERENCES sst.terceros(id) ON DELETE CASCADE,
  banco_id     UUID NOT NULL REFERENCES sst.bancos(id),
  tipo_cuenta  TEXT NOT NULL DEFAULT 'AHORROS'
                 CHECK (tipo_cuenta IN ('AHORROS', 'CORRIENTE', 'DEPOSITO_ELECTRONICO')),
  numero       TEXT NOT NULL CHECK (numero ~ '^[0-9A-Za-z-]{4,34}$'),
  -- Titular de la cuenta cuando NO es el propio tercero (p. ej. la cuenta de un familiar).
  titular      TEXT,
  principal    BOOLEAN NOT NULL DEFAULT false,
  creado_por   UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL,
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tercero_cuenta_numero
  ON sst.terceros_cuentas_bancarias (tercero_id, banco_id, numero);
-- Una sola principal por tercero.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tercero_cuenta_principal
  ON sst.terceros_cuentas_bancarias (tercero_id) WHERE principal;

COMMIT;
