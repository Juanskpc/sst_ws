-- Ajustes del 23-ago-2026 sobre la tanda del 22-ago · dos cosas:
--
--   1. Los VIÁTICOS dejan de escribirse a mano: se eligen de un catálogo
--      (`sst.tipos_viatico`) que se administra en Configuración → Preferencias
--      del sistema, y el valor sale de la categoría elegida. "No aplica" es no
--      elegir ninguna (NULL), que es el caso de casi todas las órdenes.
--   2. El eje de cobro se queda en DOS estados: NO FACTURADA y FACTURADA. Los
--      otros tres (RADICADA, APROBADA, PAGADA) se retiran a petición del
--      cliente, que no los usa.
--
-- Mismo motivo que las anteriores para no correr `npm run migrate` entero:
-- además del esquema aplica `seed.sql` y reescribe el correo y el celular de la
-- cuenta admin del cliente desde el `.env`.
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-08-23-tipos-viatico-y-cobro-binario.sql

BEGIN;

-- ---------------------------------------------------------------------------
-- 1 · Catálogo de tipos de viático
-- ---------------------------------------------------------------------------
--
-- Mismo patrón que `sst.tipos_orden` (CFG-04) y por el mismo motivo: era un
-- número suelto que cada quien escribía como quería, y así dos órdenes del mismo
-- desplazamiento acababan con cifras distintas. Ahora la categoría manda y el
-- valor sale de ella.
--
-- OJO con el histórico, igual que en los tipos de orden: la orden se queda con
-- una COPIA del valor (`ordenes_servicio.viaticos_valor`) en el momento en que
-- se elige. Si mañana sube el viático de "Transporte intermunicipal", las
-- órdenes ya cargadas siguen valiendo lo que valían.
CREATE TABLE IF NOT EXISTS sst.tipos_viatico (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre         TEXT NOT NULL,
  valor          NUMERIC(14,2) NOT NULL DEFAULT 0,
  -- No se borran: una orden vieja puede seguir apuntando a una categoría
  -- retirada, y perder el nombre dejaría su historial sin explicación.
  activo         BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tipos_viatico_nombre
  ON sst.tipos_viatico (lower(btrim(nombre)));

-- La categoría elegida, en la orden y en el borrador. NULL = "No aplica", que es
-- lo que trae casi toda orden: el viático es la excepción, no la norma.
ALTER TABLE sst.ordenes_servicio
  ADD COLUMN IF NOT EXISTS viaticos_tipo_id UUID REFERENCES sst.tipos_viatico(id);
ALTER TABLE sst.borradores_extraccion
  ADD COLUMN IF NOT EXISTS tipo_viatico_id UUID REFERENCES sst.tipos_viatico(id);

-- El catálogo nace VACÍO a propósito: las categorías y sus importes los pone
-- JD&D en Configuración. Sembrar cifras inventadas sería peor que no tener
-- ninguna, porque nadie las revisaría.

-- ---------------------------------------------------------------------------
-- 2 · El eje de cobro pasa de cinco estados a dos
-- ---------------------------------------------------------------------------
--
-- Un enum de Postgres no admite quitar valores: hay que crear el tipo nuevo,
-- convertir las columnas y renombrar. Se puede hacer sin pérdida porque el eje
-- todavía no se ha usado en producción (las 13 órdenes están en NO FACTURADA y
-- `historial_cobro_orden` está vacío), pero la conversión mapea igualmente por
-- si esta migración se aplica sobre una base que sí lo usó:
--   RADICADA / APROBADA → NO FACTURADA   (aún no se facturó)
--   PAGADA              → FACTURADA      (se facturó, y además se cobró)
--
-- 🪤 `vw_ordenes_expandidas` es `SELECT o.*`, así que DEPENDE de la columna y hay
-- que tumbarla antes de tocar el tipo (trampa 69 del HANDOFF: al recrearla
-- hereda también las columnas nuevas de arriba).
DROP VIEW IF EXISTS sst.vw_ordenes_expandidas;

ALTER TABLE sst.ordenes_servicio ALTER COLUMN estado_cobro DROP DEFAULT;

DO $$ BEGIN
  CREATE TYPE sst.estado_cobro_v2 AS ENUM ('NO FACTURADA','FACTURADA');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE sst.ordenes_servicio
  ALTER COLUMN estado_cobro TYPE sst.estado_cobro_v2
  USING (CASE WHEN estado_cobro::text IN ('FACTURADA','PAGADA') THEN 'FACTURADA'
              ELSE 'NO FACTURADA' END)::sst.estado_cobro_v2;

ALTER TABLE sst.historial_cobro_orden
  ALTER COLUMN estado_anterior TYPE sst.estado_cobro_v2
  USING (CASE WHEN estado_anterior::text IN ('FACTURADA','PAGADA') THEN 'FACTURADA'
              WHEN estado_anterior IS NULL THEN NULL
              ELSE 'NO FACTURADA' END)::sst.estado_cobro_v2;
ALTER TABLE sst.historial_cobro_orden
  ALTER COLUMN estado_nuevo TYPE sst.estado_cobro_v2
  USING (CASE WHEN estado_nuevo::text IN ('FACTURADA','PAGADA') THEN 'FACTURADA'
              ELSE 'NO FACTURADA' END)::sst.estado_cobro_v2;

DROP TYPE sst.estado_cobro;
ALTER TYPE sst.estado_cobro_v2 RENAME TO estado_cobro;

ALTER TABLE sst.ordenes_servicio
  ALTER COLUMN estado_cobro SET DEFAULT 'NO FACTURADA';

-- Copia literal del bloque de `db/schema.sql`, con el JOIN nuevo del catálogo de
-- viáticos para que el nombre de la categoría viaje resuelto (lo enseñan el
-- detalle de la orden y el informe de facturación).
CREATE VIEW sst.vw_ordenes_expandidas AS
SELECT o.*,
       a.nombre         AS arl_nombre,
       a.formato_origen AS arl_formato,
       p.nombre         AS profesional_nombre,
       p.correo         AS profesional_correo,
       pf.nombre        AS profesional_formatos_nombre,
       tp.nombre        AS tipo_orden,
       tp.valor_hora    AS tipo_orden_valor_hora,
       tv.nombre        AS viaticos_tipo,
       tv.valor         AS viaticos_tipo_valor
FROM sst.ordenes_servicio o
JOIN sst.arls a               ON a.id = o.arl_id
LEFT JOIN sst.profesionales p ON p.id = o.profesional_asignado_id
LEFT JOIN sst.profesionales pf ON pf.id = o.profesional_formatos_id
LEFT JOIN sst.tipos_orden tp  ON tp.id = o.tipo_orden_id
LEFT JOIN sst.tipos_viatico tv ON tv.id = o.viaticos_tipo_id;

COMMIT;

-- Comprobación recomendada (trampa 69: las columnas hay que buscarlas en la
-- VISTA, no en la tabla):
--
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='sst' AND table_name='vw_ordenes_expandidas'
--      AND column_name IN ('viaticos_tipo_id','viaticos_tipo','estado_cobro');
--
--   SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
--    WHERE t.typname='estado_cobro' ORDER BY enumsortorder;   -- deben ser 2
