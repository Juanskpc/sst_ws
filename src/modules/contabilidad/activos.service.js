import QRCode from 'qrcode';
import { pool, withTransaction } from '../../config/db.js';
import { badRequest, conflict, notFound } from '../../utils/httpError.js';
import { aCentavos, deCentavos } from '../../utils/dinero.js';
import { hoyCO } from '../../utils/formato.js';
import { env } from '../../config/env.js';
import { anularComprobante, crearComprobante } from './comprobantes.service.js';

/**
 * C7-01 (ACT-01..03) · Activos fijos.
 *
 * Registro del activo, depreciación mensual en línea recta con un comprobante DP
 * automático y un QR por activo que abre su ficha. Asignaciones, traslados y
 * bajas quedan fuera (cotización §8).
 *
 * Línea recta: cuota = (costo − valor residual) / vida útil, redondeada half-up a
 * centavos; la última cuota se lleva el residuo del redondeo, así la suma de las
 * cuotas es exactamente lo depreciable y el activo termina en su valor residual.
 *
 * Registrar el activo NO genera asiento: la compra ya entró por Compras (B5-01).
 * Este módulo solo contabiliza la depreciación, con las tres cuentas que la
 * contadora elige en cada ficha (activo, depreciación acumulada y gasto).
 */

const ORIGEN = 'DEPRECIACION';

/** Dentro de la transacción de quien llama (las verificaciones con ROLLBACK) o en una propia. */
const conTransaccion = (client, fn) => (client ? fn(client) : withTransaction(fn));

const indiceMes = (anio, mes) => anio * 12 + (mes - 1);
const deIndice = (i) => ({ anio: Math.floor(i / 12), mes: (i % 12) + 1 });
const ultimoDia = (anio, mes) => {
  const d = new Date(Date.UTC(anio, mes, 0));
  return `${anio}-${String(mes).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};

const validarFecha = (v, texto) => {
  const f = String(v ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f) || Number.isNaN(Date.parse(f))) throw badRequest(`La ${texto} no es válida (AAAA-MM-DD).`);
  return f;
};
const validarAnioMes = (anio, mes) => {
  const a = Number(anio);
  const m = Number(mes);
  if (!Number.isInteger(a) || a < 2000 || a > 2100 || !Number.isInteger(m) || m < 1 || m > 12) throw badRequest('Mes inválido.');
  return { anio: a, mes: m };
};

/** Cuota `k` (1..vida) en centavos: la última absorbe el redondeo. */
export function cuotaCentavos(activo, k) {
  const vida = Number(activo.vida_util_meses);
  if (k < 1 || k > vida) return 0;
  const depreciable = aCentavos(activo.valor_compra) - aCentavos(activo.valor_residual);
  const normal = Math.floor((depreciable * 2 + vida) / (vida * 2)); // half-up de depreciable / vida
  return k < vida ? normal : depreciable - normal * (vida - 1);
}

/** Número de cuota que corresponde al mes (anio, mes); < 1 si aún no empieza. */
function cuotaDelMes(activo, anio, mes) {
  const [ia, im] = String(activo.inicio_depreciacion).slice(0, 7).split('-').map(Number);
  return indiceMes(anio, mes) - indiceMes(ia, im) + 1;
}

const SELECT = `
  a.id, a.codigo, a.descripcion, a.serial, a.ubicacion, a.responsable, a.proveedor_id,
  COALESCE(t.razon_social, NULLIF(btrim(concat_ws(' ', t.nombres, t.apellidos)), '')) AS proveedor_nombre,
  a.fecha_compra::text AS fecha_compra, a.valor_compra, a.valor_residual, a.vida_util_meses,
  a.inicio_depreciacion::text AS inicio_depreciacion,
  a.cuenta_activo_id, ca.codigo AS cuenta_activo_codigo, ca.nombre AS cuenta_activo_nombre,
  a.cuenta_depreciacion_id, cd.codigo AS cuenta_depreciacion_codigo, cd.nombre AS cuenta_depreciacion_nombre,
  a.cuenta_gasto_id, cg.codigo AS cuenta_gasto_codigo, cg.nombre AS cuenta_gasto_nombre,
  a.centro_costo_id, cc.codigo AS centro_costo_codigo, a.observaciones, a.creado_en,
  COALESCE(dep.acumulada, 0)::numeric(16,2) AS depreciacion_acumulada,
  COALESCE(dep.cuotas, 0)::int AS cuotas_registradas,
  dep.ultimo AS ultimo_mes_depreciado`;
const FROM = `
  FROM sst.activos_fijos a
  JOIN sst.cuentas_contables ca ON ca.id = a.cuenta_activo_id
  JOIN sst.cuentas_contables cd ON cd.id = a.cuenta_depreciacion_id
  JOIN sst.cuentas_contables cg ON cg.id = a.cuenta_gasto_id
  LEFT JOIN sst.terceros t ON t.id = a.proveedor_id
  LEFT JOIN sst.centros_costo cc ON cc.id = a.centro_costo_id
  LEFT JOIN LATERAL (
    SELECT sum(d.valor) AS acumulada, count(*) AS cuotas,
           max(d.anio * 100 + d.mes) AS ultimo
      FROM sst.depreciaciones_activo d WHERE d.activo_id = a.id
  ) dep ON true`;

function conValorEnLibros(a) {
  const libros = aCentavos(a.valor_compra) - aCentavos(a.depreciacion_acumulada);
  return {
    ...a,
    valor_en_libros: deCentavos(libros),
    cuota_mensual: deCentavos(cuotaCentavos(a, 1)),
    totalmente_depreciado: a.cuotas_registradas >= a.vida_util_meses,
    ultimo_mes_depreciado: a.ultimo_mes_depreciado
      ? `${String(a.ultimo_mes_depreciado).slice(0, 4)}-${String(a.ultimo_mes_depreciado).slice(4)}` : null,
  };
}

export async function listarActivos(db = pool) {
  const r = await db.query(`SELECT ${SELECT} ${FROM} ORDER BY a.codigo`);
  return r.rows.map(conValorEnLibros);
}

/** Ficha con la tabla de depreciación completa: lo registrado y lo que falta (proyectado). */
export async function obtenerActivo(id, db = pool) {
  const a = (await db.query(`SELECT ${SELECT} ${FROM} WHERE a.id = $1`, [id])).rows[0];
  if (!a) throw notFound('Ese activo no existe.');
  const registradas = new Map((await db.query(
    `SELECT d.cuota, d.valor, d.anio, d.mes, m.comprobante_id, 'DP-' || c.numero AS comprobante
       FROM sst.depreciaciones_activo d
       JOIN sst.depreciaciones_mes m ON m.id = d.corrida_id
       LEFT JOIN sst.comprobantes c ON c.id = m.comprobante_id
      WHERE d.activo_id = $1`, [id],
  )).rows.map((r) => [r.cuota, r]));
  const [ia, im] = a.inicio_depreciacion.slice(0, 7).split('-').map(Number);
  const base = indiceMes(ia, im);
  let acumulada = 0;
  const tabla = [];
  for (let k = 1; k <= a.vida_util_meses; k++) {
    const { anio, mes } = deIndice(base + k - 1);
    const reg = registradas.get(k);
    const valor = reg ? aCentavos(reg.valor) : cuotaCentavos(a, k);
    acumulada += valor;
    tabla.push({
      cuota: k, anio, mes, valor: deCentavos(valor), acumulada: deCentavos(acumulada),
      valor_en_libros: deCentavos(aCentavos(a.valor_compra) - acumulada),
      registrada: !!reg, comprobante_id: reg?.comprobante_id ?? null, comprobante: reg?.comprobante ?? null,
    });
  }
  return { ...conValorEnLibros(a), tabla, url_ficha: urlFicha(id) };
}

const urlFicha = (id) => `${env.publicAppUrl}/contabilidad?activo=${id}`;

/** El QR lleva a la ficha dentro de ORBITA (pide sesión: es solo de consulta interna). */
export async function qrActivo(id, db = pool) {
  const a = (await db.query(`SELECT id FROM sst.activos_fijos WHERE id = $1`, [id])).rows[0];
  if (!a) throw notFound('Ese activo no existe.');
  return QRCode.toBuffer(urlFicha(id), { type: 'png', width: 360, margin: 1, errorCorrectionLevel: 'M' });
}

// ─── Escritura ────────────────────────────────────────────────────────────────

async function validarCuenta(db, id, texto, { exigeTercero = 'rechaza' } = {}) {
  if (!id) throw badRequest(`Elija la cuenta de ${texto}.`);
  const c = (await db.query(
    `SELECT id, codigo, acepta_movimiento, activa, exige_tercero, exige_centro_costo FROM sst.cuentas_contables WHERE id = $1`, [id],
  )).rows[0];
  if (!c) throw badRequest(`La cuenta de ${texto} no existe.`);
  if (!c.acepta_movimiento || !c.activa) throw badRequest(`La cuenta ${c.codigo} (${texto}) no recibe movimiento o está inactiva.`);
  // El DP no lleva tercero: una cuenta que lo exige no se podría contabilizar.
  if (c.exige_tercero && exigeTercero === 'rechaza') throw badRequest(`La cuenta ${c.codigo} (${texto}) exige tercero; la depreciación no lleva tercero.`);
  return c;
}

async function leerActivo(db, b, previo = null) {
  const v = { ...previo, ...b };
  const descripcion = String(v.descripcion ?? '').trim();
  if (!descripcion) throw badRequest('Escriba la descripción del activo.');
  const fechaCompra = validarFecha(v.fecha_compra, 'fecha de compra');
  const valor = aCentavos(v.valor_compra ?? 0);
  const residual = aCentavos(v.valor_residual || 0);
  if (valor <= 0) throw badRequest('El valor de compra debe ser mayor que cero.');
  if (residual < 0 || residual >= valor) throw badRequest('El valor residual debe ser menor que el de compra.');
  const vida = Number(v.vida_util_meses);
  if (!Number.isInteger(vida) || vida < 1 || vida > 1200) throw badRequest('La vida útil va en meses enteros (1 a 1200).');
  // Por defecto, el mes siguiente a la compra.
  let inicio = v.inicio_depreciacion ? validarFecha(v.inicio_depreciacion, 'fecha de inicio') : null;
  if (!inicio) {
    const [a, m] = fechaCompra.slice(0, 7).split('-').map(Number);
    const sig = deIndice(indiceMes(a, m) + 1);
    inicio = `${sig.anio}-${String(sig.mes).padStart(2, '0')}-01`;
  }
  inicio = `${inicio.slice(0, 7)}-01`;
  await validarCuenta(db, v.cuenta_activo_id, 'activo', { exigeTercero: 'permite' });
  await validarCuenta(db, v.cuenta_depreciacion_id, 'depreciación acumulada');
  const gasto = await validarCuenta(db, v.cuenta_gasto_id, 'gasto por depreciación');
  const centro = v.centro_costo_id || null;
  if (gasto.exige_centro_costo && !centro) throw badRequest(`La cuenta ${gasto.codigo} exige centro de costo: elíjalo en la ficha.`);
  const texto = (x) => (x == null || String(x).trim() === '' ? null : String(x).trim().slice(0, 500));
  return {
    descripcion: descripcion.slice(0, 300), serial: texto(v.serial), ubicacion: texto(v.ubicacion), responsable: texto(v.responsable),
    proveedor_id: v.proveedor_id || null, fecha_compra: fechaCompra, valor_compra: deCentavos(valor), valor_residual: deCentavos(residual),
    vida_util_meses: vida, inicio_depreciacion: inicio, cuenta_activo_id: v.cuenta_activo_id,
    cuenta_depreciacion_id: v.cuenta_depreciacion_id, cuenta_gasto_id: v.cuenta_gasto_id, centro_costo_id: centro,
    observaciones: texto(v.observaciones),
  };
}

const COLUMNAS = ['descripcion', 'serial', 'ubicacion', 'responsable', 'proveedor_id', 'fecha_compra', 'valor_compra', 'valor_residual',
  'vida_util_meses', 'inicio_depreciacion', 'cuenta_activo_id', 'cuenta_depreciacion_id', 'cuenta_gasto_id', 'centro_costo_id', 'observaciones'];
// Una vez depreciado, lo que cambia el cálculo o el asiento ya no se toca: el
// libro tiene cuotas hechas con esos valores.
const CONGELADAS = ['fecha_compra', 'valor_compra', 'valor_residual', 'vida_util_meses', 'inicio_depreciacion', 'cuenta_activo_id', 'cuenta_depreciacion_id'];

export async function crearActivo(b = {}, usuarioId = null, { client = null } = {}) {
  return conTransaccion(client, async (db) => {
    const v = await leerActivo(db, b);
    const r = await db.query(
      `INSERT INTO sst.activos_fijos (${COLUMNAS.join(', ')}, creado_por, actualizado_por)
       VALUES (${COLUMNAS.map((_, i) => `$${i + 1}`).join(', ')}, $${COLUMNAS.length + 1}, $${COLUMNAS.length + 1}) RETURNING id`,
      [...COLUMNAS.map((c) => v[c]), usuarioId],
    );
    return obtenerActivo(r.rows[0].id, db);
  });
}

export async function actualizarActivo(id, b = {}, usuarioId = null, { client = null } = {}) {
  return conTransaccion(client, async (db) => {
    // Las fechas como texto: así se comparan igual que las que llegan del formulario.
    const previo = (await db.query(
      `SELECT ${COLUMNAS.map((c) => (c === 'fecha_compra' || c === 'inicio_depreciacion' ? `${c}::text AS ${c}` : c)).join(', ')}
         FROM sst.activos_fijos WHERE id = $1 FOR UPDATE`, [id],
    )).rows[0];
    if (!previo) throw notFound('Ese activo no existe.');
    const v = await leerActivo(db, b, previo);
    const cuotas = (await db.query(`SELECT count(*)::int AS n FROM sst.depreciaciones_activo WHERE activo_id = $1`, [id])).rows[0].n;
    if (cuotas && CONGELADAS.some((c) => String(v[c] ?? '') !== String(previo[c] ?? ''))) {
      throw conflict('El activo ya tiene depreciación registrada: el valor, la vida útil, las fechas y las cuentas del activo ya no se cambian (revierta las depreciaciones primero).');
    }
    await db.query(
      `UPDATE sst.activos_fijos SET ${COLUMNAS.map((c, i) => `${c} = $${i + 2}`).join(', ')}, actualizado_por = $${COLUMNAS.length + 2}
        WHERE id = $1`,
      [id, ...COLUMNAS.map((c) => v[c]), usuarioId],
    );
    return obtenerActivo(id, db);
  });
}

export async function eliminarActivo(id, { client = null } = {}) {
  return conTransaccion(client, async (db) => {
    const cuotas = (await db.query(`SELECT count(*)::int AS n FROM sst.depreciaciones_activo WHERE activo_id = $1`, [id])).rows[0].n;
    if (cuotas) throw conflict('El activo ya tiene depreciación registrada: no se puede borrar.');
    const r = await db.query(`DELETE FROM sst.activos_fijos WHERE id = $1`, [id]);
    if (!r.rowCount) throw notFound('Ese activo no existe.');
  });
}

// ─── Depreciación mensual ─────────────────────────────────────────────────────

/**
 * Lo que depreciaría el mes: por activo, las cuotas pendientes hasta ese mes
 * (un activo dado de alta tarde se pone al día de una vez, cuota por cuota).
 */
async function armarCorrida(db, anio, mes) {
  const activos = (await db.query(
    `SELECT a.*, a.inicio_depreciacion::text AS inicio_depreciacion,
            COALESCE((SELECT max(d.cuota) FROM sst.depreciaciones_activo d WHERE d.activo_id = a.id), 0) AS ultima_cuota
       FROM sst.activos_fijos a
      WHERE a.inicio_depreciacion <= $1::date
      ORDER BY a.codigo`,
    [ultimoDia(anio, mes)],
  )).rows;
  const items = [];
  for (const a of activos) {
    const hasta = Math.min(cuotaDelMes(a, anio, mes), a.vida_util_meses);
    const cuotas = [];
    for (let k = Number(a.ultima_cuota) + 1; k <= hasta; k++) {
      const [ia, im] = a.inicio_depreciacion.slice(0, 7).split('-').map(Number);
      cuotas.push({ cuota: k, ...deIndice(indiceMes(ia, im) + k - 1), valor: cuotaCentavos(a, k) });
    }
    if (!cuotas.length) continue;
    items.push({ activo: a, cuotas, total: cuotas.reduce((s, c) => s + c.valor, 0) });
  }
  return items;
}

async function ultimaCorrida(db) {
  return (await db.query(
    `SELECT id, anio, mes, comprobante_id FROM sst.depreciaciones_mes ORDER BY anio DESC, mes DESC LIMIT 1`,
  )).rows[0] ?? null;
}

export async function listarCorridas(db = pool) {
  return (await db.query(
    `SELECT m.id, m.anio, m.mes, m.total, m.comprobante_id, 'DP-' || c.numero AS comprobante, m.creado_en,
            (SELECT count(DISTINCT d.activo_id)::int FROM sst.depreciaciones_activo d WHERE d.corrida_id = m.id) AS activos
       FROM sst.depreciaciones_mes m LEFT JOIN sst.comprobantes c ON c.id = m.comprobante_id
      ORDER BY m.anio DESC, m.mes DESC`,
  )).rows;
}

export async function vistaPreviaDepreciacion(anioIn, mesIn, db = pool) {
  const { anio, mes } = validarAnioMes(anioIn, mesIn);
  const items = await armarCorrida(db, anio, mes);
  const ya = (await db.query(`SELECT id FROM sst.depreciaciones_mes WHERE anio = $1 AND mes = $2`, [anio, mes])).rows[0];
  return {
    anio, mes, fecha: ultimoDia(anio, mes), ya_depreciado: !!ya,
    activos: items.map((i) => ({
      activo_id: i.activo.id, codigo: i.activo.codigo, descripcion: i.activo.descripcion,
      cuotas: i.cuotas.length, desde_cuota: i.cuotas[0].cuota, hasta_cuota: i.cuotas.at(-1).cuota, valor: deCentavos(i.total),
    })),
    total: deCentavos(items.reduce((s, i) => s + i.total, 0)),
  };
}

/** Contabiliza la depreciación del mes: un DP al último día, D gasto / C depreciación acumulada por activo. */
export async function depreciarMes(anioIn, mesIn, usuarioId = null, { client = null } = {}) {
  const { anio, mes } = validarAnioMes(anioIn, mesIn);
  return conTransaccion(client, async (db) => {
    // Un cerrojo: dos personas depreciando a la vez no generan dos DP.
    await db.query(`SELECT pg_advisory_xact_lock(9473, 0)`);
    if (ultimoDia(anio, mes) > ultimoDia(...hoyCO().slice(0, 7).split('-').map(Number))) {
      throw badRequest('No se deprecia un mes que aún no empieza.');
    }
    const ult = await ultimaCorrida(db);
    if (ult && indiceMes(ult.anio, ult.mes) >= indiceMes(anio, mes)) {
      throw conflict(`Ya está depreciado ${ult.mes}/${ult.anio}: los meses se deprecian en orden, el siguiente es posterior a ese.`);
    }
    const items = await armarCorrida(db, anio, mes);
    if (!items.length) throw badRequest('No hay nada que depreciar en ese mes.');

    const lineas = [];
    for (const i of items) {
      const nota = i.cuotas.length > 1 ? ` (cuotas ${i.cuotas[0].cuota} a ${i.cuotas.at(-1).cuota})` : ` (cuota ${i.cuotas[0].cuota})`;
      const descripcion = `Depreciación ${i.activo.codigo} · ${i.activo.descripcion}${nota}`.slice(0, 500);
      lineas.push({ cuenta_id: i.activo.cuenta_gasto_id, centro_costo_id: i.activo.centro_costo_id, debito: deCentavos(i.total), descripcion });
      lineas.push({ cuenta_id: i.activo.cuenta_depreciacion_id, credito: deCentavos(i.total), descripcion });
    }
    const total = items.reduce((s, i) => s + i.total, 0);
    const corrida = (await db.query(
      `INSERT INTO sst.depreciaciones_mes (anio, mes, total, creado_por) VALUES ($1, $2, $3, $4) RETURNING id`,
      [anio, mes, deCentavos(total), usuarioId],
    )).rows[0];
    const dp = await crearComprobante({
      tipo: 'DP', fecha: ultimoDia(anio, mes), descripcion: `Depreciación de activos fijos ${String(mes).padStart(2, '0')}/${anio}`,
      origen_tipo: ORIGEN, origen_id: corrida.id, lineas, contabilizar: true,
    }, usuarioId, { client: db });
    await db.query(`UPDATE sst.depreciaciones_mes SET comprobante_id = $2 WHERE id = $1`, [corrida.id, dp.id]);
    for (const i of items) {
      for (const c of i.cuotas) {
        await db.query(
          `INSERT INTO sst.depreciaciones_activo (corrida_id, activo_id, anio, mes, cuota, valor) VALUES ($1, $2, $3, $4, $5, $6)`,
          [corrida.id, i.activo.id, c.anio, c.mes, c.cuota, deCentavos(c.valor)],
        );
      }
    }
    return { corrida_id: corrida.id, comprobante_id: dp.id, comprobante: dp.numero_completo, activos: items.length, total: deCentavos(total) };
  });
}

/** Solo la última corrida se revierte: anula su DP y borra sus cuotas (el mes se puede volver a correr). */
export async function revertirDepreciacion(anioIn, mesIn, motivo, usuarioId = null, { client = null } = {}) {
  const { anio, mes } = validarAnioMes(anioIn, mesIn);
  return conTransaccion(client, async (db) => {
    await db.query(`SELECT pg_advisory_xact_lock(9473, 0)`);
    const ult = await ultimaCorrida(db);
    if (!ult || ult.anio !== anio || ult.mes !== mes) {
      throw conflict('Solo se revierte la última depreciación registrada (los meses se deshacen del más reciente hacia atrás).');
    }
    if (ult.comprobante_id) await anularComprobante(ult.comprobante_id, motivo, usuarioId, { client: db, permitirOrigen: true });
    await db.query(`DELETE FROM sst.depreciaciones_mes WHERE id = $1`, [ult.id]);
    return { anio, mes, revertido: true };
  });
}
