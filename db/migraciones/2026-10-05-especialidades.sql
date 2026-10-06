-- 5-oct-2026 · Catálogo de ESPECIALIDADES de los profesionales.
--
-- La especialidad se escribía a mano en la ficha del profesional, así que la
-- misma acababa con tres grafías. JD&D pidió poder crear, editar y eliminar las
-- especialidades y ELEGIRLAS al crear o editar un profesional.
--
-- `sst.profesionales.especialidad` sigue siendo TEXTO (el nombre elegido): de ahí
-- la leen los formatos de las ARL, los informes y el buscador, y así eliminar una
-- especialidad del catálogo no deja a nadie sin la suya. Renombrarla sí se
-- propaga a las fichas (lo hace el endpoint).
--
-- Nace con las especialidades que ya tienen las fichas. ADITIVO e idempotente.
--
--   psql "$DATABASE_URL" -f db/migraciones/2026-10-05-especialidades.sql

BEGIN;

CREATE TABLE IF NOT EXISTS sst.especialidades (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre         TEXT NOT NULL,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_especialidades_nombre
  ON sst.especialidades (lower(btrim(nombre)));

-- Las seis que la pantalla ofrecía hasta hoy como lista fija, para que el
-- desplegable no amanezca vacío.
INSERT INTO sst.especialidades (nombre) VALUES
  ('HIGIENE INDUSTRIAL'), ('TAREAS DE ALTO RIESGO'), ('ERGONOMÍA'),
  ('MEDICINA PREVENTIVA'), ('PSICOLOGÍA ORGANIZACIONAL'), ('SEGURIDAD EN EL TRABAJO')
ON CONFLICT DO NOTHING;

INSERT INTO sst.especialidades (nombre)
SELECT DISTINCT upper(btrim(especialidad))
  FROM sst.profesionales
 WHERE btrim(COALESCE(especialidad, '')) <> ''
ON CONFLICT DO NOTHING;

COMMIT;
