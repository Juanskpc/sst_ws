import { pool } from '../../config/db.js';
import { badRequest } from '../../utils/httpError.js';

/**
 * A5-01 · Cifras del año para liquidar la nómina: salario mínimo y auxilio de transporte.
 *
 * Viven en la base (`sst.nomina_parametros`) y se editan desde la pantalla, para que el
 * decreto de cada diciembre no obligue a tocar el código ni a desplegar.
 */

const aNumeros = (f) => ({ anio: f.anio, smmlv: Number(f.smmlv), auxilioTransporte: Number(f.auxilio_transporte) });

export async function listarParametros(client = pool) {
  const r = await client.query(`SELECT anio, smmlv, auxilio_transporte, actualizado_en FROM sst.nomina_parametros ORDER BY anio DESC`);
  return r.rows.map((f) => ({ anio: f.anio, smmlv: Number(f.smmlv), auxilio_transporte: Number(f.auxilio_transporte), actualizado_en: f.actualizado_en }));
}

/** Las cifras de un año, listas para `calculo.js`, o null si no están cargadas. */
export async function parametrosDelAnio(anio, client = pool) {
  const r = await client.query(`SELECT anio, smmlv, auxilio_transporte FROM sst.nomina_parametros WHERE anio = $1`, [anio]);
  return r.rows[0] ? aNumeros(r.rows[0]) : null;
}

export async function guardarParametros(body, usuarioId) {
  const anio = Number(body?.anio);
  const smmlv = Number(body?.smmlv);
  const auxilio = Number(body?.auxilio_transporte);
  if (!Number.isInteger(anio) || anio < 2020 || anio > 2100) throw badRequest('Indique el año (por ejemplo, 2027).');
  if (!Number.isFinite(smmlv) || smmlv < 100_000) throw badRequest('El salario mínimo mensual no es válido.');
  if (!Number.isFinite(auxilio) || auxilio < 0 || auxilio >= smmlv) throw badRequest('El auxilio de transporte no es válido.');
  // Cambiar las cifras de un año no recalcula las nóminas ya guardadas: cada una conserva
  // la liquidación con la que se hizo. Solo afecta a lo que se liquide desde ahora.
  await pool.query(
    `INSERT INTO sst.nomina_parametros (anio, smmlv, auxilio_transporte, actualizado_por)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (anio) DO UPDATE SET smmlv = EXCLUDED.smmlv, auxilio_transporte = EXCLUDED.auxilio_transporte,
                                      actualizado_por = EXCLUDED.actualizado_por, actualizado_en = now()`,
    [anio, Math.round(smmlv * 100) / 100, Math.round(auxilio * 100) / 100, usuarioId],
  );
  return listarParametros();
}
