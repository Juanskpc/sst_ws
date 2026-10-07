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

-- Contabilización del DS (como DS-1-1316 de Siigo): D costo de honorarios por
-- PAGADOR de la orden (73050501 Bolívar, 73050503 AXA, 73050516 Colmena… una regla
-- por tercero pagador) / C 23352501 honorarios por pagar al asesor.
ALTER TABLE sst.reglas_contables DROP CONSTRAINT IF EXISTS reglas_contables_concepto_check;
ALTER TABLE sst.reglas_contables ADD CONSTRAINT reglas_contables_concepto_check CHECK (concepto IN (
  'FV_CXC', 'FV_INGRESO', 'FV_DESCUENTO', 'FV_IVA', 'FV_RETEFUENTE', 'FV_RETEIVA',
  'FV_AUTORRET_DB', 'FV_AUTORRET_CR',
  'NC_CXC', 'NC_DEVOLUCION', 'NC_DESCUENTO', 'NC_IVA', 'NC_RETEFUENTE', 'NC_RETEIVA',
  'CP_CXP', 'CP_CXP_HONORARIOS', 'CP_IVA_DESCONTABLE', 'CE_ANTICIPO',
  'DS_COSTO', 'DS_CXP'));

-- A4-03 · La nota de ajuste baja la cuenta por pagar de su documento soporte,
-- igual que la nota crédito baja la cuenta por cobrar de su factura.
ALTER TABLE sst.cartera_aplicaciones DROP CONSTRAINT IF EXISTS cartera_aplicaciones_origen_tipo_check;
ALTER TABLE sst.cartera_aplicaciones ADD CONSTRAINT cartera_aplicaciones_origen_tipo_check
  CHECK (origen_tipo IN ('NOTA_CREDITO', 'RECIBO_CAJA', 'EGRESO', 'NOTA_AJUSTE'));

-- Pantalla «Documentos soporte»: el mismo reparto que Facturación.
INSERT INTO sst.permisos_rol (rol, vista, permitido) VALUES
  ('admin',          'documentos_soporte', TRUE),
  ('contador',       'documentos_soporte', TRUE),
  ('auditor',        'documentos_soporte', TRUE),
  ('administrativo', 'documentos_soporte', FALSE)
ON CONFLICT (rol, vista) DO NOTHING;

COMMIT;
