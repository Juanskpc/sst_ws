import { pool } from '../../config/db.js';

/**
 * Alertas de vencimiento de la Fase A, por la campanita (A0-08 y A0-09):
 *  - una resolución de numeración activa a 30 y a 7 días de vencer, y ya vencida;
 *  - una resolución con menos del 10 % de sus números;
 *  - el paquete del proveedor de facturación a 30 y a 7 días, y ya vencido.
 *
 * Igual que el aviso del día de corte (CFG-05), el despliegue no tiene cron: se
 * revisa al abrir las pantallas afectadas y, como mucho una vez al día, cuando
 * alguien abre la campanita. Cada aviso se crea UNA vez por usuario y umbral
 * (clave en `datos.clave`): la condición se cumple todos los días hasta que
 * alguien la resuelva y sin esa deduplicación la campanita se llenaría.
 *
 * Nunca lanza: es un efecto secundario de abrir una pantalla.
 */

/** Los avisos son para quien puede resolverlos, igual que CORTE_COBRO. */
const DESTINATARIOS = `u.activo AND u.rol IN ('admin','contador')`;

/**
 * Umbral que corresponde a los días que faltan: el más grave que ya se cumplió.
 * Si una resolución se descubre a 5 días, se avisa del de 7 y no también del de 30.
 * @returns {0|7|30|null} 0 = ya vencida
 */
export function umbralDeVencimiento(dias) {
  if (dias == null) return null;
  if (dias < 0) return 0;
  if (dias <= 7) return 7;
  if (dias <= 30) return 30;
  return null;
}

const nombreDocumento = {
  FACTURA: 'factura de venta', NOTA_CREDITO: 'nota crédito', DOC_SOPORTE: 'documento soporte',
  NOTA_AJUSTE_DS: 'nota de ajuste', NOMINA: 'nómina electrónica',
};

async function avisar(client, { tipo, titulo, mensaje, clave, datos }) {
  const r = await client.query(
    `INSERT INTO sst.notificaciones (usuario_id, tipo, titulo, mensaje, datos)
     SELECT u.id, $1, $2, $3, $4::jsonb || jsonb_build_object('clave', $5::text)
       FROM sst.usuarios u
      WHERE ${DESTINATARIOS}
        AND NOT EXISTS (
          SELECT 1 FROM sst.notificaciones n
           WHERE n.usuario_id = u.id AND n.tipo = $1 AND n.datos->>'clave' = $5::text
        )
     RETURNING id`,
    [tipo, titulo, mensaje, JSON.stringify(datos ?? {}), clave],
  );
  return r.rowCount;
}

function frase(dias, cosa) {
  if (dias < 0) return `${cosa} venció hace ${-dias} día(s).`;
  if (dias === 0) return `${cosa} vence hoy.`;
  return `${cosa} vence en ${dias} día(s).`;
}

export async function revisarVencimientos(client = pool) {
  try {
    let creadas = 0;

    const resoluciones = await client.query(
      `SELECT id, tipo_documento, prefijo, desde, hasta, consecutivo_actual,
              (fecha_hasta - CURRENT_DATE) AS dias,
              to_char(fecha_hasta, 'YYYY-MM-DD') AS fecha_hasta
         FROM sst.resoluciones_numeracion WHERE activa`,
    );
    for (const r of resoluciones.rows) {
      const cual = `${nombreDocumento[r.tipo_documento] || r.tipo_documento}${r.prefijo ? ` (${r.prefijo})` : ''}`;
      const umbral = umbralDeVencimiento(r.dias);
      if (umbral !== null) {
        creadas += await avisar(client, {
          tipo: 'RESOLUCION_VENCE',
          titulo: umbral === 0 ? 'Resolución de numeración vencida' : 'Resolución de numeración por vencer',
          mensaje: `${frase(r.dias, `La resolución de ${cual}`)} Renuévela ante la DIAN y sincronice los rangos.`,
          clave: `resolucion:${r.id}:${umbral}`,
          datos: { resolucion_id: r.id, dias: r.dias, umbral, fecha_hasta: r.fecha_hasta },
        });
      }
      // Menos del 10 % de los números del rango. Se avisa una sola vez por resolución.
      if (r.desde != null && r.hasta != null) {
        const total = Number(r.hasta) - Number(r.desde) + 1;
        const quedan = Math.max(Number(r.hasta) - Number(r.consecutivo_actual), 0);
        if (total > 0 && quedan / total < 0.1) {
          creadas += await avisar(client, {
            tipo: 'RESOLUCION_AGOTA',
            titulo: 'Quedan pocos números de la resolución',
            mensaje: `A la resolución de ${cual} le quedan ${quedan} de ${total} números (menos del 10 %). Pida un rango nuevo antes de que se agote.`,
            clave: `resolucion:${r.id}:agota`,
            datos: { resolucion_id: r.id, quedan, total },
          });
        }
      }
    }

    const paquete = await client.query(
      `SELECT (paquete_proveedor_vence - CURRENT_DATE) AS dias,
              to_char(paquete_proveedor_vence, 'YYYY-MM-DD') AS vence
         FROM sst.emisor WHERE id = 1 AND paquete_proveedor_vence IS NOT NULL`,
    );
    const p = paquete.rows[0];
    const umbralPaquete = p ? umbralDeVencimiento(p.dias) : null;
    if (p && umbralPaquete !== null) {
      creadas += await avisar(client, {
        tipo: 'PAQUETE_FE_VENCE',
        titulo: umbralPaquete === 0 ? 'Paquete de facturación vencido' : 'Paquete de facturación por vencer',
        mensaje: `${frase(p.dias, 'El paquete del proveedor de facturación electrónica')} Renuévelo para no dejar de emitir.`,
        // La fecha va en la clave: si renuevan y cargan otra, los avisos vuelven a salir.
        clave: `paquete:${p.vence}:${umbralPaquete}`,
        datos: { dias: p.dias, umbral: umbralPaquete, vence: p.vence },
      });
    }
    return { creadas };
  } catch (e) {
    console.error('[vencimientos] no se pudo revisar:', e?.message);
    return { creadas: 0, error: e?.message };
  }
}

let ultimaRevision = null;

/**
 * Como mucho una revisión por día y proceso: la campanita se consulta muy a menudo
 * y esto solo hace falta una vez. Al reiniciar el servidor se repite, y no pasa
 * nada porque los avisos se deduplican.
 */
export async function revisarVencimientosDiario() {
  const hoy = new Date().toDateString();
  if (ultimaRevision === hoy) return { creadas: 0, omitida: true };
  ultimaRevision = hoy;
  return revisarVencimientos();
}
