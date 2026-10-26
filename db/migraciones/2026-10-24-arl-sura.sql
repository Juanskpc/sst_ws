-- 24-oct-2026 · ARL SURA entra al sistema como cuarta ARL.
--
-- Su orden no llega como documento: el distribuidor descarga de la plataforma de
-- Sura un Excel con todas las tareas («Reporte estado de las tareas», 21
-- columnas), que se importa como el SIPAB de Bolívar. Los formatos son el
-- registro de asistencia (capacitaciones) y el modelo de informe (asesorías).
--
-- Además, el registro de asistencia de Sura pide la CÉDULA del asesor: se guarda
-- en la ficha del profesional (si tiene usuario enlazado se usa la de su cuenta
-- cuando esta columna está vacía).
--
-- ADITIVA e idempotente.
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-10-24-arl-sura.sql

BEGIN;
INSERT INTO sst.arls (nombre, formato_origen) VALUES ('ARL SURA', 'excel')
ON CONFLICT (nombre) DO NOTHING;

ALTER TABLE sst.profesionales ADD COLUMN IF NOT EXISTS documento_identidad TEXT;

-- Si el tercero «Seguros de Riesgos Laborales Suramericana S.A.» (NIT 800256161, verificarlo con su RUT)
-- ya existe en Terceros, la ARL se enlaza a él: es el pagador al que se le factura. Si todavía no existe,
-- no pasa nada: se crea en Terceros y se enlaza después (ver el HANDOFF).
UPDATE sst.arls SET tercero_id = (SELECT id FROM sst.terceros WHERE numero_documento = '800256161' LIMIT 1)
 WHERE nombre = 'ARL SURA' AND tercero_id IS NULL;
COMMIT;
