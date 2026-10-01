-- 30-sep-2026 · Peticiones de JD&D antes de seguir con la contabilidad.
--
-- 1) «Validado plataforma»: un check A MANO, independiente del estado ARL (que lo
--    pone la prefactura). Dice que alguien comprobó la orden en la plataforma de
--    la ARL. No bloquea nada; se enseña como ✓ en la tabla de Órdenes. Se guarda
--    quién y cuándo, como todo lo que alguien marca a mano.
--
-- 2) El COBRO de la orden, desglosado y aprobado por operación. Hasta hoy una
--    orden pasaba a Facturación (y de ahí a la contabilidad) con solo tener la
--    aprobación de la ARL, y los gastos que el SIPAB trae en sus columnas
--    (transporte, alojamiento, alimentación, tiempo muerto, material) se
--    guardaban en `viaticos_detalle` sin entrar en ninguna cifra.
--
--    · Honorarios = `horas_asignadas × valor_unitario` (columnas que ya existían;
--      `valor_total` sigue siendo los honorarios, no el total con gastos).
--    · `cobro_*`: los gastos que se le cobran al pagador. Nacen del SIPAB y se
--      pueden corregir. ⚠️ NO son `viaticos_valor`: eso es lo que se le
--      reembolsa al PROFESIONAL en su cuenta de cobro; esto es lo que se le
--      factura a la ARL. Son dos direcciones distintas del dinero.
--    · `cobro_aprobado_*`: el visto bueno de operación (admin o administrativo).
--      Sin él la orden no aparece como facturable. `cobro_aprobado_total` es la
--      cifra que se aprobó: si después cambia un valor, la aprobación se cae
--      (lo hace el servicio, no un trigger, para poder decir por qué).
--
-- ADITIVO e idempotente.
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-09-30-validado-y-aprobacion-cobro.sql

BEGIN;

ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS validado_plataforma_en  TIMESTAMPTZ;
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS validado_plataforma_por UUID REFERENCES sst.usuarios(id);

ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS cobro_transporte    NUMERIC(14,2);
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS cobro_alojamiento   NUMERIC(14,2);
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS cobro_alimentacion  NUMERIC(14,2);
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS cobro_tiempo_muerto NUMERIC(14,2);
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS cobro_material      NUMERIC(14,2);
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS cobro_aprobado_en    TIMESTAMPTZ;
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS cobro_aprobado_por   UUID REFERENCES sst.usuarios(id);
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS cobro_aprobado_total NUMERIC(14,2);

-- Los gastos del SIPAB que ya estaban guardados pasan a las columnas nuevas, para
-- que el modal no aparezca vacío en las órdenes ya cargadas. Solo donde nadie ha
-- escrito todavía (idempotente: correrla dos veces no pisa una corrección).
UPDATE sst.ordenes_servicio
   SET cobro_transporte    = NULLIF((viaticos_detalle->>'transporte')::numeric, 0),
       cobro_alojamiento   = NULLIF((viaticos_detalle->>'alojamiento')::numeric, 0),
       cobro_alimentacion  = NULLIF((viaticos_detalle->>'alimentacion')::numeric, 0),
       cobro_tiempo_muerto = NULLIF((viaticos_detalle->>'tiempo_muerto')::numeric, 0),
       cobro_material      = NULLIF((viaticos_detalle->>'material_complementario')::numeric, 0)
 WHERE viaticos_detalle IS NOT NULL
   AND cobro_transporte IS NULL AND cobro_alojamiento IS NULL AND cobro_alimentacion IS NULL
   AND cobro_tiempo_muerto IS NULL AND cobro_material IS NULL;

-- Historial de la aprobación: aprobar, retirar y la caída automática por un
-- cambio de valores. La contadora tiene que poder ver por qué una orden que
-- ayer estaba lista hoy no sale en Facturación.
CREATE TABLE IF NOT EXISTS sst.historial_aprobacion_cobro (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  orden_id    UUID NOT NULL REFERENCES sst.ordenes_servicio(id) ON DELETE CASCADE,
  accion      TEXT NOT NULL CHECK (accion IN ('APROBADA', 'RETIRADA', 'ANULADA_POR_CAMBIO')),
  total       NUMERIC(14,2),
  observacion TEXT,
  usuario_id  UUID REFERENCES sst.usuarios(id),
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_hist_aprob_cobro_orden ON sst.historial_aprobacion_cobro(orden_id, creado_en);

COMMIT;
