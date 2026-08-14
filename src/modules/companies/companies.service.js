import { pool } from '../../config/db.js';

/**
 * CFG-02 · Reglas de identidad de una empresa cliente.
 *
 * Las mismas normalizaciones están declaradas como columnas generadas en
 * `sst.empresas` (nit_normalizado / nombre_normalizado). Se replican aquí para
 * poder comparar en JS sin ir a la BD; si una cambia, la otra también.
 */

/**
 * NIT comparable: dígitos de la parte anterior al guion. El dígito de
 * verificación se descarta porque las ARL lo incluyen u omiten a discreción
 * ('901.225.480-3' y '901225480' son la misma empresa).
 */
export const normalizarNit = (nit) =>
  String(nit ?? '').split('-')[0].replace(/[^0-9]/g, '');

/** Nombre comparable: solo alfanuméricos en mayúscula ('S.A.S' = 'SAS'). */
export const normalizarNombre = (nombre) =>
  String(nombre ?? '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();

/** Columnas que devuelve la API de empresas (evita exponer las generadas). */
export const EMPRESA_COLS = `
  id, nit, nombre, actividad_economica, ciudad, direccion,
  contacto_nombre, contacto_cargo, contacto_telefono, contacto_correo,
  contacto_sst_nombre, contacto_sst_telefono, contacto_sst_correo,
  notas, activo, creado_en, actualizado_en`;

/**
 * Devuelve el id de la empresa que corresponde a los datos que trae una OS,
 * creándola si no existe. Se usa al validar un borrador (M2 → M3) para que el
 * maestro no se quede atrás respecto de las órdenes que van entrando.
 *
 * El orden importa: primero el NIT (identificador real) y luego el nombre,
 * porque el NIT llega ilegible del OCR con suficiente frecuencia
 * ('900.184.?52-1') como para necesitar un segundo intento antes de dar de alta
 * un duplicado.
 *
 * `client` permite participar en la transacción de quien llama (por defecto usa
 * el pool). Devuelve `null` cuando la OS no trae ni NIT ni nombre.
 */
export async function resolverEmpresaId(datos, client = pool) {
  const nombre = String(datos?.nombre ?? '').trim();
  const nit = String(datos?.nit ?? '').trim();
  const nitNorm = normalizarNit(nit);
  const nombreNorm = normalizarNombre(nombre);
  if (!nitNorm && !nombreNorm) return null;

  if (nitNorm) {
    const r = await client.query(`SELECT id FROM sst.empresas WHERE nit_normalizado = $1`, [nitNorm]);
    if (r.rows[0]) return r.rows[0].id;
  }
  if (nombreNorm) {
    // Si el nombre está repetido gana la más antigua: es la que ya acumula
    // historia de órdenes.
    const r = await client.query(
      `SELECT id FROM sst.empresas WHERE nombre_normalizado = $1 ORDER BY creado_en LIMIT 1`,
      [nombreNorm]
    );
    if (r.rows[0]) return r.rows[0].id;
  }
  // Sin nombre no se da de alta: una ficha con solo NIT no es utilizable por el
  // administrador y ensucia el maestro.
  if (!nombre) return null;

  const ins = await client.query(
    `INSERT INTO sst.empresas (
       nit, nombre, actividad_economica, ciudad, direccion,
       contacto_nombre, contacto_cargo, contacto_telefono,
       contacto_sst_nombre, contacto_sst_telefono, contacto_sst_correo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      nit, nombre, datos.actividad_economica ?? null, datos.ciudad ?? null, datos.direccion ?? null,
      datos.contacto_nombre ?? null, datos.contacto_cargo ?? null, datos.contacto_telefono ?? null,
      datos.contacto_sst_nombre ?? null, datos.contacto_sst_telefono ?? null, datos.contacto_sst_correo ?? null,
    ]
  );
  if (ins.rows[0]) return ins.rows[0].id;

  // ON CONFLICT: otra validación en paralelo creó la misma empresa entre el
  // SELECT y el INSERT. Se relee para devolver su id en lugar de fallar.
  if (nitNorm) {
    const r = await client.query(`SELECT id FROM sst.empresas WHERE nit_normalizado = $1`, [nitNorm]);
    if (r.rows[0]) return r.rows[0].id;
  }
  return null;
}
