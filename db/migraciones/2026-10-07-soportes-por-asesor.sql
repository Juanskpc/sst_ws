-- 7-oct-2026 · Soportes POR ASESOR.
--
-- Petición de JD&D: cuando una orden la ejecutan varios asesores, TODOS suben sus
-- soportes (antes solo el principal tenía enlace). Cada asesor adicional recibe
-- su propio enlace público y la orden pasa a EJECUTADA cuando no falta ninguno.
--
--   enlaces_publicos.profesional_id  de quién es el enlace (NULL = del principal)
--   enlaces_publicos.rechazados      qué se le devolvió a ESE asesor adicional
--                                    (lo del principal sigue en la orden)
--   enlaces_publicos.entregado_en    cuándo envió lo suyo
--   archivos_soporte.profesional_id  quién subió el archivo (NULL = el principal)
--
-- ADITIVA e idempotente. Va después de `2026-10-07-franjas-por-profesional.sql`.
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-10-07-soportes-por-asesor.sql

BEGIN;

ALTER TABLE sst.enlaces_publicos
  ADD COLUMN IF NOT EXISTS profesional_id UUID REFERENCES sst.profesionales(id),
  ADD COLUMN IF NOT EXISTS rechazados     TEXT[],
  ADD COLUMN IF NOT EXISTS entregado_en   TIMESTAMPTZ;
ALTER TABLE sst.archivos_soporte
  ADD COLUMN IF NOT EXISTS profesional_id UUID REFERENCES sst.profesionales(id);
CREATE INDEX IF NOT EXISTS idx_enlaces_publicos_profesional ON sst.enlaces_publicos(orden_id, profesional_id);

-- Las órdenes que YA entregaron (EJECUTADA o FINALIZADA) quedan con su enlace
-- marcado como entregado: sin esto, un rechazo posterior las trataría como si
-- el profesional nunca hubiera enviado nada.
UPDATE sst.enlaces_publicos e
   SET entregado_en = COALESCE(
         (SELECT max(s.subido_en) FROM sst.archivos_soporte s WHERE s.orden_id = e.orden_id), now())
  FROM sst.ordenes_servicio o
 WHERE o.id = e.orden_id AND e.entregado_en IS NULL
   AND o.estado::text IN ('EJECUTADA', 'FINALIZADA');

COMMIT;
