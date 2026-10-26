-- 24-oct-2026 · Cuentas de cobro: el valor de cada línea y los viáticos se pueden ajustar.
--
-- Petición de JD&D: el valor de la hora ya no es siempre el mismo (una actividad como una
-- risoterapia se pacta en $120.000 o $150.000 con el asesor) y a veces hay que sumar viáticos.
-- Antes de enviar la cuenta al profesional, quien la revisa cambia el valor hora y los
-- viáticos de cada línea; la línea queda marcada como AJUSTADA a mano y, si la cuenta se
-- vuelve a generar, ese ajuste se conserva.
--
-- ADITIVA e idempotente.
--
--   node scripts/aplicar-migracion.mjs db/migraciones/2026-10-24-cuenta-cobro-ajustes.sql

BEGIN;
ALTER TABLE sst.precuenta_items ADD COLUMN IF NOT EXISTS ajuste_manual BOOLEAN NOT NULL DEFAULT false;
-- Valor hora que traía la línea antes del ajuste (para poder ver cuánto se movió).
ALTER TABLE sst.precuenta_items ADD COLUMN IF NOT EXISTS valor_hora_original NUMERIC(12,2);
ALTER TABLE sst.precuenta_items ADD COLUMN IF NOT EXISTS ajustado_por UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL;
COMMIT;
