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
 * 24-oct-2026 · Se suman los DOCUMENTOS que se vencen en la operación diaria:
 *  - órdenes de servicio sin finalizar a 7 y a 3 días de su fecha de vencimiento, y vencidas;
 *  - el registro de un profesional ante una ARL (`vigente_hasta`) a 30 y a 7 días, y vencido;
 *  - cuentas por cobrar y por pagar vencidas o que vencen en la semana (un solo
 *    aviso por tipo y semana, con el conteo: una cartera grande no puede llenar la campanita).
 *
 * Nunca lanza: es un efecto secundario de abrir una pantalla.
 */

/** Los avisos son para quien puede resolverlos, igual que CORTE_COBRO. */
const DESTINATARIOS = `u.activo AND u.rol IN ('admin','contador')`;
/** Lo operativo (órdenes, registros de profesionales) es de quien programa, no de la contadora. */
const DESTINATARIOS_OPERACION = `u.activo AND u.rol IN ('admin','administrativo')`;

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

async function avisar(client, { tipo, titulo, mensaje, clave, datos, operacion = false }) {
  const r = await client.query(
    `INSERT INTO sst.notificaciones (usuario_id, tipo, titulo, mensaje, datos)
     SELECT u.id, $1, $2, $3, $4::jsonb || jsonb_build_object('clave', $5::text)
       FROM sst.usuarios u
      WHERE ${operacion ? DESTINATARIOS_OPERACION : DESTINATARIOS}
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
    // ── 24-oct-2026 · Órdenes de servicio a punto de vencer ──
    // Umbrales propios (7 y 3 días): con 30 días de aviso, el SIPAB de Bolívar
    // llenaría la campanita de órdenes que tienen todo el mes por delante.
    const ordenes = await client.query(
      `SELECT o.id, o.codigo, o.empresa_nombre, (o.fecha_vencimiento - CURRENT_DATE) AS dias
         FROM sst.ordenes_servicio o
        WHERE o.estado::text <> 'FINALIZADA' AND o.fecha_vencimiento IS NOT NULL
          AND (o.fecha_vencimiento - CURRENT_DATE) <= 7
          AND (o.fecha_vencimiento - CURRENT_DATE) >= -30
        ORDER BY o.fecha_vencimiento LIMIT 200`,
    );
    for (const o of ordenes.rows) {
      const umbral = o.dias < 0 ? 0 : o.dias <= 3 ? 3 : 7;
      creadas += await avisar(client, {
        tipo: 'ORDEN_VENCE', operacion: true,
        titulo: umbral === 0 ? 'Orden de servicio vencida' : 'Orden de servicio por vencer',
        mensaje: `${frase(o.dias, `La orden ${o.codigo} (${o.empresa_nombre ?? 'sin empresa'})`)} Aún no está finalizada.`,
        clave: `orden:${o.id}:${umbral}`,
        datos: { orden_id: o.id, dias: o.dias, umbral },
      });
    }

    // ── Registro del profesional ante la ARL (vigente_hasta) ──
    const registros = await client.query(
      `SELECT pa.profesional_id, pa.arl_id, p.nombre AS profesional, a.nombre AS arl,
              (pa.vigente_hasta - CURRENT_DATE) AS dias, to_char(pa.vigente_hasta, 'YYYY-MM-DD') AS vigente_hasta
         FROM sst.profesionales_arl pa
         JOIN sst.profesionales p ON p.id = pa.profesional_id AND p.estado::text = 'Activo'
         JOIN sst.arls a ON a.id = pa.arl_id
        WHERE pa.registrado AND pa.vigente_hasta IS NOT NULL AND (pa.vigente_hasta - CURRENT_DATE) <= 30`,
    );
    for (const r of registros.rows) {
      const umbral = umbralDeVencimiento(r.dias);
      if (umbral === null) continue;
      creadas += await avisar(client, {
        tipo: 'REGISTRO_ARL_VENCE', operacion: true,
        titulo: umbral === 0 ? 'Registro ante la ARL vencido' : 'Registro ante la ARL por vencer',
        mensaje: `${frase(r.dias, `El registro de ${r.profesional} ante ${r.arl}`)} Sin registro vigente no puede firmar los formatos de esa ARL.`,
        // La fecha va en la clave: si la renuevan, los avisos vuelven a salir.
        clave: `registro:${r.profesional_id}:${r.arl_id}:${r.vigente_hasta}:${umbral}`,
        datos: { profesional_id: r.profesional_id, arl_id: r.arl_id, dias: r.dias, umbral, vigente_hasta: r.vigente_hasta },
      });
    }

    // ── Cuentas por cobrar y por pagar (un resumen por tipo y semana) ──
    const cartera = await client.query(
      `SELECT tipo, count(*) FILTER (WHERE vencimiento < CURRENT_DATE)::int AS vencidas,
              count(*) FILTER (WHERE vencimiento >= CURRENT_DATE AND vencimiento <= CURRENT_DATE + 7)::int AS por_vencer,
              to_char(date_trunc('week', CURRENT_DATE), 'IYYY-"S"IW') AS semana
         FROM sst.cartera_documentos
        WHERE NOT anulado AND saldo > 0 AND vencimiento IS NOT NULL
        GROUP BY tipo`,
    );
    for (const c of cartera.rows) {
      if (!c.vencidas && !c.por_vencer) continue;
      const porCobrar = c.tipo === 'CXC';
      const partes = [];
      if (c.vencidas) partes.push(`${c.vencidas} vencida${c.vencidas === 1 ? '' : 's'}`);
      if (c.por_vencer) partes.push(`${c.por_vencer} que vence${c.por_vencer === 1 ? '' : 'n'} en los próximos 7 días`);
      creadas += await avisar(client, {
        tipo: 'CARTERA_VENCE',
        titulo: porCobrar ? 'Cuentas por cobrar por vencer' : 'Cuentas por pagar por vencer',
        mensaje: `${porCobrar ? 'Por cobrar' : 'Por pagar'}: ${partes.join(' y ')}. Revise la cartera.`,
        clave: `cartera:${c.tipo}:${c.semana}`,
        datos: { tipo: c.tipo, vencidas: c.vencidas, por_vencer: c.por_vencer },
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
