import { pool, withTransaction } from '../../config/db.js';
import { badRequest, conflict, forbidden, notFound } from '../../utils/httpError.js';
import { aCentavos, deCentavos } from '../../utils/dinero.js';

/**
 * B1-01 (CNT-02, CNT-03) · Motor de comprobantes: el libro diario.
 *
 * Todo hecho contable es un comprobante (tipo + consecutivo) con sus movimientos.
 * Las reglas duras viven aquí y, como última defensa, en la base (triggers de la
 * migración 2026-09-29-comprobantes.sql). Aquí se validan antes para devolver un
 * mensaje que la contadora entienda; allá, por si algún día alguien escribe directo.
 *
 * Las funciones que escriben aceptan `client` para correr DENTRO de otra
 * transacción: B2-01 contabiliza una factura en la misma transacción que la
 * valida, y si el asiento falla no queda media cosa hecha.
 */

const NOMBRE_TERCERO = `COALESCE(t.razon_social, NULLIF(btrim(concat_ws(' ', t.nombres, t.apellidos)), ''))`;

const conTransaccion = (client, fn) => (client ? fn(client) : withTransaction(fn));

// ─── Tipos y consecutivos ────────────────────────────────────────────────────

export async function listarTiposComprobante(db = pool) {
  const r = await db.query(
    `SELECT id, codigo, nombre, consecutivo_actual, manual, activo FROM sst.tipos_comprobante ORDER BY codigo`,
  );
  return r.rows;
}

/** Siguiente número del tipo. El UPDATE bloquea la fila: dos contabilizaciones a la vez no sacan el mismo. */
async function siguienteNumero(client, tipoId) {
  const r = await client.query(
    `UPDATE sst.tipos_comprobante SET consecutivo_actual = consecutivo_actual + 1 WHERE id = $1 RETURNING consecutivo_actual`,
    [tipoId],
  );
  return r.rows[0].consecutivo_actual;
}

// ─── Periodos ─────────────────────────────────────────────────────────────────

async function periodoCerrado(client, fecha) {
  const r = await client.query(`SELECT sst.fn_periodo_cerrado($1::date) AS cerrado`, [fecha]);
  return r.rows[0].cerrado;
}

const etiquetaPeriodo = (fecha) => String(fecha).slice(0, 7);

/** Los 12 meses del año con su estado y cuántos comprobantes tienen (un mes sin fila está abierto). */
export async function listarPeriodos(anio, db = pool) {
  const r = await db.query(
    `SELECT m.mes, COALESCE(p.estado, 'ABIERTO') AS estado, p.cerrado_en, p.reabierto_en, p.motivo_reapertura,
            (SELECT count(*)::int FROM sst.comprobantes c WHERE c.anio = $1 AND c.mes = m.mes AND c.estado = 'CONTABILIZADO') AS contabilizados,
            (SELECT count(*)::int FROM sst.comprobantes c WHERE c.anio = $1 AND c.mes = m.mes AND c.estado = 'BORRADOR') AS borradores
       FROM generate_series(1, 12) AS m(mes)
       LEFT JOIN sst.periodos_contables p ON p.anio = $1 AND p.mes = m.mes
      ORDER BY m.mes`,
    [anio],
  );
  return r.rows;
}

const validarAnioMes = (anio, mes) => {
  const a = Number(anio);
  const m = Number(mes);
  if (!Number.isInteger(a) || a < 2000 || a > 2100) throw badRequest('Año inválido.');
  if (!Number.isInteger(m) || m < 1 || m > 12) throw badRequest('Mes inválido.');
  return [a, m];
};

/**
 * Cierra un mes: desde ahí nada se contabiliza ni se anula con fecha de ese mes.
 * No se cierra con borradores pendientes: quedarían atrapados sin poder
 * contabilizarse, y lo normal es que sean justo lo que faltaba registrar.
 */
export async function cerrarPeriodo(anio, mes, usuarioId) {
  const [a, m] = validarAnioMes(anio, mes);
  return withTransaction(async (client) => {
    const borradores = (await client.query(
      `SELECT count(*)::int AS n FROM sst.comprobantes WHERE anio = $1 AND mes = $2 AND estado = 'BORRADOR'`, [a, m],
    )).rows[0].n;
    if (borradores) {
      throw badRequest(`Hay ${borradores} comprobante(s) en borrador en ${a}-${String(m).padStart(2, '0')}: contabilícelos o elimínelos antes de cerrar.`);
    }
    await client.query(
      `INSERT INTO sst.periodos_contables (anio, mes, estado, cerrado_por, cerrado_en)
       VALUES ($1, $2, 'CERRADO', $3, now())
       ON CONFLICT (anio, mes) DO UPDATE SET estado = 'CERRADO', cerrado_por = $3, cerrado_en = now()`,
      [a, m, usuarioId],
    );
    return (await listarPeriodos(a, client)).find((p) => p.mes === m);
  });
}

/** Reabre un mes cerrado. Solo admin (lo exige la ruta) y siempre con motivo: queda escrito quién y por qué. */
export async function reabrirPeriodo(anio, mes, motivo, usuarioId) {
  const [a, m] = validarAnioMes(anio, mes);
  const texto = String(motivo ?? '').trim();
  if (texto.length < 5) throw badRequest('Escriba el motivo de la reapertura.');
  return withTransaction(async (client) => {
    const r = await client.query(
      `UPDATE sst.periodos_contables
          SET estado = 'ABIERTO', reabierto_por = $3, reabierto_en = now(), motivo_reapertura = $4
        WHERE anio = $1 AND mes = $2 AND estado = 'CERRADO' RETURNING id`,
      [a, m, usuarioId, texto],
    );
    if (!r.rows[0]) throw badRequest('Ese mes no está cerrado.');
    return (await listarPeriodos(a, client)).find((p) => p.mes === m);
  });
}

// ─── Validación de líneas ────────────────────────────────────────────────────

/**
 * Normaliza y valida las líneas: cuenta activa con movimiento, tercero si la
 * cuenta lo exige, débito O crédito (positivo, al centavo). Devuelve las líneas en
 * centavos y los totales, que se guardan en el comprobante.
 */
async function validarLineas(client, lineas) {
  if (!Array.isArray(lineas) || !lineas.length) throw badRequest('El comprobante necesita movimientos.');
  const cuentaIds = [...new Set(lineas.map((l) => l?.cuenta_id).filter(Boolean))];
  const cuentas = new Map((await client.query(
    `SELECT id, codigo, nombre, acepta_movimiento, activa, exige_tercero FROM sst.cuentas_contables WHERE id = ANY($1::uuid[])`,
    [cuentaIds],
  )).rows.map((c) => [c.id, c]));
  const terceroIds = [...new Set(lineas.map((l) => l?.tercero_id).filter(Boolean))];
  const terceros = new Set((await client.query(
    `SELECT id FROM sst.terceros WHERE id = ANY($1::uuid[])`, [terceroIds],
  )).rows.map((t) => t.id));

  let debito = 0;
  let credito = 0;
  const salida = lineas.map((l, i) => {
    const n = i + 1;
    const cuenta = cuentas.get(l?.cuenta_id);
    if (!cuenta) throw badRequest(`Línea ${n}: elija una cuenta del plan de cuentas.`);
    if (!cuenta.activa) throw badRequest(`Línea ${n}: la cuenta ${cuenta.codigo} está inactiva.`);
    if (!cuenta.acepta_movimiento) {
      throw badRequest(`Línea ${n}: la cuenta ${cuenta.codigo} agrupa otras cuentas y no recibe movimiento; use una de sus auxiliares.`);
    }
    const terceroId = l.tercero_id || null;
    if (terceroId && !terceros.has(terceroId)) throw badRequest(`Línea ${n}: ese tercero no existe.`);
    if (cuenta.exige_tercero && !terceroId) throw badRequest(`Línea ${n}: la cuenta ${cuenta.codigo} exige tercero.`);

    const d = l.debito == null || l.debito === '' ? 0 : aCentavos(l.debito);
    const c = l.credito == null || l.credito === '' ? 0 : aCentavos(l.credito);
    if (!Number.isFinite(d) || !Number.isFinite(c) || d < 0 || c < 0) throw badRequest(`Línea ${n}: los valores deben ser números positivos.`);
    if ((d > 0) === (c > 0)) throw badRequest(`Línea ${n}: lleva débito o crédito, uno de los dos.`);
    debito += d;
    credito += c;
    return {
      linea: n, cuenta_id: cuenta.id, tercero_id: terceroId, centro_costo_id: l.centro_costo_id || null,
      debito: deCentavos(d), credito: deCentavos(c),
      base: l.base == null || l.base === '' ? null : deCentavos(aCentavos(l.base)),
      descripcion: l.descripcion ? String(l.descripcion).trim().slice(0, 500) || null : null,
      documento_cruce: l.documento_cruce ? String(l.documento_cruce).trim().slice(0, 60) || null : null,
      documento_cruce_id: l.documento_cruce_id || null,
    };
  });
  return { lineas: salida, debito, credito };
}

const validarFecha = (v) => {
  const f = String(v ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f) || Number.isNaN(Date.parse(f))) throw badRequest('La fecha del comprobante no es válida (AAAA-MM-DD).');
  return f;
};

async function guardarLineas(client, comprobanteId, lineas) {
  await client.query(`DELETE FROM sst.movimientos WHERE comprobante_id = $1`, [comprobanteId]);
  for (const l of lineas) {
    await client.query(
      `INSERT INTO sst.movimientos (comprobante_id, linea, cuenta_id, tercero_id, centro_costo_id, debito, credito,
                                    base, descripcion, documento_cruce, documento_cruce_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [comprobanteId, l.linea, l.cuenta_id, l.tercero_id, l.centro_costo_id, l.debito, l.credito,
       l.base, l.descripcion, l.documento_cruce, l.documento_cruce_id],
    );
  }
}

// ─── Lectura ──────────────────────────────────────────────────────────────────

const SELECT_COMPROBANTE = `
  c.id, c.tipo_id, tc.codigo AS tipo_codigo, tc.nombre AS tipo_nombre, tc.manual AS tipo_manual,
  c.numero, CASE WHEN c.numero IS NULL THEN NULL ELSE tc.codigo || '-' || c.numero END AS numero_completo,
  to_char(c.fecha, 'YYYY-MM-DD') AS fecha, c.anio, c.mes, c.descripcion, c.estado, c.origen_tipo, c.origen_id,
  c.total_debito, c.total_credito, c.contabilizado_en, c.anulado_en, c.motivo_anulacion,
  c.creado_en, c.actualizado_en, uc.nombre AS creado_por_nombre`;
const FROM_COMPROBANTE = `
  FROM sst.comprobantes c
  JOIN sst.tipos_comprobante tc ON tc.id = c.tipo_id
  LEFT JOIN sst.usuarios uc ON uc.id = c.creado_por`;

export async function obtenerComprobante(id, db = pool) {
  const c = (await db.query(`SELECT ${SELECT_COMPROBANTE} ${FROM_COMPROBANTE} WHERE c.id = $1`, [id])).rows[0];
  if (!c) throw notFound('Ese comprobante no existe.');
  const movimientos = (await db.query(
    `SELECT m.id, m.linea, m.cuenta_id, cc.codigo AS cuenta_codigo, cc.nombre AS cuenta_nombre,
            m.tercero_id, ${NOMBRE_TERCERO} AS tercero_nombre, t.numero_documento AS tercero_documento,
            m.centro_costo_id, m.debito, m.credito, m.base, m.descripcion, m.documento_cruce, m.documento_cruce_id
       FROM sst.movimientos m
       JOIN sst.cuentas_contables cc ON cc.id = m.cuenta_id
       LEFT JOIN sst.terceros t ON t.id = m.tercero_id
      WHERE m.comprobante_id = $1 ORDER BY m.linea`,
    [id],
  )).rows;
  return { ...c, movimientos };
}

/** Listado con filtros. `q` busca en la descripción, el número completo o el documento cruce de sus líneas. */
export async function listarComprobantes(f = {}, db = pool) {
  const params = [];
  const w = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  if (f.tipo) w.push(`tc.codigo = ${p(String(f.tipo).toUpperCase())}`);
  if (f.estado) w.push(`c.estado = ANY(${p(String(f.estado).toUpperCase().split(','))})`);
  if (f.desde) w.push(`c.fecha >= ${p(validarFecha(f.desde))}`);
  if (f.hasta) w.push(`c.fecha <= ${p(validarFecha(f.hasta))}`);
  if (f.cuentaId) w.push(`EXISTS (SELECT 1 FROM sst.movimientos m WHERE m.comprobante_id = c.id AND m.cuenta_id = ${p(f.cuentaId)})`);
  if (f.terceroId) w.push(`EXISTS (SELECT 1 FROM sst.movimientos m WHERE m.comprobante_id = c.id AND m.tercero_id = ${p(f.terceroId)})`);
  if (f.q && String(f.q).trim()) {
    const q = p(`%${String(f.q).trim()}%`);
    w.push(`(c.descripcion ILIKE ${q} OR (tc.codigo || '-' || c.numero) ILIKE ${q}
             OR EXISTS (SELECT 1 FROM sst.movimientos m WHERE m.comprobante_id = c.id AND m.documento_cruce ILIKE ${q}))`);
  }
  const limit = Math.min(Math.max(Number.parseInt(f.limit, 10) || 200, 1), 1000);
  const r = await db.query(
    `SELECT ${SELECT_COMPROBANTE},
            (SELECT count(*)::int FROM sst.movimientos m WHERE m.comprobante_id = c.id) AS n_movimientos
       ${FROM_COMPROBANTE}
      ${w.length ? `WHERE ${w.join(' AND ')}` : ''}
      ORDER BY c.fecha DESC, tc.codigo, c.numero DESC NULLS FIRST, c.creado_en DESC
      LIMIT ${p(limit)}`,
    params,
  );
  return r.rows;
}

// ─── Escritura ────────────────────────────────────────────────────────────────

/**
 * Crea un comprobante. `soloManual` lo usa la pantalla: a mano solo se crean los
 * tipos marcados como manuales (NI); los demás nacen de su documento (factura,
 * recibo…) y crearlos a mano duplicaría el asiento.
 *
 * Con `contabilizar` queda CONTABILIZADO en el acto (el caso de B2-01); si no,
 * queda en BORRADOR, sin número, para revisarlo.
 */
export async function crearComprobante(b = {}, usuarioId = null, { client = null, soloManual = false } = {}) {
  return conTransaccion(client, async (db) => {
    const tipo = (await db.query(
      `SELECT id, codigo, manual, activo FROM sst.tipos_comprobante WHERE codigo = $1`, [String(b.tipo ?? '').toUpperCase()],
    )).rows[0];
    if (!tipo || !tipo.activo) throw badRequest('Ese tipo de comprobante no existe.');
    if (soloManual && !tipo.manual) {
      throw badRequest(`Los comprobantes ${tipo.codigo} los genera el sistema a partir de su documento; a mano solo se registran notas internas.`);
    }
    const fecha = validarFecha(b.fecha);
    const { lineas, debito, credito } = await validarLineas(db, b.lineas);

    const r = await db.query(
      `INSERT INTO sst.comprobantes (tipo_id, fecha, descripcion, origen_tipo, origen_id, total_debito, total_credito,
                                     creado_por, actualizado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING id`,
      [tipo.id, fecha, b.descripcion ? String(b.descripcion).trim().slice(0, 1000) : null,
       b.origen_tipo ?? null, b.origen_id ?? null, deCentavos(debito), deCentavos(credito), usuarioId],
    );
    const id = r.rows[0].id;
    await guardarLineas(db, id, lineas);
    if (b.contabilizar) await contabilizarComprobante(id, usuarioId, { client: db });
    return obtenerComprobante(id, db);
  });
}

/** Reemplaza fecha, descripción y líneas de un BORRADOR. */
export async function actualizarBorrador(id, b = {}, usuarioId = null) {
  return withTransaction(async (client) => {
    const actual = (await client.query(`SELECT id, estado, fecha FROM sst.comprobantes WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!actual) throw notFound('Ese comprobante no existe.');
    if (actual.estado !== 'BORRADOR') throw conflict('Solo se edita un comprobante en borrador; uno contabilizado se anula y se hace otro.');
    const fecha = b.fecha ? validarFecha(b.fecha) : null;
    const { lineas, debito, credito } = await validarLineas(client, b.lineas);
    await client.query(
      `UPDATE sst.comprobantes
          SET fecha = COALESCE($2::date, fecha), descripcion = $3, total_debito = $4, total_credito = $5, actualizado_por = $6
        WHERE id = $1`,
      [id, fecha, b.descripcion ? String(b.descripcion).trim().slice(0, 1000) : null, deCentavos(debito), deCentavos(credito), usuarioId],
    );
    await guardarLineas(client, id, lineas);
    return obtenerComprobante(id, client);
  });
}

/**
 * BORRADOR → CONTABILIZADO: valida el cuadre y el periodo, y le da su número.
 * Los mensajes salen de aquí; el trigger diferido repite las comprobaciones al commit.
 */
export async function contabilizarComprobante(id, usuarioId = null, { client = null } = {}) {
  return conTransaccion(client, async (db) => {
    const c = (await db.query(`SELECT id, tipo_id, estado, to_char(fecha, 'YYYY-MM-DD') AS fecha FROM sst.comprobantes WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!c) throw notFound('Ese comprobante no existe.');
    if (c.estado !== 'BORRADOR') throw conflict(`El comprobante ya está ${c.estado.toLowerCase()}.`);
    if (await periodoCerrado(db, c.fecha)) {
      throw badRequest(`El periodo ${etiquetaPeriodo(c.fecha)} está cerrado: cambie la fecha o pida reabrir el mes.`);
    }
    const lineas = (await db.query(
      `SELECT cuenta_id, tercero_id, centro_costo_id, debito, credito FROM sst.movimientos WHERE comprobante_id = $1 ORDER BY linea`, [id],
    )).rows;
    const { debito, credito } = await validarLineas(db, lineas);
    if (lineas.length < 2) throw badRequest('El comprobante necesita al menos dos movimientos.');
    if (debito !== credito) {
      throw badRequest(`El comprobante no cuadra: débitos ${deCentavos(debito)} y créditos ${deCentavos(credito)} (diferencia ${deCentavos(Math.abs(debito - credito))}).`);
    }
    const numero = await siguienteNumero(db, c.tipo_id);
    await db.query(
      `UPDATE sst.comprobantes
          SET estado = 'CONTABILIZADO', numero = $2, total_debito = $3, total_credito = $3,
              contabilizado_por = $4, contabilizado_en = now(), actualizado_por = $4
        WHERE id = $1`,
      [id, numero, deCentavos(debito), usuarioId],
    );
    return obtenerComprobante(id, db);
  });
}

/**
 * CONTABILIZADO → ANULADO. No se borra ni se edita: queda con su número y sus
 * líneas, fuera de los saldos, y con el motivo. Lo que dependía de él (una factura,
 * un recibo) se rehace aparte.
 */
export async function anularComprobante(id, motivo, usuarioId = null, { client = null, permitirOrigen = false } = {}) {
  const texto = String(motivo ?? '').trim();
  if (texto.length < 5) throw badRequest('Escriba el motivo de la anulación.');
  return conTransaccion(client, async (db) => {
    const c = (await db.query(
      `SELECT c.id, c.estado, to_char(c.fecha, 'YYYY-MM-DD') AS fecha, c.origen_tipo, tc.manual
         FROM sst.comprobantes c JOIN sst.tipos_comprobante tc ON tc.id = c.tipo_id WHERE c.id = $1 FOR UPDATE OF c`,
      [id],
    )).rows[0];
    if (!c) throw notFound('Ese comprobante no existe.');
    if (c.estado !== 'CONTABILIZADO') throw conflict(`Solo se anula un comprobante contabilizado (este está ${c.estado.toLowerCase()}).`);
    // El asiento de una factura se anula anulando la factura (nota crédito): si se
    // anulara suelto, la factura seguiría viva sin su contabilidad.
    if (c.origen_tipo && !permitirOrigen) {
      throw forbidden('Este comprobante lo generó un documento; se anula desde ese documento, no desde aquí.');
    }
    if (await periodoCerrado(db, c.fecha)) throw badRequest(`El periodo ${etiquetaPeriodo(c.fecha)} está cerrado: no se puede anular.`);
    await db.query(
      `UPDATE sst.comprobantes SET estado = 'ANULADO', anulado_por = $2, anulado_en = now(), motivo_anulacion = $3, actualizado_por = $2
        WHERE id = $1`,
      [id, usuarioId, texto],
    );
    return obtenerComprobante(id, db);
  });
}

/** Un borrador (sin número) sí se borra: nunca llegó a ser contabilidad. */
export async function eliminarBorrador(id) {
  const r = await pool.query(`DELETE FROM sst.comprobantes WHERE id = $1 AND estado = 'BORRADOR' RETURNING id`, [id]);
  if (!r.rows[0]) throw conflict('Solo se elimina un comprobante en borrador (o ya no existe).');
}
