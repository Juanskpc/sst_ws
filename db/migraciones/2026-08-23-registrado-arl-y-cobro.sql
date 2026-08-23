-- Fases 4 y 5 de la tanda del 22-ago-2026:
--   · F4 · profesional REGISTRADO ante la ARL y suplente que ejecuta.
--   · F5 · estado de FACTURACIÓN / cobro de la orden, con su historial.
--
-- Van juntas en un solo archivo porque las dos tocan `ordenes_servicio` y, por
-- tanto, obligan a rehacer las mismas vistas. Aplicarlas por separado significa
-- soltar y recrear `vw_ordenes_expandidas` dos veces.
--
-- Mismo motivo que las migraciones anteriores para NO correr `npm run migrate`
-- entero: además del esquema aplica `seed.sql` y reescribe el correo y el celular
-- de la cuenta admin del cliente desde el `.env`.
--
-- Es ADITIVO: una tabla nueva, una columna nulable y cinco columnas de cobro
-- (una con DEFAULT). No mueve ninguna fila de trabajo; las órdenes existentes
-- quedan con `profesional_formatos_id` en NULL —los formatos salen a nombre de
-- quien ejecuta, que es como salían— y con `estado_cobro = 'NO FACTURADA'`, que
-- es la verdad: nadie las ha marcado.
--
-- ⚠️ Aplicar ANTES de desplegar el código de las fases 4 y 5.
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-08-23-registrado-arl-y-cobro.sql

BEGIN;

-- ---------------------------------------------------------------------------
-- F4 · Registro del profesional ante cada ARL
-- ---------------------------------------------------------------------------
-- El registro es POR ARL, caduca y lo identifica un código que asigna la propia
-- ARL: por eso es tabla y no un booleano en `profesionales`.
CREATE TABLE IF NOT EXISTS sst.profesionales_arl (
  profesional_id  UUID NOT NULL REFERENCES sst.profesionales(id) ON DELETE CASCADE,
  arl_id          UUID NOT NULL REFERENCES sst.arls(id),
  registrado      BOOLEAN NOT NULL DEFAULT TRUE,
  codigo_registro TEXT,
  vigente_hasta   DATE,
  observacion     TEXT,
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (profesional_id, arl_id)
);
CREATE INDEX IF NOT EXISTS idx_profesionales_arl_arl ON sst.profesionales_arl(arl_id) WHERE registrado;

-- `profesional_asignado_id` NO cambia de significado: sigue siendo QUIEN EJECUTA.
-- Esta columna solo dice a nombre de quién se imprimen los formatos.
ALTER TABLE sst.ordenes_servicio
  ADD COLUMN IF NOT EXISTS profesional_formatos_id UUID REFERENCES sst.profesionales(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- F5 · Eje de facturación (independiente de sst.estado_orden)
-- ---------------------------------------------------------------------------
-- `CREATE TYPE` no admite IF NOT EXISTS: se atrapa el duplicado para que el
-- archivo se pueda volver a aplicar sin fallar.
DO $$ BEGIN
  CREATE TYPE sst.estado_cobro AS ENUM ('NO FACTURADA','RADICADA','APROBADA','FACTURADA','PAGADA');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE sst.ordenes_servicio
  ADD COLUMN IF NOT EXISTS estado_cobro sst.estado_cobro NOT NULL DEFAULT 'NO FACTURADA';
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS cobro_numero_factura  TEXT;
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS cobro_observacion     TEXT;
ALTER TABLE sst.ordenes_servicio ADD COLUMN IF NOT EXISTS cobro_actualizado_en  TIMESTAMPTZ;
ALTER TABLE sst.ordenes_servicio
  ADD COLUMN IF NOT EXISTS cobro_actualizado_por UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_ordenes_estado_cobro ON sst.ordenes_servicio(estado_cobro);

CREATE TABLE IF NOT EXISTS sst.historial_cobro_orden (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  orden_id        UUID NOT NULL REFERENCES sst.ordenes_servicio(id) ON DELETE CASCADE,
  estado_anterior sst.estado_cobro,
  estado_nuevo    sst.estado_cobro NOT NULL,
  numero_factura  TEXT,
  observacion     TEXT,
  cambiado_por    UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL,
  cambiado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_historial_cobro_orden ON sst.historial_cobro_orden(orden_id, cambiado_en);

-- ---------------------------------------------------------------------------
-- 🪤 Trampa 69 · `SELECT o.*` se congela al CREAR la vista, no al consultarla
-- ---------------------------------------------------------------------------
-- `vw_ordenes_expandidas` es `SELECT o.*`, así que parece heredar sola las seis
-- columnas nuevas. No: Postgres expande esa lista en el momento de crearla, y
-- de esa vista leen `getOrderExpanded()` —de donde `generateOrderDocuments` saca
-- la orden— y el listado de Órdenes. Sin rehacerla, el formato saldría a nombre
-- del ejecutor y el estado de cobro llegaría `undefined` a la pantalla, todo sin
-- un solo error por ningún lado.
--
-- `vw_horas_ejecutadas` nombra sus columnas una a una y no necesita ninguna de
-- estas (el cobro a la ARL no es lo que se le paga al profesional), así que NO
-- se toca — y con ella se queda quieta `vw_horas_por_cobrar`, que cuelga de la
-- anterior con CASCADE. Bloque copiado literal de `db/schema.sql`.
DROP VIEW IF EXISTS sst.vw_ordenes_expandidas;
CREATE VIEW sst.vw_ordenes_expandidas AS
SELECT o.*,
       a.nombre         AS arl_nombre,
       a.formato_origen AS arl_formato,
       p.nombre         AS profesional_nombre,
       p.correo         AS profesional_correo,
       pf.nombre        AS profesional_formatos_nombre,
       tp.nombre        AS tipo_orden,
       tp.valor_hora    AS tipo_orden_valor_hora
FROM sst.ordenes_servicio o
JOIN sst.arls a               ON a.id = o.arl_id
LEFT JOIN sst.profesionales p ON p.id = o.profesional_asignado_id
LEFT JOIN sst.profesionales pf ON pf.id = o.profesional_formatos_id
LEFT JOIN sst.tipos_orden tp  ON tp.id = o.tipo_orden_id;

COMMIT;

-- Comprobación posterior recomendada (es la que destapó la trampa 69):
--
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='sst' AND table_name='vw_ordenes_expandidas'
--      AND column_name IN ('profesional_formatos_id','profesional_formatos_nombre',
--                          'estado_cobro','cobro_numero_factura');
--
-- Tienen que salir las CUATRO. Mirar solo la tabla no sirve: ahí siempre están.
