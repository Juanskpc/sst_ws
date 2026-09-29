import { pool, withTransaction } from '../../config/db.js';
import { badRequest } from '../../utils/httpError.js';

/**
 * T0-09 · Los cinco resultados del cruce prefactura ↔ Orbita, en el orden en
 * que se comprueban (el primero que aplica manda). Son excluyentes: una fila
 * "ya tiene otra prefactura" no puede ser también "valor distinto", por
 * ejemplo, y mezclarlos confundiría más que ayudar.
 */
const RESULTADOS = {
  NO_ENCONTRADA: 'no_encontrada',
  OTRA_PREFACTURA: 'ya_tiene_otra_prefactura',
  NO_FINALIZADA: 'no_finalizada',
  VALOR_DISTINTO: 'valor_distinto',
  ENCONTRADA: 'encontrada',
};

/** Un peso de diferencia no cuenta como "valor distinto": es redondeo, no un desacuerdo real. */
const difieren = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) >= 1;

/**
 * Clasifica UNA fila de la prefactura contra la orden de Orbita que le
 * corresponda (si existe). No escribe nada: es el cálculo que alimenta tanto la
 * previsualización como la revalidación en el momento de aplicar.
 */
function clasificar(fila, orden, numeroPrefactura) {
  if (!orden) return { resultado: RESULTADOS.NO_ENCONTRADA, orden: null };
  if (orden.numero_prefactura && orden.numero_prefactura !== numeroPrefactura) {
    return { resultado: RESULTADOS.OTRA_PREFACTURA, orden };
  }
  if (orden.estado !== 'FINALIZADA') return { resultado: RESULTADOS.NO_FINALIZADA, orden };
  if (orden.valor_total != null && difieren(orden.valor_total, fila.valor_a_facturar)) {
    return { resultado: RESULTADOS.VALOR_DISTINTO, orden };
  }
  return { resultado: RESULTADOS.ENCONTRADA, orden };
}

/**
 * Cruza las filas extraídas con `sst.ordenes_servicio` por
 * `(codigo_cronograma, secuencia)` — la identidad de una orden de Bolívar— y
 * clasifica cada una. Se usa igual en la previsualización (sin escribir nada) y
 * justo antes de aplicar (para no fiarse de un cruce que el cliente pudo haber
 * calculado hace rato, mientras alguien más cambiaba la orden).
 */
export async function cruzarFilas(filas, numeroPrefactura, client = pool) {
  const resultado = [];
  for (const fila of filas) {
    const r = await client.query(
      `SELECT o.id, o.codigo, o.estado, o.estado_arl::text AS estado_arl,
              o.numero_prefactura, o.valor_total, o.empresa_nombre
         FROM sst.ordenes_servicio o
         JOIN sst.arls a ON a.id = o.arl_id
        WHERE a.nombre ILIKE '%bol%var%'
          AND o.codigo_cronograma = $1 AND o.secuencia = $2`,
      [fila.codigo_cronograma, fila.secuencia]
    );
    const orden = r.rows[0] || null;
    const { resultado: tipo } = clasificar(fila, orden, numeroPrefactura);
    resultado.push({ ...fila, resultado: tipo, orden, marcada_por_defecto: tipo === RESULTADOS.ENCONTRADA });
  }
  return resultado;
}

/**
 * Prefactura ya cargada con ese número, si existe (para el aviso "ya cargada el…").
 * No es un bloqueo: cargarla de nuevo no duplica nada (`numero_prefactura` es
 * único) y volver a aplicar sigue permitido.
 */
export async function prefacturaExistente(numeroPrefactura) {
  const r = await pool.query(
    `SELECT p.id, p.cargada_en, u.nombre AS cargada_por_nombre
       FROM sst.prefacturas p LEFT JOIN sst.usuarios u ON u.id = p.cargada_por
      WHERE p.numero_prefactura = $1`,
    [numeroPrefactura]
  );
  return r.rows[0] || null;
}

/**
 * T0-09 · Aplica la prefactura: guarda el encabezado y las filas (upsert por
 * `numero_prefactura` / `(prefactura_id, cronograma, secuencia)`, así que
 * cargar el mismo PDF dos veces no duplica nada) y, para las filas MARCADAS que
 * hoy siguen siendo `encontrada` o `valor_distinto`, pone `numero_prefactura` +
 * `estado_arl = 'APROBADO'` en la orden, con `origen = 'PREFACTURA'` en el
 * historial (T0-07).
 *
 * Todo en UNA transacción: si algo revienta, no queda ni el encabezado a medias.
 * Las filas que ya no cuadran (alguien cambió la orden entre la vista previa y
 * este clic) se devuelven en `omitidas`, no se fuerzan.
 */
export async function aplicarPrefactura({ datos, filasMarcadas, nombreArchivo, usuarioId }) {
  if (!datos?.numero_prefactura) throw badRequest('Falta el número de prefactura.');
  const marcadas = new Set(
    (filasMarcadas || []).map((k) => `${k.codigo_cronograma}|${k.secuencia}`)
  );

  return withTransaction(async (client) => {
    const pf = await client.query(
      `INSERT INTO sst.prefacturas
         (numero_prefactura, plan_codigo, plan_descripcion, fecha_corte, valor_total, nombre_archivo, cargada_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (numero_prefactura) DO UPDATE
         SET plan_codigo=$2, plan_descripcion=$3, fecha_corte=$4, valor_total=$5,
             nombre_archivo=$6, actualizada_en=now()
       RETURNING id`,
      [
        datos.numero_prefactura, datos.plan_codigo, datos.plan_descripcion,
        datos.fecha_corte, datos.valor_total, nombreArchivo, usuarioId,
      ]
    );
    const prefacturaId = pf.rows[0].id;

    const aplicadas = [];
    const omitidas = [];
    for (const fila of datos.filas) {
      // Revalidado AHORA, no con lo que trajo la previsualización: la orden pudo
      // cambiar de estado mientras el modal seguía abierto.
      const orden = (await client.query(
        `SELECT o.id, o.codigo, a.nombre AS arl_nombre, o.estado::text AS estado,
                o.estado_arl::text AS estado_arl, o.numero_prefactura, o.valor_total
           FROM sst.ordenes_servicio o JOIN sst.arls a ON a.id = o.arl_id
          WHERE a.nombre ILIKE '%bol%var%'
            AND o.codigo_cronograma=$1 AND o.secuencia=$2 FOR UPDATE`,
        [fila.codigo_cronograma, fila.secuencia]
      )).rows[0] || null;

      const { resultado: tipo } = clasificar(fila, orden, datos.numero_prefactura);
      const claveFila = `${fila.codigo_cronograma}|${fila.secuencia}`;
      const marcadaAplicable = marcadas.has(claveFila) && (tipo === RESULTADOS.ENCONTRADA || tipo === RESULTADOS.VALOR_DISTINTO);

      await client.query(
        `INSERT INTO sst.prefactura_filas
           (prefactura_id, orden_id, codigo_cronograma, secuencia, nit_empresa, razon_social,
            actividad_programa, valor_actividad, alimentacion, alojamiento, transporte, material,
            tiempo_muerto, valor_a_facturar, aplicada)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (prefactura_id, codigo_cronograma, secuencia) DO UPDATE
           SET orden_id=$2, nit_empresa=$5, razon_social=$6, actividad_programa=$7,
               valor_actividad=$8, alimentacion=$9, alojamiento=$10, transporte=$11,
               material=$12, tiempo_muerto=$13, valor_a_facturar=$14,
               aplicada = sst.prefactura_filas.aplicada OR $15`,
        [
          prefacturaId, orden?.id ?? null, fila.codigo_cronograma, fila.secuencia,
          fila.nit_empresa, fila.razon_social, fila.actividad_programa, fila.valor_actividad,
          fila.alimentacion, fila.alojamiento, fila.transporte, fila.material,
          fila.tiempo_muerto, fila.valor_a_facturar, marcadaAplicable,
        ]
      );

      if (!marcadas.has(claveFila)) continue; // no se pidió aplicar esta fila
      if (!marcadaAplicable) {
        omitidas.push({ codigo_cronograma: fila.codigo_cronograma, secuencia: fila.secuencia, resultado: tipo, codigo: orden?.codigo ?? null });
        continue;
      }
      // Reaplicar la misma prefactura sobre una orden que ya quedó APROBADA con
      // ella no es un cambio: no repite la fila en el historial, solo cuenta.
      if (orden.estado_arl === 'APROBADO' && orden.numero_prefactura === datos.numero_prefactura) {
        aplicadas.push(orden.codigo);
        continue;
      }

      await client.query(
        `UPDATE sst.ordenes_servicio
            SET numero_prefactura=$2, estado_arl='APROBADO'::sst.estado_arl,
                estado_arl_en=now(), estado_arl_por=$3, actualizado_en=now()
          WHERE id=$1`,
        [orden.id, datos.numero_prefactura, usuarioId]
      );
      await client.query(
        `INSERT INTO sst.historial_estado_arl
           (orden_id, estado_anterior, estado_nuevo, numero_prefactura, usuario_id, origen)
         VALUES ($1,$2::sst.estado_arl,'APROBADO',$3,$4,'PREFACTURA')`,
        [orden.id, orden.estado_arl, datos.numero_prefactura, usuarioId]
      );
      aplicadas.push(orden.codigo);
    }
    return { prefacturaId, aplicadas, omitidas };
  });
}
