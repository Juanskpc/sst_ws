-- Tanda 0 de correcciones (27-sep-2026) · ficha T0-07: estado ARL + n.º de prefactura.
--
-- Eje nuevo en `ordenes_servicio`: si la ARL APROBÓ en su plataforma los
-- documentos de la orden (condición para facturar), más el n.º de prefactura de
-- Bolívar ("código SIPAB"). Con su historial propio.
--
-- Mismo motivo que las migraciones anteriores para NO correr `npm run migrate`
-- entero (trampa 86: reescribe la cuenta admin del cliente y siembra datos).
--
-- Es ADITIVO: un enum, cuatro columnas (una con DEFAULT 'PENDIENTE', que es la
-- verdad de toda orden existente: nadie la ha marcado) y una tabla. No mueve
-- ninguna fila de trabajo. Idempotente: se puede repetir.
--
-- ⚠️ Aplicar ANTES de desplegar el código de T0-07: `PATCH /orders/cobro` ya
-- consulta `estado_arl`, así que sin la columna falla el cambio de facturación.
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-09-27-estado-arl.sql

BEGIN;

DO $$ BEGIN
  CREATE TYPE sst.estado_arl AS ENUM ('PENDIENTE','APROBADO');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE sst.ordenes_servicio
  ADD COLUMN IF NOT EXISTS estado_arl sst.estado_arl NOT NULL DEFAULT 'PENDIENTE';
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS numero_prefactura TEXT;
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS estado_arl_en     TIMESTAMPTZ;
ALTER TABLE sst.ordenes_servicio
  ADD COLUMN IF NOT EXISTS estado_arl_por UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS sst.historial_estado_arl (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  orden_id          UUID NOT NULL REFERENCES sst.ordenes_servicio(id) ON DELETE CASCADE,
  estado_anterior   sst.estado_arl,
  estado_nuevo      sst.estado_arl NOT NULL,
  numero_prefactura TEXT,
  usuario_id        UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL,
  origen            TEXT NOT NULL DEFAULT 'MANUAL' CHECK (origen IN ('MANUAL','PREFACTURA')),
  creado_en         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_historial_estado_arl ON sst.historial_estado_arl(orden_id, creado_en);

-- `vw_ordenes_expandidas` es `SELECT o.*` y congela su lista de columnas al
-- crearse (trampa 69): sin recrearla, las columnas nuevas existen en la tabla
-- pero NO en la vista que lee el listado. Ninguna otra vista depende de ella.
-- Bloque copiado literal de `db/schema.sql`.
DROP VIEW IF EXISTS sst.vw_ordenes_expandidas;
CREATE VIEW sst.vw_ordenes_expandidas AS
SELECT o.*,
       a.nombre         AS arl_nombre,
       a.formato_origen AS arl_formato,
       p.nombre         AS profesional_nombre,
       p.correo         AS profesional_correo,
       -- ASG · Quién firma los formatos cuando NO es quien ejecuta (el
       -- profesional registrado ante la ARL). NULL en el caso normal.
       pf.nombre        AS profesional_formatos_nombre,
       -- CFG-04 · El NOMBRE del tipo de orden viaja resuelto: la vista de
       -- Órdenes lo enseña en cada fila y pedir el catálogo aparte para
       -- traducir un id sería un viaje por pantalla.
       tp.nombre        AS tipo_orden,
       tp.valor_hora    AS tipo_orden_valor_hora,
       -- La categoría del viático, resuelta por el mismo motivo: el detalle de
       -- la orden y el informe de facturación la enseñan junto a la cifra, y sin
       -- el nombre un importe suelto no dice de qué es.
       tv.nombre        AS viaticos_tipo,
       tv.valor         AS viaticos_tipo_valor
FROM sst.ordenes_servicio o
JOIN sst.arls a               ON a.id = o.arl_id
LEFT JOIN sst.profesionales p ON p.id = o.profesional_asignado_id
LEFT JOIN sst.profesionales pf ON pf.id = o.profesional_formatos_id
LEFT JOIN sst.tipos_orden tp  ON tp.id = o.tipo_orden_id
LEFT JOIN sst.tipos_viatico tv ON tv.id = o.viaticos_tipo_id;

COMMIT;

-- Comprobación posterior recomendada:
--
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='sst' AND table_name='vw_ordenes_expandidas'
--      AND column_name IN ('estado_arl','numero_prefactura','estado_arl_en','estado_arl_por');
--
-- Tienen que salir las CUATRO.
