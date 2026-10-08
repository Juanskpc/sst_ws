-- 7-oct-2026 · Petición de JD&D (reunión de contabilidad): el radicado de la orden
-- lleva FECHA y un VISTO BUENO, y se guarda el HISTORIAL de los radicados anteriores.
--
-- Hasta hoy era un texto suelto en la orden (2026-10-01-numero-radicado.sql). Una
-- orden puede radicarse más de una vez (la ARL la devuelve y se vuelve a radicar),
-- así que cada radicado pasa a ser una fila. El VIGENTE es el más reciente; la orden
-- conserva una copia (`numero_radicado`, `radicado_fecha`, `radicado_aprobado`) porque
-- la bandeja de Órdenes lo muestra en cada fila sin abrir nada.
--
-- Aditivo e idempotente. Lo que ya había escrito pasa a ser el primer radicado.
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-10-07-radicados.sql

BEGIN;

CREATE TABLE IF NOT EXISTS sst.orden_radicados (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  orden_id       UUID NOT NULL REFERENCES sst.ordenes_servicio(id) ON DELETE CASCADE,
  numero         TEXT NOT NULL CHECK (btrim(numero) <> ''),
  -- La fecha en que se radicó ante la ARL (la escribe quien radica).
  fecha          DATE,
  -- Visto bueno: la ARL lo aceptó. Se marca a mano, como «Validado plataforma».
  aprobado       BOOLEAN NOT NULL DEFAULT false,
  creado_por     UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orden_radicados_orden ON sst.orden_radicados (orden_id, creado_en DESC);

ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS radicado_fecha    DATE;
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS radicado_aprobado BOOLEAN NOT NULL DEFAULT false;

-- El radicado que ya tenía cada orden es su primer registro del historial.
INSERT INTO sst.orden_radicados (orden_id, numero, creado_por, creado_en)
SELECT o.id, o.numero_radicado, o.numero_radicado_por, COALESCE(o.numero_radicado_en, now())
  FROM sst.ordenes_servicio o
 WHERE o.numero_radicado IS NOT NULL AND btrim(o.numero_radicado) <> ''
   AND NOT EXISTS (SELECT 1 FROM sst.orden_radicados r WHERE r.orden_id = o.id);

COMMIT;
