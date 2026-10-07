-- Fase A · A4-01 · Documento soporte desde la cuenta de cobro (7-oct-2026).
--
-- Aditivo. El documento soporte ya cabía en sst.documentos_electronicos (tipo
-- DOC_SOPORTE desde A1-01); falta saber de qué cuenta de cobro sale y la pantalla
-- en la matriz de Roles y permisos.
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-10-07-documento-soporte.sql

BEGIN;

-- La cuenta de cobro aceptada que respalda el documento soporte. SET NULL y no
-- CASCADE: un documento ya validado ante la DIAN no puede desaparecer porque se
-- borre la cuenta.
ALTER TABLE sst.documentos_electronicos
  ADD COLUMN IF NOT EXISTS precuenta_id UUID REFERENCES sst.precuentas(id) ON DELETE SET NULL;

-- Un solo documento soporte vivo por cuenta de cobro: dos borradores en paralelo
-- llevarían el mismo costo dos veces a la DIAN. ANULADO libera la cuenta (lo
-- hará la nota de ajuste, A4-03).
CREATE UNIQUE INDEX IF NOT EXISTS uq_documento_soporte_precuenta
  ON sst.documentos_electronicos (precuenta_id)
  WHERE tipo = 'DOC_SOPORTE' AND precuenta_id IS NOT NULL AND estado <> 'ANULADO';

-- Pantalla «Documentos soporte»: el mismo reparto que Facturación.
INSERT INTO sst.permisos_rol (rol, vista, permitido) VALUES
  ('admin',          'documentos_soporte', TRUE),
  ('contador',       'documentos_soporte', TRUE),
  ('auditor',        'documentos_soporte', TRUE),
  ('administrativo', 'documentos_soporte', FALSE)
ON CONFLICT (rol, vista) DO NOTHING;

COMMIT;
