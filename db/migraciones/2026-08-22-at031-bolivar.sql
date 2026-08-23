-- Fase 1 de la tanda del 22-ago-2026 · los dos enumerados del AT-031 de Bolívar.
--
-- POR QUÉ ESTE ARCHIVO EXISTE: el DDL ya está dentro de `db/schema.sql`, pero
-- `npm run migrate` no se puede correr sin más contra la Neon compartida —
-- además del esquema aplica `seed.sql` y **reescribe el correo y el celular de
-- la cuenta admin del cliente** con lo que haya en el `.env`, que es un efecto
-- que nadie pidió (ver HANDOFF §0). Esto es exactamente el trozo que hace falta,
-- extraído literal de `schema.sql`.
--
-- Es ADITIVO: dos columnas nulables y sus dos CHECK. No mueve ni una fila, y se
-- deshace con `ALTER TABLE … DROP COLUMN`. Idempotente: se puede repetir.
--
-- ⚠️ HAY QUE APLICARLO ANTES DE DESPLEGAR EL CÓDIGO DE LA FASE 1: el INSERT de
-- `materializarOrden` ya nombra las dos columnas, así que sin ellas **falla la
-- confirmación de cualquier orden importada**, no solo las de Bolívar.
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-08-22-at031-bolivar.sql

BEGIN;

ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS tipo_servicio_arl   CHAR(1);
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS modalidad_ejecucion TEXT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ordenes_tipo_servicio_arl') THEN
    ALTER TABLE sst.ordenes_servicio ADD CONSTRAINT chk_ordenes_tipo_servicio_arl
      CHECK (tipo_servicio_arl IS NULL OR tipo_servicio_arl IN ('A','T','C','E','M','O'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ordenes_modalidad_ejecucion') THEN
    ALTER TABLE sst.ordenes_servicio ADD CONSTRAINT chk_ordenes_modalidad_ejecucion
      CHECK (modalidad_ejecucion IS NULL OR modalidad_ejecucion IN ('PRESENCIAL','VIRTUAL'));
  END IF;
END $$;

-- 🪤 Y HAY QUE REHACER LA VISTA. `vw_ordenes_expandidas` es `SELECT o.*`, pero
-- Postgres **expande esa lista de columnas al CREAR la vista**, no al
-- consultarla: agregar columnas a la tabla NO se las añade a la vista que ya
-- existe. Y de esa vista lee `getOrderExpanded()`, que es de donde
-- `generateOrderDocuments` saca la orden para rellenar el AT-031.
--
-- Sin esto el fallo es silencioso y del peor tipo: todo compila, la orden se
-- guarda con su letra y su modalidad, y el formato sale igual que siempre —con
-- las dos casillas sin marcar— porque los dos campos llegan `undefined`.
--
-- El bloque es una copia literal de `db/schema.sql`; si allí cambia, aquí ya no
-- importa (esta migración es de un día concreto y no se vuelve a correr).
DROP VIEW IF EXISTS sst.vw_ordenes_expandidas;
CREATE VIEW sst.vw_ordenes_expandidas AS
SELECT o.*,
       a.nombre         AS arl_nombre,
       a.formato_origen AS arl_formato,
       p.nombre         AS profesional_nombre,
       p.correo         AS profesional_correo,
       tp.nombre        AS tipo_orden,
       tp.valor_hora    AS tipo_orden_valor_hora
FROM sst.ordenes_servicio o
JOIN sst.arls a               ON a.id = o.arl_id
LEFT JOIN sst.profesionales p ON p.id = o.profesional_asignado_id
LEFT JOIN sst.tipos_orden tp  ON tp.id = o.tipo_orden_id;

COMMIT;

-- Las órdenes de Bolívar que YA existen quedan con los dos campos en NULL. No se
-- rellenan solas a propósito: la letra habría que sacarla del SIPAB original
-- —que puede no estar— y la modalidad no está en ningún documento. Se completan
-- al editar cada orden, y hasta entonces su AT-031 sale como salía hasta ahora,
-- con las dos casillas sin marcar.
