-- Fase A · facturación · A1-01 · esquema de documentos electrónicos (27-sep-2026).
--
-- Solo el cambio (no correr `npm run migrate` entero: trampa 86). Aditivo: cinco
-- tablas nuevas, ninguna existente se toca.
--
-- Backend únicamente (esta ficha no trae pantalla): las tablas nacen vacías y las
-- llenará A1-04 (borrador) y A1-05 (emisión).
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-09-27-documentos-electronicos.sql

BEGIN;

-- El documento electrónico: factura, nota crédito, documento soporte, nota de
-- ajuste o nómina. `tipo` y `estado` van como TEXT + CHECK (no ENUM de Postgres)
-- a propósito, igual que `resoluciones_numeracion.tipo_documento`: un ENUM exige
-- tocar tres sitios a la vez (trampa de "enumerados duplicados", §1.2 del plan) y
-- aquí conviene poder sumar un estado sin una migración de tipo.
CREATE TABLE IF NOT EXISTS sst.documentos_electronicos (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo               TEXT NOT NULL
                       CHECK (tipo IN ('FACTURA', 'NOTA_CREDITO', 'DOC_SOPORTE', 'NOTA_AJUSTE_DS', 'NOMINA')),
  resolucion_id      UUID REFERENCES sst.resoluciones_numeracion(id),
  prefijo            TEXT,
  -- Lo asigna Factus al validar; antes de eso queda NULL (BORRADOR/ENVIANDO).
  numero             TEXT,
  -- Generado por Orbita, único: ORB-<tipo>-<uuid corto>. Es la clave de
  -- idempotencia frente al proveedor (§5.1 punto 5): nunca se reintenta una
  -- emisión con el mismo reference_code, y "Consultar estado" reconcilia por él.
  reference_code     TEXT NOT NULL,
  estado             TEXT NOT NULL DEFAULT 'BORRADOR'
                       CHECK (estado IN ('BORRADOR', 'ENVIANDO', 'VALIDADO', 'RECHAZADO', 'ANULADO')),
  tercero_id         UUID NOT NULL REFERENCES sst.terceros(id),
  fecha_emision      DATE,
  fecha_vencimiento  DATE,
  forma_pago_id      UUID REFERENCES sst.formas_pago(id),
  medio_pago_id      UUID REFERENCES sst.medios_pago(id),
  observaciones      TEXT,
  -- Todos en pesos (NUMERIC(16,2), como manda el §1.3 del plan): nunca se suman
  -- como float, se calculan con sst_ws/src/modules/facturacion/calculo.js.
  total_bruto        NUMERIC(16,2) NOT NULL DEFAULT 0,
  total_descuento    NUMERIC(16,2) NOT NULL DEFAULT 0,
  subtotal           NUMERIC(16,2) NOT NULL DEFAULT 0,
  total_iva          NUMERIC(16,2) NOT NULL DEFAULT 0,
  total_retenciones  NUMERIC(16,2) NOT NULL DEFAULT 0,
  total_a_pagar      NUMERIC(16,2) NOT NULL DEFAULT 0,
  -- CUFE (factura/NC/DS) o CUDE (nómina); lo devuelve el proveedor al validar.
  cufe               TEXT,
  qr_url             TEXT,
  -- Rutas dentro del almacenamiento de Orbita (storage.service.js): el PDF y el
  -- XML se descargan del proveedor y se guardan aquí; sus términos no garantizan
  -- conservarlos si la cuenta se elimina algún día (nota del §5.4 del plan).
  pdf_path           TEXT,
  xml_path           TEXT,
  respuesta_proveedor JSONB,
  errores            JSONB,
  -- NC apunta a la factura que corrige; nota de ajuste, al documento soporte.
  documento_referencia_id UUID REFERENCES sst.documentos_electronicos(id),
  -- Código DIAN de corrección, solo en notas crédito (1 devolución parcial, 2
  -- anulación, 3 rebaja, 4 ajuste de precio, 5/6 descuento comercial).
  causal             TEXT,
  -- NULL hasta que la Fase B exista: sst.comprobantes se crea en B1-01. Sin FK
  -- todavía porque la tabla no existe aún; se añade la restricción cuando llegue.
  comprobante_id     UUID,
  -- Bolívar: de qué prefactura sale (sst.prefacturas nace en T0-09, en la rama
  -- de Tanda 0). Sin FK por lo mismo: la tabla no existe en esta rama todavía.
  prefactura_id      UUID,
  creado_por         UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL,
  actualizado_por    UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL,
  creado_en          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- El reference_code es la clave de idempotencia: nunca puede repetirse.
CREATE UNIQUE INDEX IF NOT EXISTS uq_documentos_electronicos_reference_code
  ON sst.documentos_electronicos (reference_code);
-- Un número solo es único DENTRO de su tipo+prefijo; se dejan fuera los NULL
-- (documentos que aún no se validaron: casi todos, en BORRADOR o ENVIANDO).
CREATE UNIQUE INDEX IF NOT EXISTS uq_documentos_electronicos_numero
  ON sst.documentos_electronicos (tipo, prefijo, numero) WHERE numero IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documentos_electronicos_tercero ON sst.documentos_electronicos (tercero_id);
CREATE INDEX IF NOT EXISTS idx_documentos_electronicos_estado ON sst.documentos_electronicos (tipo, estado);

DO $$ BEGIN
  CREATE TRIGGER trg_documentos_electronicos_tocar BEFORE UPDATE ON sst.documentos_electronicos
    FOR EACH ROW EXECUTE FUNCTION sst.fn_tocar_actualizado_en();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Una línea por orden (o por fila de prefactura en Bolívar; orden_id NULL en
-- ese caso, según A1-03).
CREATE TABLE IF NOT EXISTS sst.documento_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  documento_id   UUID NOT NULL REFERENCES sst.documentos_electronicos(id) ON DELETE CASCADE,
  orden_id       UUID REFERENCES sst.ordenes_servicio(id),
  producto_id    UUID REFERENCES sst.productos(id),
  codigo         TEXT,
  descripcion    TEXT NOT NULL,
  cantidad       NUMERIC(14,4) NOT NULL DEFAULT 1,
  valor_unitario NUMERIC(16,2) NOT NULL DEFAULT 0,
  descuento      NUMERIC(16,2) NOT NULL DEFAULT 0,
  base           NUMERIC(16,2) NOT NULL DEFAULT 0,
  total_linea    NUMERIC(16,2) NOT NULL DEFAULT 0,
  -- Solo lo usa el documento soporte, y solo desde B2-01 (contabilización): la
  -- cuenta de costo depende de la ARL de la orden, que B2 resuelve.
  cuenta_costo_id UUID,
  orden          SMALLINT NOT NULL DEFAULT 0,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_documento_items_documento ON sst.documento_items (documento_id, orden);
CREATE INDEX IF NOT EXISTS idx_documento_items_orden ON sst.documento_items (orden_id);

-- Impuestos y retenciones de CADA línea: una fila por tributo (IVA) o por
-- retención aplicada. retencion_id es NULL cuando la fila es el IVA del
-- producto (no hay "producto" en sst.retenciones); en ese caso tributo_codigo
-- lleva el código DIAN del impuesto (01 IVA, 04 INC…).
CREATE TABLE IF NOT EXISTS sst.documento_item_tributos (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id        UUID NOT NULL REFERENCES sst.documento_items(id) ON DELETE CASCADE,
  retencion_id   UUID REFERENCES sst.retenciones(id),
  tributo_codigo TEXT,
  base           NUMERIC(16,2) NOT NULL DEFAULT 0,
  tarifa         NUMERIC(6,3) NOT NULL DEFAULT 0,
  valor          NUMERIC(16,2) NOT NULL DEFAULT 0,
  CHECK (retencion_id IS NOT NULL OR tributo_codigo IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_documento_item_tributos_item ON sst.documento_item_tributos (item_id);

-- Línea de tiempo del documento: eventos internos (CREADO, ENVIADO…) y eventos
-- DIAN reenviados por Factus (030..034, ver el §5.4 del plan).
CREATE TABLE IF NOT EXISTS sst.documento_eventos (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  documento_id UUID NOT NULL REFERENCES sst.documentos_electronicos(id) ON DELETE CASCADE,
  codigo       TEXT NOT NULL,
  descripcion  TEXT,
  fecha        TIMESTAMPTZ NOT NULL DEFAULT now(),
  datos        JSONB,
  usuario_id   UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_documento_eventos_documento ON sst.documento_eventos (documento_id, fecha);

-- Qué órdenes cubre cada documento (N:M, aunque hoy casi siempre es 1:N).
CREATE TABLE IF NOT EXISTS sst.documento_ordenes (
  documento_id UUID NOT NULL REFERENCES sst.documentos_electronicos(id) ON DELETE CASCADE,
  orden_id     UUID NOT NULL REFERENCES sst.ordenes_servicio(id),
  PRIMARY KEY (documento_id, orden_id)
);
-- Una orden solo puede estar en UNA factura VALIDADO (no anulada) a la vez: sin
-- esto, dos facturas podrían cobrar la misma orden por error. Postgres no deja
-- un índice parcial que mire OTRA tabla, así que una columna generada a mano
-- guarda el id del documento SOLO cuando es esa factura validada, y el índice
-- único parcial se apoya en ella.
ALTER TABLE sst.documento_ordenes ADD COLUMN IF NOT EXISTS documento_validado_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS uq_documento_ordenes_validado
  ON sst.documento_ordenes (orden_id) WHERE documento_validado_id IS NOT NULL;

-- Se mantiene con DOS disparadores porque el hecho relevante ("esta factura se
-- validó") ocurre en `documentos_electronicos`, no en `documento_ordenes`: el
-- primero recalcula al insertar la relación (por si el documento YA está
-- validado, caso raro pero posible); el segundo recalcula TODAS las relaciones
-- de un documento cuando su tipo o estado cambian después de creada la relación
-- (el caso normal: la relación nace con el BORRADOR y el documento pasa a
-- VALIDADO más tarde, en A1-05).
CREATE OR REPLACE FUNCTION sst.fn_documento_ordenes_sincronizar_validado() RETURNS trigger AS $$
DECLARE
  v_tipo TEXT;
  v_estado TEXT;
BEGIN
  SELECT tipo, estado INTO v_tipo, v_estado FROM sst.documentos_electronicos WHERE id = NEW.documento_id;
  NEW.documento_validado_id := CASE WHEN v_tipo = 'FACTURA' AND v_estado = 'VALIDADO' THEN NEW.documento_id ELSE NULL END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER trg_documento_ordenes_validado BEFORE INSERT OR UPDATE ON sst.documento_ordenes
    FOR EACH ROW EXECUTE FUNCTION sst.fn_documento_ordenes_sincronizar_validado();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION sst.fn_documentos_electronicos_propagar_validado() RETURNS trigger AS $$
BEGIN
  -- El trigger ya solo dispara en INSERT o en UPDATE que toque `estado`
  -- (cláusula "OF estado" de abajo), así que aquí siempre toca propagar.
  UPDATE sst.documento_ordenes
     SET documento_validado_id = CASE WHEN NEW.tipo = 'FACTURA' AND NEW.estado = 'VALIDADO' THEN NEW.id ELSE NULL END
   WHERE documento_id = NEW.id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER trg_documentos_electronicos_propagar_validado
    AFTER INSERT OR UPDATE OF estado ON sst.documentos_electronicos
    FOR EACH ROW EXECUTE FUNCTION sst.fn_documentos_electronicos_propagar_validado();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
