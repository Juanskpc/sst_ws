-- 29-sep-2026 · A3-01 · Órdenes manuales para clientes particulares (sin ARL).
--
-- JD&D también le presta servicios a empresas que le pagan directamente, sin una
-- ARL de por medio. Esas órdenes no llegan en un PDF ni en un SIPAB: se crean a
-- mano desde Órdenes y se facturan al propio cliente, con IVA.
--
--   · `ordenes_servicio.arl_id` deja de ser obligatorio y aparece
--     `pagador_tercero_id` (el tercero de Parametrización → Terceros que paga).
--     Una orden tiene EXACTAMENTE uno de los dos: o la paga una ARL, o la paga un
--     particular. El CHECK lo impone en la base, no solo en el código.
--   · `borradores_extraccion.pagador_tercero_id`: la vista Órdenes lista
--     borradores, no órdenes, así que el alta manual crea también su borrador y
--     este tiene que saber de quién es.
--   · Las vistas que cruzaban con `sst.arls` con JOIN pasan a LEFT JOIN: con un
--     JOIN la orden particular desaparecía de `vw_ordenes_expandidas` y, con
--     ella, de la asignación, los soportes y la cuenta de cobro del profesional.
--     `vw_ordenes_expandidas` gana además `pagador_nombre` (la ARL o el cliente).
--
-- COMPATIBLE con lo que ya hay: toda orden existente tiene ARL, así que cumple el
-- CHECK tal cual, y las vistas devuelven las mismas filas para ellas. Idempotente.
--
-- Mismo motivo que las migraciones anteriores para NO correr `npm run migrate`
-- entero (trampa 86).
--
-- ⚠️ Aplicar ANTES de desplegar el código: el alta manual escribe las columnas.
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-09-29-ordenes-particulares.sql

BEGIN;

ALTER TABLE sst.ordenes_servicio ALTER COLUMN arl_id DROP NOT NULL;
ALTER TABLE sst.ordenes_servicio
  ADD COLUMN IF NOT EXISTS pagador_tercero_id UUID REFERENCES sst.terceros(id);
CREATE INDEX IF NOT EXISTS idx_ordenes_pagador
  ON sst.ordenes_servicio(pagador_tercero_id) WHERE pagador_tercero_id IS NOT NULL;
DO $$ BEGIN
  ALTER TABLE sst.ordenes_servicio ADD CONSTRAINT chk_ordenes_un_pagador
    CHECK ((arl_id IS NULL) <> (pagador_tercero_id IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE sst.borradores_extraccion
  ADD COLUMN IF NOT EXISTS pagador_tercero_id UUID REFERENCES sst.terceros(id);

-- Vistas: bloques copiados literal de `db/schema.sql` (trampa 69: `o.*` congela
-- las columnas; además hay que cambiar sus JOIN).
DROP VIEW IF EXISTS sst.vw_ordenes_expandidas;
CREATE VIEW sst.vw_ordenes_expandidas AS
SELECT o.*,
       a.nombre         AS arl_nombre,
       a.formato_origen AS arl_formato,
       -- A3-01 · Quién paga la orden, para los textos (correos, agenda, PDF):
       -- la ARL o, en una orden particular, el cliente. `arl_nombre` sigue NULL
       -- en las particulares a propósito: la matriz de formatos se decide por él
       -- y un cliente no tiene formatos de ARL.
       COALESCE(a.nombre, tp_pag.razon_social,
                NULLIF(btrim(concat_ws(' ', tp_pag.nombres, tp_pag.apellidos)), '')) AS pagador_nombre,
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
LEFT JOIN sst.arls a          ON a.id = o.arl_id
LEFT JOIN sst.terceros tp_pag ON tp_pag.id = o.pagador_tercero_id
LEFT JOIN sst.profesionales p ON p.id = o.profesional_asignado_id
LEFT JOIN sst.profesionales pf ON pf.id = o.profesional_formatos_id
LEFT JOIN sst.tipos_orden tp  ON tp.id = o.tipo_orden_id
LEFT JOIN sst.tipos_viatico tv ON tv.id = o.viaticos_tipo_id;

DROP VIEW IF EXISTS sst.vw_horas_ejecutadas CASCADE;
CREATE VIEW sst.vw_horas_ejecutadas AS
SELECT o.id                     AS orden_id,
       o.codigo                 AS orden_codigo,
       o.profesional_asignado_id AS profesional_id,
       p.nombre                 AS profesional_nombre,
       o.empresa_nombre,
       -- A3-01 · La orden particular no tiene ARL; la cuenta de cobro la enseña
       -- como tal en vez de dejar la casilla vacía.
       COALESCE(a.nombre, 'PARTICULAR') AS arl_nombre,
       o.tipo_actividad,
       o.actividad_economica,
       COALESCE(o.horas_asignadas, 0) AS horas,
       -- PRE-02 · Lo que se le paga por esta orden, congelado al asignarla. La
       -- cuenta de cobro lee esto y no el catálogo: cambiar el valor hora de un
       -- tipo no puede reescribir lo ya trabajado.
       o.tipo_orden_id,
       tp.nombre           AS tipo_orden,
       o.valor_hora_cobro,
       o.valor_hora_origen,
       o.valor_cobro_total,
       -- Los viáticos viajan con las horas: la cuenta de cobro los cobra en la
       -- misma fila, como una línea aparte del mismo trabajo.
       o.viaticos_valor,
       COALESCE(o.fecha_ejecucion, o.fecha_programada, o.actualizado_en)::date AS fecha_ejecucion,
       to_char(COALESCE(o.fecha_ejecucion, o.fecha_programada, o.actualizado_en), 'YYYY-MM') AS periodo,
       o.soportes_aceptados_en
FROM sst.ordenes_servicio o
LEFT JOIN sst.arls a          ON a.id = o.arl_id
LEFT JOIN sst.profesionales p ON p.id = o.profesional_asignado_id
LEFT JOIN sst.tipos_orden tp  ON tp.id = o.tipo_orden_id
WHERE o.estado IN ('EJECUTADA','FINALIZADA') AND o.profesional_asignado_id IS NOT NULL;

DROP VIEW IF EXISTS sst.vw_horas_por_cobrar;
CREATE VIEW sst.vw_horas_por_cobrar AS
SELECT h.* FROM sst.vw_horas_ejecutadas h
 WHERE h.soportes_aceptados_en IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM sst.precuenta_items i WHERE i.orden_id = h.orden_id);

DROP VIEW IF EXISTS sst.vw_ordenes_vencidas;
CREATE VIEW sst.vw_ordenes_vencidas AS
SELECT o.id,
       o.codigo,
       o.estado,
       o.empresa_nombre,
       o.nit_nic,
       COALESCE(a.nombre, 'PARTICULAR') AS arl_nombre,
       o.arl_id,
       p.nombre  AS profesional_nombre,
       o.profesional_asignado_id AS profesional_id,
       o.horas_asignadas,
       o.fecha_orden,
       o.fecha_vencimiento,
       o.fecha_carga,
       o.fecha_programada,
       COALESCE(o.fecha_orden, o.fecha_carga::date)                         AS fecha_referencia,
       (CURRENT_DATE - COALESCE(o.fecha_orden, o.fecha_carga::date))::int    AS dias_transcurridos,
       CASE WHEN o.fecha_vencimiento IS NOT NULL
            THEN (o.fecha_vencimiento - CURRENT_DATE)::int END               AS dias_para_vencer
FROM sst.ordenes_servicio o
LEFT JOIN sst.arls a          ON a.id = o.arl_id
LEFT JOIN sst.profesionales p ON p.id = o.profesional_asignado_id
WHERE o.estado NOT IN ('EJECUTADA', 'FINALIZADA', 'CANCELADA');

COMMIT;

-- Comprobación posterior:
--
--   SELECT is_nullable FROM information_schema.columns
--    WHERE table_schema='sst' AND table_name='ordenes_servicio' AND column_name='arl_id';  -- YES
--   SELECT count(*) FROM sst.vw_ordenes_expandidas;  -- igual a count(*) de ordenes_servicio
