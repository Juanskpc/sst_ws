import { pool, withTransaction } from '../../config/db.js';
import { badRequest, notFound } from '../../utils/httpError.js';
import { aCentavos, deCentavos } from '../../utils/dinero.js';
import { esAxa } from '../../utils/bolivar.js';

/**
 * 30-sep-2026 · El COBRO de una orden: cuánto se le factura al pagador, de qué
 * se compone y quién lo aprobó.
 *
 * Hasta hoy una orden pasaba a Facturación (y de ahí a la contabilidad) con solo
 * tener la aprobación de la ARL, y nadie miraba la cifra: en las órdenes del
 * SIPAB `valor_total` llega vacío y los gastos (transporte, alojamiento…) se
 * guardaban sin entrar en ningún total. Ahora operación revisa el desglose,
 * lo corrige si hace falta y lo APRUEBA; sin ese visto bueno la orden no sale
 * como facturable (`relacion.service.js`).
 *
 *  · Honorarios = horas × valor hora. El valor hora es el de la orden; si no
 *    tiene, se SUGIERE la tarifa de venta del pagador (A0-06), sin guardarla
 *    hasta que alguien la confirme.
 *  · Gastos = las cinco columnas `cobro_*`, que nacen del SIPAB.
 *  · Total = honorarios + gastos. Es lo que se compara con la prefactura.
 *
 * ⚠️ Nada de esto es `viaticos_valor` ni `valor_cobro_total`: esos son lo que se
 * le PAGA al profesional. Esto es lo que se le COBRA a la ARL.
 */

export const GASTOS = [
  { clave: 'transporte', columna: 'cobro_transporte', etiqueta: 'Transporte', prefactura: 'transporte' },
  { clave: 'alojamiento', columna: 'cobro_alojamiento', etiqueta: 'Alojamiento', prefactura: 'alojamiento' },
  { clave: 'alimentacion', columna: 'cobro_alimentacion', etiqueta: 'Alimentación', prefactura: 'alimentacion' },
  { clave: 'tiempo_muerto', columna: 'cobro_tiempo_muerto', etiqueta: 'Tiempo muerto', prefactura: 'tiempo_muerto' },
  { clave: 'material', columna: 'cobro_material', etiqueta: 'Material', prefactura: 'material' },
];

/**
 * 7-oct-2026 (reunión con JD&D) · Valor por defecto de una orden que llega sin precio
 * y cuyo pagador no tiene tarifa de venta: es el valor hora que hoy cobran (en el
 * paquete FE 816 de Bolívar, 2 horas = 142.914). Se PROPONE igual que la tarifa: queda
 * escrito en el campo, se puede cambiar y no cuenta hasta que alguien lo guarda.
 */
export const VALOR_POR_DEFECTO = 71457;

/** Roles que aprueban el cobro: los de operación (decisión del 30-sep-2026). */
export const ROLES_APRUEBAN = ['admin', 'administrativo'];

const num = (v) => (v == null || v === '' ? null : Number(v));
const sumar = (...vs) => Number(deCentavos(vs.reduce((s, v) => s + aCentavos(v ?? 0), 0)));
/** Un peso de diferencia es redondeo, no un desacuerdo (mismo criterio que la prefactura). */
const difieren = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) >= 1;

const SQL_ORDEN = `
  SELECT o.id, o.codigo, o.estado::text AS estado, o.estado_cobro::text AS estado_cobro, o.estado_arl::text AS estado_arl,
         o.cobro_numero_factura, o.arl_id, a.nombre AS arl_nombre, o.pagador_tercero_id,
         o.horas_asignadas, o.valor_unitario, o.valor_total, o.numero_prefactura,
         o.cobro_transporte, o.cobro_alojamiento, o.cobro_alimentacion, o.cobro_tiempo_muerto, o.cobro_material,
         o.viaticos_detalle IS NOT NULL AS gastos_del_sipab,
         o.cobro_aprobado_en, o.cobro_aprobado_total, ua.nombre AS cobro_aprobado_por_nombre,
         tv.valor AS tarifa_valor, tv.unidad AS tarifa_unidad,
         fe.documento_id AS factura_id, fe.estado AS factura_estado,
         -- numero ya trae el prefijo ("SETP990021842"): no se concatena.
         fe.numero AS factura_numero
    FROM sst.ordenes_servicio o
    LEFT JOIN sst.arls a ON a.id = o.arl_id
    LEFT JOIN sst.usuarios ua ON ua.id = o.cobro_aprobado_por
    -- Misma regla que la relación a facturar (A1-03): la tarifa por tipo de orden
    -- gana a la general, por hora si la orden tiene horas, y la más reciente.
    LEFT JOIN LATERAL (
      SELECT t.valor, t.unidad
        FROM sst.tarifas_venta t
       WHERE t.pagador_tercero_id = COALESCE(a.tercero_id, o.pagador_tercero_id) AND t.activo
         AND t.vigente_desde <= CURRENT_DATE
         AND (t.tipo_orden_id = o.tipo_orden_id OR t.tipo_orden_id IS NULL)
       ORDER BY (t.tipo_orden_id IS NOT NULL) DESC,
                (t.unidad = CASE WHEN COALESCE(o.horas_asignadas, 0) > 0 THEN 'HORA' ELSE 'UNIDAD' END) DESC,
                t.vigente_desde DESC
       LIMIT 1
    ) tv ON true
    -- La factura electrónica que ya cubre la orden (o el borrador en que está).
    LEFT JOIN LATERAL (
      SELECT d.id AS documento_id, d.estado, d.prefijo, d.numero
        FROM sst.documento_ordenes dor
        JOIN sst.documentos_electronicos d ON d.id = dor.documento_id
       WHERE dor.orden_id = o.id AND d.tipo = 'FACTURA'
         AND d.estado IN ('BORRADOR', 'ENVIANDO', 'VALIDADO')
       ORDER BY (d.estado = 'VALIDADO') DESC, d.creado_en DESC
       LIMIT 1
    ) fe ON true
   WHERE o.id = $1`;

/**
 * Las cifras de la orden tal como están guardadas, más la sugerencia de precio
 * cuando la orden no tiene. `precio_sugerido` NO entra en el total: un total
 * calculado con una tarifa que nadie ha confirmado no se puede aprobar.
 */
function calcular(o) {
  const horas = num(o.horas_asignadas);
  const valorHora = num(o.valor_unitario);
  // Con horas y valor hora, los honorarios salen de multiplicar: así no quedan
  // dos cifras que puedan contradecirse. Sin horas (actividad por unidad) manda
  // el valor escrito.
  const honorarios = valorHora != null && horas
    ? Number(deCentavos(aCentavos(horas * valorHora)))
    : num(o.valor_total);
  const gastos = Object.fromEntries(GASTOS.map((g) => [g.clave, num(o[g.columna]) ?? 0]));
  const totalGastos = sumar(...Object.values(gastos));
  const total = honorarios != null ? sumar(honorarios, totalGastos) : null;

  let precioSugerido = null;
  if (valorHora == null && o.tarifa_valor != null) {
    precioSugerido = { valor: Number(o.tarifa_valor), unidad: o.tarifa_unidad, origen: 'TARIFA' };
  } else if (valorHora == null && honorarios == null) {
    precioSugerido = { valor: VALOR_POR_DEFECTO, unidad: horas ? 'HORA' : 'UNIDAD', origen: 'POR_DEFECTO' };
  }
  return { horas, valor_hora: valorHora, honorarios, gastos, total_gastos: totalGastos, total, precio_sugerido: precioSugerido };
}

/** Fila de prefactura de la orden (la más reciente), con lo que difiere de Orbita. */
async function prefacturaDeOrden(o, cifras, db) {
  const r = await db.query(
    `SELECT pf.numero_prefactura, to_char(pf.fecha_corte, 'YYYY-MM-DD') AS fecha_corte,
            f.valor_actividad, f.alimentacion, f.alojamiento, f.transporte, f.material,
            f.tiempo_muerto, f.valor_a_facturar
       FROM sst.prefactura_filas f JOIN sst.prefacturas pf ON pf.id = f.prefactura_id
      WHERE f.orden_id = $1
      ORDER BY (pf.numero_prefactura = $2) DESC, pf.cargada_en DESC
      LIMIT 1`,
    [o.id, o.numero_prefactura ?? ''],
  );
  const f = r.rows[0];
  if (!f) return null;
  const diferencias = [];
  if (cifras.honorarios != null && difieren(cifras.honorarios, f.valor_actividad)) diferencias.push('honorarios');
  for (const g of GASTOS) {
    if (difieren(cifras.gastos[g.clave], f[g.prefactura])) diferencias.push(g.clave);
  }
  const totalDifiere = cifras.total == null || difieren(cifras.total, f.valor_a_facturar);
  return {
    numero: f.numero_prefactura,
    fecha_corte: f.fecha_corte,
    honorarios: num(f.valor_actividad),
    gastos: Object.fromEntries(GASTOS.map((g) => [g.clave, num(f[g.prefactura]) ?? 0])),
    total: num(f.valor_a_facturar),
    diferencias,
    cuadra: !totalDifiere,
  };
}

/** Todo lo que el modal de cobro necesita de UNA orden. */
export async function detalleCobro(ordenId, db = pool) {
  const o = (await db.query(SQL_ORDEN, [ordenId])).rows[0];
  if (!o) throw notFound('Orden no encontrada');
  const cifras = calcular(o);
  const historial = (await db.query(
    `SELECT h.id, h.accion, h.total, h.observacion, h.creado_en, u.nombre AS usuario_nombre
       FROM sst.historial_aprobacion_cobro h LEFT JOIN sst.usuarios u ON u.id = h.usuario_id
      WHERE h.orden_id = $1 ORDER BY h.creado_en DESC`,
    [ordenId],
  )).rows;
  return {
    orden_id: o.id,
    codigo: o.codigo,
    estado: o.estado,
    pagador: o.arl_nombre ?? null,
    particular: !o.arl_id,
    ...cifras,
    gastos_del_sipab: o.gastos_del_sipab,
    prefactura: await prefacturaDeOrden(o, cifras, db),
    aprobacion: o.cobro_aprobado_en
      ? { en: o.cobro_aprobado_en, por: o.cobro_aprobado_por_nombre, total: num(o.cobro_aprobado_total) }
      : null,
    // La factura electrónica manda sobre el marcado manual: si existe, el número
    // de factura y el estado FACTURADA los puso Orbita y no se tocan aquí.
    factura_electronica: o.factura_id
      ? { id: o.factura_id, estado: o.factura_estado, numero: o.factura_numero }
      : null,
    estado_cobro: o.estado_cobro,
    cobro_numero_factura: o.cobro_numero_factura,
    bloqueada: bloqueo(o),
    historial,
  };
}

/**
 * Por qué no se pueden cambiar las cifras ni la aprobación, o null. Una vez la
 * orden está en una factura (aunque sea borrador) sus valores ya se copiaron a
 * los ítems: cambiarlos aquí dejaría la orden diciendo una cosa y la factura otra.
 */
function bloqueo(o) {
  if (o.factura_id) {
    return o.factura_estado === 'BORRADOR'
      ? 'La orden ya está en un borrador de factura: quítela de él para cambiar sus valores.'
      : 'La orden ya tiene factura electrónica: sus valores se corrigen con una nota crédito.';
  }
  if (o.estado_cobro === 'FACTURADA') return 'La orden ya se marcó como FACTURADA.';
  return null;
}

function leerImporte(valor, etiqueta) {
  if (valor == null || valor === '') return null;
  const n = Number(valor);
  if (!Number.isFinite(n) || n < 0) throw badRequest(`${etiqueta}: escriba un valor en pesos, sin signos.`);
  if (n > 1e12) throw badRequest(`${etiqueta}: el valor es demasiado grande.`);
  return Number(deCentavos(aCentavos(n)));
}

/**
 * 1-oct-2026 · AXA no manda prefactura: su única aprobación es el visto bueno
 * del cobro. Aprobarlo deja la orden con estado ARL APROBADO (lo que Facturación
 * exige) y retirarlo la devuelve a PENDIENTE, con su línea en el historial del
 * estado ARL como cualquier cambio manual. Bolívar y Colmena no cambian.
 */
async function sincronizarArlAxa(client, o, nuevo, usuarioId) {
  if (!esAxa(o.arl_nombre) || o.estado_arl === nuevo) return;
  await client.query(
    `UPDATE sst.ordenes_servicio
        SET estado_arl = $2::sst.estado_arl, estado_arl_en = now(), estado_arl_por = $3
      WHERE id = $1`,
    [o.id, nuevo, usuarioId],
  );
  await client.query(
    `INSERT INTO sst.historial_estado_arl (orden_id, estado_anterior, estado_nuevo, usuario_id, origen)
     VALUES ($1, $2::sst.estado_arl, $3::sst.estado_arl, $4, 'MANUAL')`,
    [o.id, o.estado_arl, nuevo, usuarioId],
  );
}

async function anotar(client, ordenId, accion, total, observacion, usuarioId) {
  await client.query(
    `INSERT INTO sst.historial_aprobacion_cobro (orden_id, accion, total, observacion, usuario_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [ordenId, accion, total, observacion || null, usuarioId],
  );
}

/**
 * Guarda el valor hora (o el valor de la actividad, si no va por horas) y los
 * gastos. Si la orden estaba aprobada y el total cambia, la aprobación se CAE:
 * lo aprobado era otra cifra.
 */
export async function guardarValores(ordenId, body, usuarioId) {
  return withTransaction(async (client) => {
    const o = (await client.query(`${SQL_ORDEN} FOR UPDATE OF o`, [ordenId])).rows[0];
    if (!o) throw notFound('Orden no encontrada');
    const motivo = bloqueo(o);
    if (motivo) throw badRequest(motivo);

    const horas = num(o.horas_asignadas);
    const valorHora = leerImporte(body?.valor_hora, 'Valor hora');
    // Sin horas no hay multiplicación posible: se escribe el valor de la actividad.
    const valorActividad = horas ? null : leerImporte(body?.valor_actividad, 'Valor de la actividad');
    const valorTotal = horas
      ? (valorHora != null ? Number(deCentavos(aCentavos(horas * valorHora))) : null)
      : valorActividad;
    const gastos = GASTOS.map((g) => leerImporte(body?.gastos?.[g.clave], g.etiqueta));

    await client.query(
      `UPDATE sst.ordenes_servicio
          SET valor_unitario=$2, valor_total=$3,
              cobro_transporte=$4, cobro_alojamiento=$5, cobro_alimentacion=$6,
              cobro_tiempo_muerto=$7, cobro_material=$8, actualizado_en=now()
        WHERE id=$1`,
      [ordenId, horas ? valorHora : null, valorTotal, ...gastos],
    );

    if (o.cobro_aprobado_en) {
      const nueva = calcular({
        ...o, valor_unitario: horas ? valorHora : null, valor_total: valorTotal,
        ...Object.fromEntries(GASTOS.map((g, i) => [g.columna, gastos[i]])),
      });
      if (nueva.total == null || difieren(nueva.total, o.cobro_aprobado_total)) {
        await client.query(
          `UPDATE sst.ordenes_servicio
              SET cobro_aprobado_en=NULL, cobro_aprobado_por=NULL, cobro_aprobado_total=NULL
            WHERE id=$1`,
          [ordenId],
        );
        await anotar(client, ordenId, 'ANULADA_POR_CAMBIO', o.cobro_aprobado_total,
          `Cambió el total aprobado (${o.cobro_aprobado_total} → ${nueva.total ?? 'sin valor'}).`, usuarioId);
        await sincronizarArlAxa(client, o, 'PENDIENTE', usuarioId);
      }
    }
    return detalleCobro(ordenId, client);
  });
}

/**
 * Visto bueno de operación. Exige la orden FINALIZADA (antes del cierre la cifra
 * todavía puede moverse) y un total con honorarios: aprobar "sin valor" dejaría
 * pasar a contabilidad una orden que el borrador de factura no sabría cobrar.
 */
export async function aprobarCobro(ordenId, { observacion } = {}, usuarioId) {
  return withTransaction(async (client) => {
    const o = (await client.query(`${SQL_ORDEN} FOR UPDATE OF o`, [ordenId])).rows[0];
    if (!o) throw notFound('Orden no encontrada');
    const motivo = bloqueo(o);
    if (motivo) throw badRequest(motivo);
    if (o.estado !== 'FINALIZADA') {
      throw badRequest('El cobro se aprueba sobre órdenes FINALIZADAS: antes del cierre la cifra todavía puede cambiar.');
    }
    const { total, honorarios } = calcular(o);
    if (honorarios == null || !(total > 0)) {
      throw badRequest('La orden no tiene valor: escriba el valor hora (o el de la actividad) y guárdelo antes de aprobar.');
    }
    await client.query(
      `UPDATE sst.ordenes_servicio
          SET cobro_aprobado_en=now(), cobro_aprobado_por=$2, cobro_aprobado_total=$3
        WHERE id=$1`,
      [ordenId, usuarioId, total],
    );
    await anotar(client, ordenId, 'APROBADA', total, observacion, usuarioId);
    await sincronizarArlAxa(client, o, 'APROBADO', usuarioId);
    return detalleCobro(ordenId, client);
  });
}

/** Retirar el visto bueno (p. ej. la prefactura no cuadra y hay que revisar). */
export async function retirarAprobacion(ordenId, { observacion } = {}, usuarioId) {
  return withTransaction(async (client) => {
    const o = (await client.query(`${SQL_ORDEN} FOR UPDATE OF o`, [ordenId])).rows[0];
    if (!o) throw notFound('Orden no encontrada');
    const motivo = bloqueo(o);
    if (motivo) throw badRequest(motivo);
    if (!o.cobro_aprobado_en) throw badRequest('La orden no tiene el cobro aprobado.');
    await client.query(
      `UPDATE sst.ordenes_servicio
          SET cobro_aprobado_en=NULL, cobro_aprobado_por=NULL, cobro_aprobado_total=NULL
        WHERE id=$1`,
      [ordenId],
    );
    await anotar(client, ordenId, 'RETIRADA', o.cobro_aprobado_total, observacion, usuarioId);
    await sincronizarArlAxa(client, o, 'PENDIENTE', usuarioId);
    return detalleCobro(ordenId, client);
  });
}
