import { pool } from '../../config/db.js';

/**
 * 29-oct-2026 · Cuántos documentos electrónicos lleva usados JD&D de los que tiene incluidos
 * (`sst.configuracion` → `cupos_documentos`): «vas X de Y».
 *
 * Cuenta todo documento que LLEGÓ a la DIAN (tiene CUFE/CUDS/CUNE), aunque después se haya
 * anulado: el proveedor lo descontó en el momento de validarlo. Los borradores y los rechazados
 * no cuentan.
 *   · facturacion: facturas, notas crédito, documentos soporte y notas de ajuste del DS, por
 *     fecha de emisión.
 *   · nomina: cada nómina validada y cada nota de ajuste de nómina, por fecha de validación.
 */
export async function cuposDocumentos(client = pool) {
  const cfg = (await client.query(`SELECT valor FROM sst.configuracion WHERE clave = 'cupos_documentos'`)).rows[0]?.valor ?? {};
  const resultado = {};

  if (cfg.facturacion) {
    const { desde, hasta } = cfg.facturacion;
    const r = (await client.query(
      `SELECT count(*)::int AS usados,
              count(*) FILTER (WHERE tipo = 'FACTURA')::int        AS facturas,
              count(*) FILTER (WHERE tipo = 'NOTA_CREDITO')::int   AS notas_credito,
              count(*) FILTER (WHERE tipo = 'DOC_SOPORTE')::int    AS documentos_soporte,
              count(*) FILTER (WHERE tipo = 'NOTA_AJUSTE_DS')::int AS notas_ajuste
         FROM sst.documentos_electronicos
        WHERE tipo IN ('FACTURA', 'NOTA_CREDITO', 'DOC_SOPORTE', 'NOTA_AJUSTE_DS')
          AND cufe IS NOT NULL
          AND fecha_emision BETWEEN $1::date AND $2::date`,
      [desde, hasta],
    )).rows[0];
    resultado.facturacion = armar(cfg.facturacion, r.usados, {
      facturas: r.facturas, notas_credito: r.notas_credito,
      documentos_soporte: r.documentos_soporte, notas_ajuste: r.notas_ajuste,
    });
  }

  if (cfg.nomina) {
    const { desde, hasta } = cfg.nomina;
    // La tabla nace con el módulo de nómina: sin ella, el cupo está entero.
    const existe = (await client.query(`SELECT to_regclass('sst.nomina_liquidaciones') IS NOT NULL AS ok`)).rows[0].ok;
    const r = existe
      ? (await client.query(
          `SELECT count(*) FILTER (WHERE cune IS NOT NULL AND (validada_en AT TIME ZONE 'America/Bogota')::date BETWEEN $1::date AND $2::date)::int AS nominas,
                  count(*) FILTER (WHERE nota_cune IS NOT NULL AND (anulada_en AT TIME ZONE 'America/Bogota')::date BETWEEN $1::date AND $2::date)::int AS notas_ajuste
             FROM sst.nomina_liquidaciones`,
          [desde, hasta],
        )).rows[0]
      : { nominas: 0, notas_ajuste: 0 };
    resultado.nomina = armar(cfg.nomina, r.nominas + r.notas_ajuste, { nominas: r.nominas, notas_ajuste: r.notas_ajuste });
  }

  return resultado;
}

function armar({ total, desde, hasta }, usados, detalle) {
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  return {
    total: Number(total) || 0,
    usados,
    disponibles: Math.max((Number(total) || 0) - usados, 0),
    desde,
    hasta,
    vigente: hoy >= desde && hoy <= hasta,
    detalle,
  };
}
