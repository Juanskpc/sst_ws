import { pool } from '../../config/db.js';
import { badRequest } from '../../utils/httpError.js';
import { aCentavos, deCentavos } from '../../utils/dinero.js';

/**
 * A1-03 (FEL-01, FEL-02) · Relación a facturar y agrupación por pagador.
 *
 * Responde a "¿qué puedo facturar hoy, y agrupado cómo?" sin escribir nada: el
 * borrador de factura lo crea A1-04 a partir de la selección que este módulo
 * valida (`resolverSeleccion`).
 *
 * Una orden es CANDIDATA cuando está FINALIZADA, en NO FACTURADA (lo que ya se
 * facturó por fuera —Siigo, durante la transición— no vuelve a salir) y sin una
 * factura VALIDADO vigente. Además es FACTURABLE solo si la ARL la aprobó en su
 * plataforma (T0-07) y no está ya en un borrador. Las candidatas que no son
 * facturables se listan igual, con el motivo: la contadora necesita ver qué le
 * falta a cada una, no que desaparezcan.
 *
 * Agrupación (supuesto de Q-15, sin confirmar con JD&D):
 *  · Bolívar → una factura POR PREFACTURA; el precio de cada línea es el
 *    `valor_a_facturar` de la prefactura (manda sobre la tarifa).
 *  · AXA, Colmena, La Equidad y privados → la persona ELIGE las órdenes; solo se
 *    exige que sean del mismo pagador.
 *
 * A3-01 · Un pagador es una ARL (`arl_id`) o un cliente particular
 * (`pagador_tercero_id`, órdenes creadas a mano). Las particulares no tienen
 * estado ARL que esperar: se tratan como aprobadas.
 */

/** Bolívar se identifica por nombre en todo el repo (no hay un indicador propio). */
export const esBolivar = (nombreArl) => /bol[ií]var/i.test(nombreArl ?? '');

const MOTIVOS = {
  SIN_TERCERO: 'La ARL no tiene un tercero enlazado (Parametrización → Terceros).',
  NO_APROBADA: 'La ARL todavía no aprueba esta orden (estado ARL: Pendiente).',
  EN_BORRADOR: 'Ya está en un borrador de factura.',
  ENVIANDO: 'Su factura se está enviando a la DIAN.',
  SIN_PREFACTURA: 'Bolívar se factura por prefactura: cargue el PDF de la prefactura de esta orden.',
  OTRA_PREFACTURA: 'La orden quedó aprobada con otra prefactura.',
  SIN_ORDEN: 'No cruza con ninguna orden de Orbita (puede ser de otro proveedor de Bolívar).',
  RECARGAR_PREFACTURA: 'Está en esta prefactura pero no quedó aprobada: vuelva a cargar el PDF de la prefactura ahora que la orden está finalizada.',
  SIN_APROBACION_COBRO: 'Operación todavía no aprueba el cobro de esta orden (Órdenes → columna Cobro).',
};

/**
 * Órdenes candidatas, con la factura que ya las cubre (si la hay) y la tarifa de
 * venta vigente del pagador. La tarifa por tipo de orden gana a la general
 * (`tipo_orden_id NULL`), y entre dos de la misma clase gana la más reciente.
 */
const SQL_CANDIDATAS = `
  SELECT o.id, o.codigo, o.arl_id, a.nombre AS arl_nombre,
         o.pagador_tercero_id, COALESCE(a.tercero_id, o.pagador_tercero_id) AS tercero_id,
         o.numero_orden, o.codigo_cronograma, o.secuencia, o.empresa_nombre,
         o.tipo_actividad, o.tema_actividad, o.horas_asignadas, o.valor_unitario, o.valor_total,
         -- 30-sep-2026 · Los gastos que se le cobran al pagador (los aprueba
         -- operación junto con los honorarios) y el visto bueno.
         COALESCE(o.cobro_transporte, 0) AS transporte,
         COALESCE(o.cobro_transporte, 0) + COALESCE(o.cobro_alojamiento, 0) + COALESCE(o.cobro_alimentacion, 0)
           + COALESCE(o.cobro_tiempo_muerto, 0) + COALESCE(o.cobro_material, 0) AS gastos,
         o.cobro_aprobado_en,
         o.estado_arl::text AS estado_arl, o.numero_prefactura,
         to_char(COALESCE(o.fecha_ejecucion, o.fecha_programada, o.actualizado_en), 'YYYY-MM-DD') AS fecha_ejecucion,
         doc.documento_id, doc.documento_estado,
         tv.valor AS tarifa_valor, tv.unidad AS tarifa_unidad
    FROM sst.ordenes_servicio o
    LEFT JOIN sst.arls a ON a.id = o.arl_id
    LEFT JOIN LATERAL (
      SELECT d.id AS documento_id, d.estado AS documento_estado
        FROM sst.documento_ordenes dor
        JOIN sst.documentos_electronicos d ON d.id = dor.documento_id
       WHERE dor.orden_id = o.id AND d.tipo = 'FACTURA'
         AND d.estado IN ('BORRADOR', 'ENVIANDO', 'VALIDADO')
       ORDER BY (d.estado = 'VALIDADO') DESC, d.creado_en DESC
       LIMIT 1
    ) doc ON true
    LEFT JOIN LATERAL (
      SELECT t.valor, t.unidad
        FROM sst.tarifas_venta t
       WHERE t.pagador_tercero_id = COALESCE(a.tercero_id, o.pagador_tercero_id) AND t.activo
         AND t.vigente_desde <= CURRENT_DATE
         AND (t.tipo_orden_id = o.tipo_orden_id OR t.tipo_orden_id IS NULL)
       -- Un pagador puede tener tarifa por HORA y por UNIDAD a la vez: una orden con
       -- horas se cobra por hora, y una sin ellas, por unidad.
       ORDER BY (t.tipo_orden_id IS NOT NULL) DESC,
                (t.unidad = CASE WHEN COALESCE(o.horas_asignadas, 0) > 0 THEN 'HORA' ELSE 'UNIDAD' END) DESC,
                t.vigente_desde DESC
       LIMIT 1
    ) tv ON true
   WHERE o.estado = 'FINALIZADA'
     AND o.estado_cobro = 'NO FACTURADA'
     AND doc.documento_estado IS DISTINCT FROM 'VALIDADO'
     AND ($1::uuid IS NULL OR o.arl_id = $1)
     AND ($2::uuid IS NULL OR o.pagador_tercero_id = $2)
   ORDER BY o.codigo_cronograma NULLS LAST, o.secuencia NULLS LAST, o.codigo`;

/** Motivo por el que una candidata no se puede facturar aún, o `null` si sí. */
function motivoBloqueo(o) {
  if (!o.tercero_id) return MOTIVOS.SIN_TERCERO;
  // Una orden particular no pasa por la aprobación de ninguna ARL (A3-01).
  if (o.arl_id && o.estado_arl !== 'APROBADO') return MOTIVOS.NO_APROBADA;
  if (o.documento_estado === 'ENVIANDO') return MOTIVOS.ENVIANDO;
  if (o.documento_id) return MOTIVOS.EN_BORRADOR;
  // 30-sep-2026 · Sin el visto bueno de operación la orden no pasa a la
  // contabilidad, aunque la prefactura ya esté cargada (pedido de JD&D). Va
  // después del borrador: una orden que ya está en uno no se aprueba de nuevo.
  if (!o.cobro_aprobado_en) return MOTIVOS.SIN_APROBACION_COBRO;
  return null;
}

/**
 * Valor de referencia de una orden que NO viene de prefactura. El orden de
 * confianza es: tarifa de venta del pagador (A0-06, lo pactado con él) → valor
 * que trajo el documento de la ARL → nada. Nunca se inventa un "estándar": sin
 * cifra la línea queda en blanco y el borrador (A1-04) obliga a completarla.
 */
function valorReferencia(o) {
  const horas = Number(o.horas_asignadas) || 0;
  // Aprobado por operación: manda lo aprobado (honorarios de la orden). Los
  // gastos van aparte, en `gastos`, y el borrador los factura en su propio ítem.
  if (o.cobro_aprobado_en && o.valor_total != null) return { valor: Number(o.valor_total), origen: 'APROBADO' };
  if (o.tarifa_valor != null) {
    const centavos = o.tarifa_unidad === 'UNIDAD' ? aCentavos(o.tarifa_valor) : aCentavos(horas * Number(o.tarifa_valor));
    return { valor: Number(deCentavos(centavos)), origen: 'TARIFA' };
  }
  if (o.valor_total != null && Number(o.valor_total) > 0) return { valor: Number(o.valor_total), origen: 'ORDEN' };
  return { valor: null, origen: null };
}

function lineaDeOrden(o, extra = {}) {
  const motivo = extra.motivo ?? motivoBloqueo(o);
  const { valor, origen } = extra.valor !== undefined ? extra : valorReferencia(o);
  return {
    clave: extra.fila_id ? `fila:${extra.fila_id}` : `orden:${o.id}`,
    orden_id: o.id,
    fila_id: extra.fila_id ?? null,
    codigo: o.codigo,
    numero_orden: o.numero_orden,
    codigo_cronograma: o.codigo_cronograma,
    secuencia: o.secuencia,
    empresa_nombre: o.empresa_nombre,
    tipo_actividad: o.tipo_actividad,
    tema_actividad: o.tema_actividad,
    horas: o.horas_asignadas != null ? Number(o.horas_asignadas) : null,
    valor_unitario: o.cobro_aprobado_en && o.valor_unitario != null ? Number(o.valor_unitario)
      : o.tarifa_unidad === 'HORA' && o.tarifa_valor != null ? Number(o.tarifa_valor)
      : o.valor_unitario != null ? Number(o.valor_unitario) : null,
    transporte: Number(extra.transporte ?? o.transporte) || 0,
    // Gastos aprobados (transporte, alojamiento, alimentación, tiempo muerto,
    // material). En una línea de prefactura van DENTRO de `valor_a_facturar`.
    gastos: extra.origen === 'PREFACTURA' ? 0 : Number(o.gastos) || 0,
    fecha_ejecucion: o.fecha_ejecucion,
    valor_referencia: valor,
    origen_valor: origen,
    facturable: motivo == null,
    motivo,
    marcada_por_defecto: motivo == null && (extra.marcada ?? false),
    documento_id: o.documento_id,
    documento_estado: o.documento_estado,
  };
}

// Honorarios + gastos aprobados (30-sep-2026): es lo que se va a facturar.
const total = (lineas) => Number(deCentavos(lineas.reduce(
  (s, l) => s + aCentavos(l.valor_referencia ?? 0) + aCentavos(l.gastos ?? 0), 0)));

/**
 * Prefactura de Bolívar → grupo con una línea por fila. Las filas cuya orden ya
 * quedó facturada (o validada) se cuentan aparte y no se listan: una prefactura
 * a medias sigue siendo facturable por lo que le falta.
 */
function grupoDePrefactura(pf, filas, ordenesPorId) {
  const lineas = [];
  let yaFacturadas = 0;
  let sinOrden = 0;
  for (const f of filas) {
    if (f.orden_id && !ordenesPorId.has(f.orden_id)) {
      // La orden existe pero no es candidata: o ya se facturó, o aún no está FINALIZADA.
      yaFacturadas += f.orden_finalizada_facturada ? 1 : 0;
      if (f.orden_finalizada_facturada) continue;
      lineas.push({
        clave: `fila:${f.id}`, orden_id: f.orden_id, fila_id: f.id, codigo: f.orden_codigo,
        numero_orden: null, codigo_cronograma: f.codigo_cronograma, secuencia: f.secuencia,
        empresa_nombre: f.razon_social, tipo_actividad: f.actividad_programa, tema_actividad: null,
        horas: null, valor_unitario: null, transporte: Number(f.transporte) || 0, fecha_ejecucion: null,
        valor_referencia: f.valor_a_facturar != null ? Number(f.valor_a_facturar) : null, origen_valor: 'PREFACTURA',
        facturable: false, motivo: 'La orden todavía no está finalizada.', marcada_por_defecto: false,
        documento_id: null, documento_estado: null,
      });
      continue;
    }

    const valor = f.valor_a_facturar != null ? Number(f.valor_a_facturar) : null;
    if (!f.orden_id) {
      // 30-sep-2026 · Una fila cuya orden NO está en Orbita ya no se lista ni se
      // factura (antes salía "Lista"): la prefactura de Bolívar trae todo el
      // corte, incluidas órdenes que aún no se han importado u órdenes de otro
      // proveedor, y facturarlas sería cobrar algo que Orbita no ejecutó. Solo
      // se cuentan, para que la pantalla diga cuántas quedaron fuera.
      sinOrden += 1;
      continue;
    }

    const o = ordenesPorId.get(f.orden_id);
    let motivo = o.numero_prefactura && o.numero_prefactura !== pf.numero_prefactura
      ? MOTIVOS.OTRA_PREFACTURA
      : motivoBloqueo(o);
    // Está en la prefactura pero la carga no la aprobó (se importó o finalizó
    // después): lo que falta es volver a cargarla, no esperar a la ARL.
    if (motivo === MOTIVOS.NO_APROBADA) motivo = MOTIVOS.RECARGAR_PREFACTURA;
    lineas.push(lineaDeOrden(o, {
      fila_id: f.id, valor, origen: 'PREFACTURA', motivo, transporte: f.transporte, marcada: true,
    }));
  }
  const facturables = lineas.filter((l) => l.facturable && l.marcada_por_defecto);
  return {
    clave: `prefactura:${pf.id}`,
    tipo: 'PREFACTURA',
    prefactura: {
      id: pf.id, numero: pf.numero_prefactura, fecha_corte: pf.fecha_corte,
      valor_total: pf.valor_total != null ? Number(pf.valor_total) : null,
    },
    ya_facturadas: yaFacturadas,
    sin_orden: sinOrden,
    lineas,
    n_facturables: lineas.filter((l) => l.facturable).length,
    total_marcadas: total(facturables),
  };
}

/**
 * La relación completa, por pagador. `arlId` o `pagadorTerceroId` (cliente
 * particular, A3-01) la acotan a un solo pagador; `db` permite correrla dentro
 * de una transacción (los scripts de verificación).
 * @returns {Promise<{pagadores: object[]}>}
 */
export async function relacionPorFacturar({ arlId = null, pagadorTerceroId = null } = {}, db = pool) {
  const candidatas = (await db.query(SQL_CANDIDATAS, [arlId, pagadorTerceroId])).rows;
  // Acotada a un particular, ninguna ARL entra en la respuesta.
  const arls = pagadorTerceroId ? [] : (await db.query(
    `SELECT a.id, a.nombre, a.tercero_id,
            COALESCE(t.razon_social, btrim(concat_ws(' ', t.nombres, t.apellidos))) AS tercero_nombre
       FROM sst.arls a LEFT JOIN sst.terceros t ON t.id = a.tercero_id
      WHERE ($1::uuid IS NULL OR a.id = $1)
      ORDER BY a.nombre`,
    [arlId],
  )).rows;

  // Filas de prefactura de Bolívar que aún tienen algo por facturar. La orden
  // ligada puede ser candidata o no; `orden_finalizada_facturada` distingue las
  // que ya están facturadas de las que simplemente aún no se finalizan.
  const filas = (await db.query(
    `SELECT pf.id AS prefactura_id, f.id, o.id AS orden_id, f.codigo_cronograma, f.secuencia, f.razon_social,
            f.actividad_programa, f.transporte, f.valor_a_facturar, o.codigo AS orden_codigo,
            (o.id IS NOT NULL AND (o.estado_cobro = 'FACTURADA' OR EXISTS (
               SELECT 1 FROM sst.documento_ordenes dor
                WHERE dor.orden_id = o.id AND dor.documento_validado_id IS NOT NULL))) AS orden_finalizada_facturada
       FROM sst.prefactura_filas f
       JOIN sst.prefacturas pf ON pf.id = f.prefactura_id
       -- La orden se busca también por cronograma+secuencia (30-sep-2026): si se
       -- importó DESPUÉS de cargar la prefactura, f.orden_id sigue vacío, pero
       -- la orden ya existe y tiene que aparecer (con el motivo que le falte).
       LEFT JOIN LATERAL (
         SELECT x.id, x.codigo, x.estado_cobro
           FROM sst.ordenes_servicio x JOIN sst.arls a ON a.id = x.arl_id
          WHERE x.id = f.orden_id
             OR (f.orden_id IS NULL AND a.nombre ILIKE '%bol%var%'
                 AND x.codigo_cronograma = f.codigo_cronograma AND x.secuencia = f.secuencia)
          ORDER BY (x.id = f.orden_id) DESC
          LIMIT 1
       ) o ON true
      ORDER BY pf.fecha_corte DESC NULLS LAST, pf.numero_prefactura DESC, f.codigo_cronograma, f.secuencia`,
  )).rows;
  const prefacturas = (await db.query(
    `SELECT id, numero_prefactura, fecha_corte, valor_total FROM sst.prefacturas`,
  )).rows;

  const ordenesPorId = new Map(candidatas.map((o) => [o.id, o]));
  const pagadores = [];

  for (const arl of arls) {
    const propias = candidatas.filter((o) => o.arl_id === arl.id);
    const base = {
      clave: `arl:${arl.id}`, particular: false, pagador_tercero_id: null,
      arl_id: arl.id, arl_nombre: arl.nombre, tercero_id: arl.tercero_id, tercero_nombre: arl.tercero_nombre,
    };

    if (!esBolivar(arl.nombre)) {
      const lineas = propias.map((o) => lineaDeOrden(o));
      pagadores.push({
        ...base, modo: 'SELECCION',
        grupos: lineas.length
          ? [{ clave: `ordenes:${arl.id}`, tipo: 'ORDENES', lineas, n_facturables: lineas.filter((l) => l.facturable).length }]
          : [],
      });
      continue;
    }

    const grupos = [];
    const enPrefactura = new Set();
    for (const pf of prefacturas) {
      const susFilas = filas.filter((f) => f.prefactura_id === pf.id);
      const grupo = grupoDePrefactura(pf, susFilas, ordenesPorId);
      susFilas.forEach((f) => f.orden_id && enPrefactura.add(f.orden_id));
      if (grupo.lineas.length) grupos.push(grupo);
    }
    // Candidatas de Bolívar que ninguna prefactura cargada cubre: informativas,
    // no se pueden facturar hasta cargar la prefactura (Q-15).
    const sueltas = propias
      .filter((o) => !enPrefactura.has(o.id))
      .map((o) => lineaDeOrden(o, { motivo: motivoBloqueo(o) ?? MOTIVOS.SIN_PREFACTURA }));
    if (sueltas.length) {
      grupos.push({ clave: `sin-prefactura:${arl.id}`, tipo: 'ORDENES', sin_prefactura: true, lineas: sueltas, n_facturables: 0 });
    }
    pagadores.push({ ...base, modo: 'PREFACTURA', grupos });
  }

  // A3-01 · Clientes particulares: un pagador por tercero, y solo los que
  // tienen algo por facturar (a diferencia de las ARL, que se listan siempre:
  // son pocas y fijas; los particulares pueden ser muchos).
  const particulares = arlId ? [] : [...new Set(
    candidatas.filter((o) => !o.arl_id).map((o) => o.pagador_tercero_id),
  )];
  if (particulares.length) {
    const nombres = new Map((await db.query(
      `SELECT id, COALESCE(razon_social, btrim(concat_ws(' ', nombres, apellidos))) AS nombre
         FROM sst.terceros WHERE id = ANY($1::uuid[])`,
      [particulares],
    )).rows.map((t) => [t.id, t.nombre]));
    const porNombre = particulares.sort((a, b) => (nombres.get(a) ?? '').localeCompare(nombres.get(b) ?? '', 'es'));
    for (const terceroId of porNombre) {
      const lineas = candidatas.filter((o) => o.pagador_tercero_id === terceroId).map((o) => lineaDeOrden(o));
      pagadores.push({
        clave: `tercero:${terceroId}`, particular: true, pagador_tercero_id: terceroId,
        arl_id: null, arl_nombre: null, tercero_id: terceroId, tercero_nombre: nombres.get(terceroId) ?? null,
        modo: 'SELECCION',
        grupos: [{ clave: `ordenes:tercero:${terceroId}`, tipo: 'ORDENES', lineas, n_facturables: lineas.filter((l) => l.facturable).length }],
      });
    }
  }
  return { pagadores };
}

/**
 * Valida una selección para crear la factura (lo usará A1-04): todas las líneas
 * elegidas deben existir, ser del mismo pagador y estar libres. No escribe nada.
 *
 * @param {{arlId?: string, pagadorTerceroId?: string, ordenIds?: string[], prefacturaId?: string, filaIds?: string[]}} sel
 *   AXA/Colmena/privados: `ordenIds`. Bolívar: `prefacturaId` (+ `filaIds`
 *   opcional; sin él se toman las filas marcadas por defecto).
 */
export async function resolverSeleccion({ arlId, pagadorTerceroId = null, ordenIds = [], prefacturaId = null, filaIds = null }, db = pool) {
  if (!arlId && !pagadorTerceroId) throw badRequest('Indique el pagador (arl_id, o pagador_tercero_id si es un cliente particular).');
  if (arlId && pagadorTerceroId) throw badRequest('Indique un solo pagador: la ARL o el cliente particular.');
  const { pagadores } = await relacionPorFacturar({ arlId, pagadorTerceroId }, db);
  const pagador = pagadores[0];
  if (!pagador) {
    throw badRequest(pagadorTerceroId ? 'Ese cliente no tiene órdenes por facturar.' : 'Ese pagador no existe.');
  }

  let lineas;
  let prefactura = null;
  if (pagador.modo === 'PREFACTURA') {
    if (!prefacturaId) throw badRequest('Bolívar se factura por prefactura: indique cuál (prefactura_id).');
    const grupo = pagador.grupos.find((g) => g.prefactura?.id === prefacturaId);
    if (!grupo) throw badRequest('Esa prefactura no existe o ya no tiene nada por facturar.');
    prefactura = grupo.prefactura;
    const elegidas = filaIds ? new Set(filaIds) : null;
    lineas = grupo.lineas.filter((l) => (elegidas ? elegidas.has(l.fila_id) : l.marcada_por_defecto));
    if (elegidas) {
      const faltan = [...elegidas].filter((id) => !grupo.lineas.some((l) => l.fila_id === id));
      if (faltan.length) throw badRequest('Alguna fila elegida no pertenece a esa prefactura.');
    }
  } else {
    if (prefacturaId) throw badRequest('Solo Bolívar se factura por prefactura.');
    if (!ordenIds.length) throw badRequest('Elija al menos una orden.');
    const todas = pagador.grupos.flatMap((g) => g.lineas);
    lineas = ordenIds.map((id) => {
      const l = todas.find((x) => x.orden_id === id);
      if (!l) throw badRequest('Alguna orden elegida no es del pagador o ya no está por facturar.');
      return l;
    });
  }

  if (!lineas.length) throw badRequest('No hay nada que facturar en la selección.');
  const bloqueadas = lineas.filter((l) => !l.facturable);
  if (bloqueadas.length) {
    throw badRequest(
      `${bloqueadas.length === 1 ? 'Una orden no se puede' : `${bloqueadas.length} órdenes no se pueden`} facturar todavía: `
      + bloqueadas.map((l) => `${l.codigo ?? `${l.codigo_cronograma}/${l.secuencia}`} (${l.motivo})`).join('; '),
      { bloqueadas: bloqueadas.map((l) => ({ clave: l.clave, motivo: l.motivo })) },
    );
  }
  return {
    pagador: {
      arl_id: pagador.arl_id, arl_nombre: pagador.arl_nombre,
      pagador_tercero_id: pagador.pagador_tercero_id, particular: pagador.particular,
      tercero_id: pagador.tercero_id, tercero_nombre: pagador.tercero_nombre,
    },
    prefactura,
    lineas,
    total: total(lineas),
  };
}
