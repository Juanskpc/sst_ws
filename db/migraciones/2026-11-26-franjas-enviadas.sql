-- 26-nov-2026 · Qué sesiones (franjas) ya se le enviaron al asesor (pedido de JD&D).
--
-- Una orden que se ejecuta por partes (envío parcial, P3) se vuelve a enviar cada vez que se
-- programa una sesión más, y hasta hoy cada envío regeneraba y mandaba los formatos y las
-- invitaciones de TODAS las sesiones: el 25-nov la OS-2026-0324 (15 h, SURA) le reenvió al
-- asesor la asistencia del 11-nov, que ya tenía. Ahora cada franja recuerda:
--   enviada_en  cuándo salió el correo con su formato y su invitación (NULL = aún no);
--   enviada_a   a qué asesor (el principal de ese momento si la franja es suya);
--   ics_uid     el UID de su invitación de calendario, FIJO por sesión: al reprogramar o
--               cancelar UNA sesión se le habla a ese evento y no a «la n-ésima».
-- Como las franjas se reemplazan en bloque en cada asignación, el servidor HEREDA las tres
-- columnas de la franja previa con la misma fecha, horario y asesor.
--
-- Relleno: las franjas de órdenes que ya salieron (PROGRAMADA en adelante) se dan por
-- enviadas, con el UID por posición que usaban sus invitaciones hasta hoy
-- («os-<orden>[-<8 del coasesor>]-<n>@jdd-iacore», n = orden por fecha y hora de cada asesor),
-- para que una cancelación posterior encuentre el evento que el asesor ya tiene.
--
-- ADITIVO e idempotente (el relleno solo toca filas sin ics_uid).
--   node scripts/aplicar-migracion.mjs db/migraciones/2026-11-26-franjas-enviadas.sql
BEGIN;

ALTER TABLE sst.franjas_visita ADD COLUMN IF NOT EXISTS enviada_en TIMESTAMPTZ;
ALTER TABLE sst.franjas_visita ADD COLUMN IF NOT EXISTS enviada_a UUID REFERENCES sst.profesionales(id) ON DELETE SET NULL;
ALTER TABLE sst.franjas_visita ADD COLUMN IF NOT EXISTS ics_uid TEXT;

WITH posiciones AS (
  SELECT f.id,
         COALESCE(f.profesional_id, o.profesional_asignado_id) AS asesor,
         'os-' || f.orden_id::text
           || CASE WHEN f.profesional_id IS NULL THEN '' ELSE '-' || left(f.profesional_id::text, 8) END
           || '-' || row_number() OVER (PARTITION BY f.orden_id, f.profesional_id
                                        ORDER BY f.fecha, f.hora_inicio)::text
           || '@jdd-iacore' AS uid
    FROM sst.franjas_visita f
    JOIN sst.ordenes_servicio o ON o.id = f.orden_id
   WHERE o.estado::text <> 'SIN PROGRAMAR'
)
UPDATE sst.franjas_visita f
   SET enviada_en = COALESCE(f.enviada_en, f.creado_en),
       enviada_a  = COALESCE(f.enviada_a, p.asesor),
       ics_uid    = p.uid
  FROM posiciones p
 WHERE p.id = f.id AND f.ics_uid IS NULL;

COMMIT;
