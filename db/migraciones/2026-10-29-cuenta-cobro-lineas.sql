-- 29-oct-2026 · Cuentas de cobro: referencia real de la orden, tema del registro de asistencia,
-- horas editables, líneas manuales y órdenes apartadas del cobro.
--
-- Peticiones de JD&D (29-oct):
--   1/5 · La línea nombra la orden como la conoce la ARL («134803-67» en Bolívar, el número de orden
--         en las demás) y la actividad es el «Tema y/o actividad a realizar» del registro de
--         asistencia, no el tipo de orden («Capacitación»).
--   2   · El 20-oct se cargaron soportes de órdenes que ya estaban PAGADAS por fuera de ORBITA (hacía
--         falta el formato para facturar); al aceptarlas entraron en la cuenta de octubre del asesor.
--         Se pueden QUITAR de la cuenta y quedan apartadas del cobro para ese asesor
--         (`sst.cobro_exclusiones`): ni vuelven al regenerar ni cuentan como pendientes.
--   3   · Las horas a pagar se editan: la orden sale por 19 h y con el asesor se negociaron 9.
--   4   · Líneas MANUALES (sin orden): la gestión en Comtexaco y Gmaz va en la misma cuenta.
--
-- ADITIVA e idempotente.
--
--   node scripts/aplicar-migracion.mjs db/migraciones/2026-10-29-cuenta-cobro-lineas.sql

BEGIN;

ALTER TABLE sst.precuenta_items ALTER COLUMN orden_id DROP NOT NULL;
ALTER TABLE sst.precuenta_items ADD COLUMN IF NOT EXISTS manual BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sst.precuenta_items ADD COLUMN IF NOT EXISTS orden_referencia TEXT;
-- Horas que traía la orden antes de editarlas (para ver cuánto se movió).
ALTER TABLE sst.precuenta_items ADD COLUMN IF NOT EXISTS horas_original NUMERIC(8,2);

DO $$ BEGIN
  ALTER TABLE sst.precuenta_items
    ADD CONSTRAINT precuenta_items_orden_o_manual CHECK (orden_id IS NOT NULL OR manual);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS sst.cobro_exclusiones (
  orden_id       UUID NOT NULL REFERENCES sst.ordenes_servicio(id) ON DELETE CASCADE,
  profesional_id UUID NOT NULL REFERENCES sst.profesionales(id) ON DELETE CASCADE,
  motivo         TEXT,
  excluido_por   UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL,
  excluido_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (orden_id, profesional_id)
);

-- Mismas columnas que antes (CREATE OR REPLACE basta): solo se suma la exclusión.
CREATE OR REPLACE VIEW sst.vw_horas_por_cobrar AS
SELECT h.* FROM sst.vw_horas_ejecutadas h
 WHERE h.soportes_aceptados_en IS NOT NULL
   -- 5-oct-2026 · "Ya cobrada" se mira POR PROFESIONAL: con coasesores la misma
   -- orden entra en la cuenta de cada uno, y que uno ya la tenga en la suya no
   -- puede dar por cobradas las horas del otro.
   AND NOT EXISTS (
     SELECT 1 FROM sst.precuenta_items i
       JOIN sst.precuentas pc ON pc.id = i.precuenta_id
      WHERE i.orden_id = h.orden_id AND pc.profesional_id = h.profesional_id)
   -- 29-oct-2026 · Apartada del cobro (ya pagada por fuera de ORBITA).
   AND NOT EXISTS (
     SELECT 1 FROM sst.cobro_exclusiones x
      WHERE x.orden_id = h.orden_id AND x.profesional_id = h.profesional_id);

-- La referencia es solo un identificador: se rellena en todas las líneas. El tema, en cambio, solo
-- en las cuentas que el profesional todavía no ha visto (las enviadas y aceptadas no se reescriben).
UPDATE sst.precuenta_items i
   SET orden_referencia = CASE
         WHEN NULLIF(btrim(o.codigo_cronograma), '') IS NOT NULL AND NULLIF(btrim(o.secuencia::text), '') IS NOT NULL
           THEN btrim(o.codigo_cronograma) || '-' || btrim(o.secuencia::text)
         WHEN NULLIF(btrim(o.numero_orden), '') IS NOT NULL THEN btrim(o.numero_orden)
         ELSE o.codigo END
  FROM sst.ordenes_servicio o
 WHERE o.id = i.orden_id AND i.orden_referencia IS NULL;

UPDATE sst.precuenta_items i
   SET actividad = COALESCE(NULLIF(btrim(o.tema_actividad), ''), NULLIF(btrim(o.tipo_actividad), ''), i.actividad)
  FROM sst.ordenes_servicio o, sst.precuentas pc
 WHERE o.id = i.orden_id AND pc.id = i.precuenta_id AND pc.estado IN ('generada', 'rechazada');

COMMIT;
