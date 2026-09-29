-- Fase A · facturación · A0-09 · ficha del emisor (27-sep-2026).
--
-- Solo el cambio (no correr `npm run migrate` entero: trampa 86). Aditivo: una
-- tabla nueva, sin tocar ninguna existente.
--
-- Nada del emisor se siembra: la fila nace cuando alguien guarda la ficha desde
-- la pantalla (A0-10), para poder cambiar de NIT o de razón social sin tocar
-- código (decisión 1 del §0 del plan, riesgo R-03).
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-09-27-emisor.sql

BEGIN;

-- Una sola fila: `CHECK (id = 1)` hace imposible tener dos emisores.
CREATE TABLE IF NOT EXISTS sst.emisor (
  id              SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  tipo_persona    TEXT NOT NULL DEFAULT 'JURIDICA' CHECK (tipo_persona IN ('NATURAL', 'JURIDICA')),
  nit             TEXT NOT NULL CHECK (nit ~ '^[0-9]+$'),
  dv              SMALLINT NOT NULL CHECK (dv BETWEEN 0 AND 9),  -- calculado, nunca tecleado
  razon_social    TEXT NOT NULL,
  nombre_comercial TEXT,
  direccion       TEXT NOT NULL,
  municipio_id    UUID NOT NULL REFERENCES sst.municipios(id),
  correo          TEXT NOT NULL,
  telefono        TEXT,
  ciiu_principal  TEXT CHECK (ciiu_principal ~ '^[0-9]{4}$'),
  ciiu_secundarias TEXT[] NOT NULL DEFAULT '{}',
  -- Códigos de responsabilidad del RUT (05, 07, 14, 42, 48, 52, 55…): son los
  -- numéricos del formulario del RUT, no los O-xx que Factus pide para el cliente.
  responsabilidades_rut TEXT[] NOT NULL DEFAULT '{}',
  -- Ambiente en el que JD&D declara estar facturando. La URL del proveedor sale
  -- de .env; esto es lo que la pantalla contrasta con ella para avisar de una
  -- incoherencia (p. ej. PRODUCCION apuntando al sandbox).
  ambiente        TEXT NOT NULL DEFAULT 'PRUEBAS' CHECK (ambiente IN ('PRUEBAS', 'PRODUCCION')),
  -- FEL-14 · Vigencia del paquete del proveedor (genera alertas a 30 y 7 días).
  paquete_proveedor_vence DATE,
  -- Cuándo se le enviaron al proveedor los documentos para el certificado de
  -- firma. Solo informativo: Orbita no custodia certificado ni llave.
  documentos_certificado_enviados_en DATE,
  actualizado_por UUID REFERENCES sst.usuarios(id) ON DELETE SET NULL,
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
