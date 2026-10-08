import crypto from 'node:crypto';
import { pool, withTransaction } from '../../config/db.js';
import { badRequest, conflict, notFound } from '../../utils/httpError.js';
import { hoyCO } from '../../utils/formato.js';
import { proveedorFE } from '../facturacion/index.js';
import { liquidar, OTRAS_DEDUCCIONES, OTROS_DEVENGADOS, PARAMETROS, TIPOS_HORA, TIPOS_LICENCIA } from './calculo.js';
import { faltantesParaNomina, obtenerEmpleado } from './empleados.service.js';

/**
 * A5-01 · Liquidaciones de nómina: una por empleado y mes.
 *
 * BORRADOR → (emitir) → ENVIANDO → VALIDADO | RECHAZADO;  VALIDADO → (anular) → ANULADO.
 *
 * Lo que la DIAN NO valida y por eso se valida aquí (visto en el ambiente de pruebas el
 * 8-oct-2026: aceptó un periodo futuro y un pago en otro mes): que el periodo no sea
 * futuro, que el empleado ya hubiera ingresado y que no haya dos nóminas del mismo mes.
 */

/** El estado como lo lee una persona, en femenino («la nómina está validada»). */
const ESTADO_LEGIBLE = { BORRADOR: 'en borrador', ENVIANDO: 'enviándose a la DIAN', VALIDADO: 'validada', RECHAZADO: 'rechazada: corríjala antes de volver a emitir', ANULADO: 'anulada' };

const generarReferencia = (prefijo) => `ORB-${prefijo}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));

const LIQ_SELECT = `
  l.id, l.empleado_id, l.anio, l.mes, l.estado, l.salario, l.salario_integral, l.novedades, l.liquidacion,
  l.dias_trabajados, l.total_devengado, l.total_deducido, l.neto,
  to_char(l.fecha_pago, 'YYYY-MM-DD') AS fecha_pago, l.observaciones,
  l.reference_code, l.numero, l.cune, l.qr_url, l.errores, l.validada_en,
  l.nota_numero, l.nota_cune, l.anulada_en, l.creado_en, l.actualizado_en,
  COALESCE(t.razon_social, btrim(concat_ws(' ', t.nombres, t.apellidos))) AS empleado_nombre,
  t.numero_documento AS empleado_documento, e.cargo AS empleado_cargo`;
const LIQ_FROM = `
  FROM sst.nomina_liquidaciones l
  JOIN sst.empleados e ON e.id = l.empleado_id
  JOIN sst.terceros t ON t.id = e.tercero_id`;

// ─── Novedades: lo que escribe quien liquida ────────────────────────────────

const entero = (v, campo, { min = 1, max }) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${campo} debe ser un número entero entre ${min} y ${max}.`);
  return n;
};
const dinero = (v, campo) => {
  if (v == null || v === '') return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw badRequest(`${campo} debe ser un valor positivo.`);
  return Math.round(n * 100) / 100;
};
const fecha = (v) => {
  const s = String(v ?? '').trim();
  if (!s) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw badRequest(`La fecha «${s}» no es válida.`);
  return s;
};
/** El proveedor solo acepta `AAAA-MM-DD HH:MM:SS` (con espacio): el campo de la pantalla manda una T. */
const fechaHora = (v) => {
  const s = String(v ?? '').trim();
  if (!s) return undefined;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m || Number.isNaN(Date.parse(`${m[1]}T${m[2]}:00Z`))) throw badRequest(`La fecha y hora «${s}» no es válida.`);
  return `${m[1]} ${m[2]}:${m[3] ?? '00'}`;
};
const lista = (v) => (Array.isArray(v) ? v : []);

/** Limpia y valida las novedades; lo que no trae nada se omite. */
export function normalizarNovedades(raw = {}) {
  const n = {};
  // La cantidad de horas va entera: así la define el documento electrónico.
  const horas = lista(raw.horas).filter((h) => h && Number(h.cantidad) > 0).map((h, i) => {
    if (!TIPOS_HORA[h.tipo]) throw badRequest(`Horas extra, fila ${i + 1}: elija el tipo.`);
    const fila = { tipo: h.tipo, cantidad: entero(h.cantidad, `Horas extra, fila ${i + 1}: la cantidad`, { max: 200 }), inicio: fechaHora(h.inicio), fin: fechaHora(h.fin) };
    if (fila.inicio && fila.fin && fila.fin <= fila.inicio) throw badRequest(`Horas extra, fila ${i + 1}: la hora final debe ser posterior a la inicial.`);
    return fila;
  });
  if (horas.length) n.horas = horas;

  const conDias = (filas, nombre, extra = () => ({})) => lista(filas).filter((f) => f && Number(f.dias) > 0).map((f, i) => {
    const fila = { dias: entero(f.dias, `${nombre}, fila ${i + 1}: los días`, { max: 30 }), inicio: fecha(f.inicio), fin: fecha(f.fin), ...extra(f, i) };
    if (fila.inicio && fila.fin && fila.fin < fila.inicio) throw badRequest(`${nombre}, fila ${i + 1}: la fecha final es anterior a la inicial.`);
    return fila;
  });
  const vacaciones = conDias(raw.vacaciones, 'Vacaciones', (f) => ({ compensadas: f.compensadas === true }));
  if (vacaciones.length) n.vacaciones = vacaciones;
  const licencias = conDias(raw.licencias, 'Licencias', (f, i) => {
    if (!TIPOS_LICENCIA[f.tipo]) throw badRequest(`Licencias, fila ${i + 1}: elija el tipo.`);
    return { tipo: f.tipo };
  });
  if (licencias.length) n.licencias = licencias;
  const incapacidades = conDias(raw.incapacidades, 'Incapacidades');
  if (incapacidades.length) n.incapacidades = incapacidades;

  const comisiones = dinero(raw.comisiones, 'Las comisiones');
  if (comisiones) n.comisiones = comisiones;
  const bonificacion = dinero(raw.bonificacion, 'La bonificación');
  if (bonificacion) n.bonificacion = bonificacion;
  if (Number(raw.prima?.dias) > 0) n.prima = { dias: entero(raw.prima.dias, 'Los días de la prima', { max: 180 }) };
  if (Number(raw.cesantias?.dias) > 0) n.cesantias = { dias: entero(raw.cesantias.dias, 'Los días de las cesantías', { max: 360 }) };

  // Otros pagos y otras deducciones: tipo, valor y, donde el documento la pide, una descripción.
  const conValor = (filas, tabla, nombre) => lista(filas).filter((f) => f && Number(f.valor) > 0).map((f, i) => {
    const t = tabla[f.tipo];
    if (!t) throw badRequest(`${nombre}, fila ${i + 1}: elija el tipo.`);
    const descripcion = String(f.descripcion ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || undefined;
    if (t.conDescripcion && !descripcion) throw badRequest(`${nombre}, fila ${i + 1}: escriba la descripción (${t.nombre.toLowerCase()}).`);
    return { tipo: f.tipo, valor: dinero(f.valor, `${nombre}, fila ${i + 1}: el valor`), descripcion };
  });
  const otrosDevengados = conValor(raw.otrosDevengados, OTROS_DEVENGADOS, 'Otros pagos');
  if (otrosDevengados.length) n.otrosDevengados = otrosDevengados;
  const otrasDeducciones = conValor(raw.otrasDeducciones, OTRAS_DEDUCCIONES, 'Otras deducciones');
  if (otrasDeducciones.length) n.otrasDeducciones = otrasDeducciones;
  return n;
}

// ─── Cálculo ────────────────────────────────────────────────────────────────

const ultimoDia = (anio, mes) => new Date(Date.UTC(anio, mes, 0)).toISOString().slice(0, 10);

function validarPeriodo(anio, mes, empleado) {
  const a = Number(anio);
  const m = Number(mes);
  if (!Number.isInteger(a) || !Number.isInteger(m) || m < 1 || m > 12) throw badRequest('Indique el año y el mes de la nómina.');
  if (!PARAMETROS[a]) throw badRequest(`No están cargados el salario mínimo y el auxilio de transporte de ${a}.`);
  const [hoyAnio, hoyMes] = hoyCO().split('-').map(Number);
  if (a > hoyAnio || (a === hoyAnio && m > hoyMes)) throw badRequest('No se puede liquidar un mes que todavía no ha empezado.');
  if (empleado.fecha_ingreso > ultimoDia(a, m)) throw badRequest(`${empleado.nombre} ingresó el ${empleado.fecha_ingreso}: no trabajó en ese mes.`);
  if (empleado.fecha_retiro && empleado.fecha_retiro < `${a}-${String(m).padStart(2, '0')}-01`) throw badRequest(`${empleado.nombre} se retiró el ${empleado.fecha_retiro}: no trabajó en ese mes.`);
  return { anio: a, mes: m };
}

function calcular(empleado, periodo, novedades) {
  try {
    return liquidar({ salario: Number(empleado.salario), periodo, salarioIntegral: empleado.salario_integral, novedades });
  } catch (err) {
    // Los errores de calculo.js son de datos (más de 30 días de novedades, tipo desconocido…), no del servidor.
    throw badRequest(err.message);
  }
}

/** Vista previa: liquida sin guardar nada. */
export async function previaLiquidacion({ empleado_id: empleadoId, anio, mes, novedades }) {
  const empleado = await obtenerEmpleado(empleadoId);
  const periodo = validarPeriodo(anio, mes, empleado);
  const limpias = normalizarNovedades(novedades);
  return { empleado, periodo, novedades: limpias, liquidacion: calcular(empleado, periodo, limpias) };
}

// ─── Lectura ────────────────────────────────────────────────────────────────

export async function listarLiquidaciones({ anio, mes } = {}, client = pool) {
  const params = [];
  const filtros = [];
  if (anio) { params.push(Number(anio)); filtros.push(`l.anio = $${params.length}`); }
  if (mes) { params.push(Number(mes)); filtros.push(`l.mes = $${params.length}`); }
  const r = await client.query(
    `SELECT ${LIQ_SELECT} ${LIQ_FROM} ${filtros.length ? `WHERE ${filtros.join(' AND ')}` : ''}
      ORDER BY l.anio DESC, l.mes DESC, empleado_nombre, l.creado_en DESC`, params,
  );
  return r.rows;
}

export async function obtenerLiquidacion(id, client = pool) {
  const r = await client.query(`SELECT ${LIQ_SELECT} ${LIQ_FROM} WHERE l.id = $1`, [id]);
  if (!r.rows[0]) throw notFound('Esa liquidación no existe.');
  return r.rows[0];
}

// ─── Borrador ───────────────────────────────────────────────────────────────

function datosDeGuardado(body, empleado) {
  const periodo = validarPeriodo(body.anio, body.mes, empleado);
  const novedades = normalizarNovedades(body.novedades);
  const liquidacion = calcular(empleado, periodo, novedades);
  // El proveedor exige al menos 1 día laborado y un sueldo mayor que cero (visto el 8-oct-2026):
  // un mes entero de vacaciones o licencia todavía no tiene forma de reportarse.
  if (liquidacion.diasTrabajados < 1) {
    throw badRequest('La nómina electrónica exige al menos un día laborado en el mes. Un mes completo de vacaciones, licencia o incapacidad todavía no se puede emitir desde ORBITA.');
  }
  const fechaPago = fecha(body.fecha_pago) ?? (() => { throw badRequest('Indique la fecha de pago.'); })();
  return { periodo, novedades, liquidacion, fechaPago, observaciones: String(body.observaciones ?? '').trim().slice(0, 500) || null };
}

export async function crearLiquidacion(body, usuarioId) {
  const empleado = await obtenerEmpleado(body.empleado_id);
  if (!empleado.activo) throw badRequest('Ese empleado está inactivo.');
  const d = datosDeGuardado(body, empleado);
  const viva = await pool.query(
    `SELECT estado FROM sst.nomina_liquidaciones WHERE empleado_id = $1 AND anio = $2 AND mes = $3 AND estado <> 'ANULADO'`,
    [empleado.id, d.periodo.anio, d.periodo.mes],
  );
  if (viva.rowCount) throw conflict(`${empleado.nombre} ya tiene una nómina de ese mes (${ESTADO_LEGIBLE[viva.rows[0].estado].split(':')[0]}). Ábrala desde la lista.`);
  const r = await pool.query(
    `INSERT INTO sst.nomina_liquidaciones
       (empleado_id, anio, mes, salario, salario_integral, novedades, liquidacion, dias_trabajados,
        total_devengado, total_deducido, neto, fecha_pago, observaciones, creado_por, actualizado_por)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) RETURNING id`,
    [empleado.id, d.periodo.anio, d.periodo.mes, empleado.salario, empleado.salario_integral, JSON.stringify(d.novedades), JSON.stringify(d.liquidacion),
      d.liquidacion.diasTrabajados, d.liquidacion.totales.devengado, d.liquidacion.totales.deducido, d.liquidacion.totales.neto,
      d.fechaPago, d.observaciones, usuarioId],
  );
  return obtenerLiquidacion(r.rows[0].id);
}

/** Vuelve a liquidar con otras novedades. Solo un borrador o una rechazada (que vuelve a borrador). */
export async function actualizarLiquidacion(id, body, usuarioId) {
  const actual = await obtenerLiquidacion(id);
  if (!['BORRADOR', 'RECHAZADO'].includes(actual.estado)) throw conflict('Solo se puede cambiar una nómina en borrador o rechazada.');
  const empleado = await obtenerEmpleado(actual.empleado_id);
  // El periodo no se cambia: para otro mes se crea otra liquidación.
  const d = datosDeGuardado({ ...body, anio: actual.anio, mes: actual.mes }, empleado);
  await pool.query(
    `UPDATE sst.nomina_liquidaciones
        SET estado = 'BORRADOR', salario = $2, salario_integral = $3, novedades = $4, liquidacion = $5, dias_trabajados = $6,
            total_devengado = $7, total_deducido = $8, neto = $9, fecha_pago = $10, observaciones = $11,
            errores = NULL, actualizado_por = $12
      WHERE id = $1`,
    [id, empleado.salario, empleado.salario_integral, JSON.stringify(d.novedades), JSON.stringify(d.liquidacion), d.liquidacion.diasTrabajados,
      d.liquidacion.totales.devengado, d.liquidacion.totales.deducido, d.liquidacion.totales.neto, d.fechaPago, d.observaciones, usuarioId],
  );
  return obtenerLiquidacion(id);
}

export async function eliminarLiquidacion(id) {
  const r = await pool.query(`DELETE FROM sst.nomina_liquidaciones WHERE id = $1 AND estado IN ('BORRADOR', 'RECHAZADO') RETURNING id`, [id]);
  if (!r.rows[0]) throw conflict('Solo se puede eliminar una nómina en borrador o rechazada (o ya no existe).');
  return { id };
}

// ─── Emisión ────────────────────────────────────────────────────────────────

/** «MARIA FERNANDA» → primer nombre y los demás; «PAZ CORAL» → primer y segundo apellido. */
function partirNombre(nombres, apellidos) {
  const [primerNombre, ...otros] = String(nombres ?? '').trim().split(/\s+/);
  const [primerApellido, ...resto] = String(apellidos ?? '').trim().split(/\s+/);
  return { primerNombre, otrosNombres: otros.join(' ') || undefined, primerApellido, segundoApellido: resto.join(' ') || undefined };
}

/** ¿El proveedor dice que es la DIAN quien rechazó el documento (y no un campo mal formado)? */
const esRechazoDian = (err) => /errores de validaci/i.test(String(err?.message ?? ''));
/** ¿Vale la pena repetir el MISMO envío? (500 del proveedor, corte de red, o quedó pendiente). */
const esReintentable = (err) => err?.status === 500 || err?.status === 0 || (err?.status === 409 && /pendiente/i.test(String(err?.message ?? '')));

/**
 * Emite la nómina ante la DIAN.
 *
 * Lo aprendido en el ambiente de pruebas el 8-oct-2026, y confirmado por el proveedor:
 *  · Es común que el proveedor cree la nómina y responda 500 antes de validarla. Queda
 *    «pendiente por enviar a la DIAN» y BLOQUEA todas las demás. Se destraba repitiendo el
 *    envío con la MISMA referencia (no crea otra): por eso se reintenta aquí mismo y, si
 *    aun así no responde, la nómina queda ENVIANDO y «emitir» la retoma con esa referencia.
 *  · Si la DIAN la rechaza, también queda creada y bloqueando: se elimina en el proveedor
 *    por su referencia y aquí queda RECHAZADO con el motivo. La siguiente emisión usa otra.
 */
export async function emitirLiquidacion(id, usuarioId) {
  // Se reserva la fila: dos clics no deben salir como dos envíos con dos referencias.
  const liq = await withTransaction(async (client) => {
    const l = (await client.query(`SELECT id, estado, reference_code FROM sst.nomina_liquidaciones WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!l) throw notFound('Esa liquidación no existe.');
    if (!['BORRADOR', 'ENVIANDO'].includes(l.estado)) throw conflict(`Esta nómina está ${ESTADO_LEGIBLE[l.estado]}; no se puede emitir.`);
    const referencia = l.reference_code ?? generarReferencia('NOMINA');
    await client.query(`UPDATE sst.nomina_liquidaciones SET estado = 'ENVIANDO', reference_code = $2, errores = NULL, actualizado_por = $3 WHERE id = $1`, [id, referencia, usuarioId]);
    return obtenerLiquidacion(id, client);
  });

  const volverABorrador = (mensaje) => pool.query(`UPDATE sst.nomina_liquidaciones SET estado = 'BORRADOR', reference_code = NULL WHERE id = $1`, [id]).then(() => { throw badRequest(mensaje); });
  const empleado = await obtenerEmpleado(liq.empleado_id);
  const faltan = faltantesParaNomina(empleado);
  if (faltan.length) return volverABorrador(`A ${empleado.nombre} le falta ${faltan.join(', ')} para emitirle la nómina. Complete su ficha en Terceros.`);

  const datos = {
    referenceCode: liq.reference_code,
    observacion: liq.observaciones ?? undefined,
    periodo: { anio: liq.anio, mes: liq.mes },
    pago: { metodoCodigo: empleado.metodo_pago, banco: empleado.banco, tipoCuenta: empleado.tipo_cuenta, numeroCuenta: empleado.numero_cuenta, fecha: liq.fecha_pago },
    trabajador: {
      tipoDocumentoCodigo: empleado.tipo_documento_codigo, numeroDocumento: empleado.numero_documento,
      ...partirNombre(empleado.nombres, empleado.apellidos),
      direccion: empleado.direccion, municipioDane: empleado.municipio_codigo,
      salarioIntegral: liq.salario_integral, altoRiesgo: empleado.alto_riesgo,
      tipoTrabajadorCodigo: empleado.tipo_trabajador, subtipoCodigo: empleado.subtipo_trabajador, tipoContratoCodigo: empleado.tipo_contrato,
      salario: Number(liq.salario), fechaIngreso: empleado.fecha_ingreso,
      // La fecha de retiro solo se informa en la nómina del mes en que ocurre.
      fechaRetiro: empleado.fecha_retiro?.startsWith(`${liq.anio}-${String(liq.mes).padStart(2, '0')}`) ? empleado.fecha_retiro : undefined,
    },
    liquidacion: liq.liquidacion,
  };

  const fe = proveedorFE();
  let resultado = null;
  let fallo = null;
  for (let intento = 1; intento <= 3 && !resultado; intento++) {
    try {
      const r = await fe.emitirNominaElectronica(datos);
      if (r.validado || intento === 3) resultado = r;
      else await espera(3000);
    } catch (err) {
      fallo = err;
      if (!esReintentable(err) || intento === 3) break;
      await espera(3000);
    }
  }

  if (resultado?.validado) {
    await pool.query(
      `UPDATE sst.nomina_liquidaciones
          SET estado = 'VALIDADO', numero = $2, cune = $3, qr_url = $4, respuesta_proveedor = $5, validada_en = now(), errores = NULL, actualizado_por = $6
        WHERE id = $1`,
      [id, resultado.numeroDocumento, resultado.cufe, resultado.urlPublica, JSON.stringify(resultado.respuestaCruda ?? {}), usuarioId],
    );
    return obtenerLiquidacion(id);
  }

  // Rechazo de la DIAN (llega como error, o como documento creado sin validar con sus motivos).
  const motivos = resultado ? [...resultado.eventos.rechazos, ...resultado.eventos.avisos].map(([, v]) => String(v)) : null;
  if ((fallo && esRechazoDian(fallo)) || motivos?.length) {
    // Se quita del proveedor para que no bloquee las nóminas de los demás empleados.
    await fe.eliminarNominaNoValidada(liq.reference_code).catch(() => {});
    const errores = motivos?.length ? motivos : (Array.isArray(fallo.detalle) ? fallo.detalle.map(String) : [fallo.message]);
    await pool.query(`UPDATE sst.nomina_liquidaciones SET estado = 'RECHAZADO', errores = $2, reference_code = NULL, actualizado_por = $3 WHERE id = $1`, [id, JSON.stringify(errores), usuarioId]);
    return obtenerLiquidacion(id);
  }

  // Un campo mal formado (422) o una negativa del proveedor (403, 404…): no se envió nada. Vuelve a borrador.
  if (fallo && !esReintentable(fallo)) {
    // En un error de validación el detalle trae una lista de mensajes por campo; en los demás
    // (403, 404…) solo repite el mensaje, y no se muestra dos veces.
    const porCampo = fallo.detalle && typeof fallo.detalle === 'object'
      ? Object.values(fallo.detalle).filter(Array.isArray).flat().map(String).slice(0, 5).join(' ') : '';
    return volverABorrador(`El proveedor tecnológico no aceptó la nómina: ${fallo.message}${porCampo ? `. ${porCampo}` : '.'}`);
  }

  // Sin respuesta definitiva: se queda ENVIANDO con su referencia. «Emitir» de nuevo la retoma.
  return { ...(await obtenerLiquidacion(id)), pendiente: true };
}

/** Anula una nómina validada con una nota de ajuste de eliminación. */
export async function anularLiquidacion(id, usuarioId) {
  const liq = await withTransaction(async (client) => {
    const l = (await client.query(`SELECT id, estado, numero, nota_reference_code FROM sst.nomina_liquidaciones WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!l) throw notFound('Esa liquidación no existe.');
    if (l.estado !== 'VALIDADO') throw conflict('Solo se anula una nómina ya validada por la DIAN.');
    const referencia = l.nota_reference_code ?? generarReferencia('NOMAJUSTE');
    await client.query(`UPDATE sst.nomina_liquidaciones SET nota_reference_code = $2, actualizado_por = $3 WHERE id = $1`, [id, referencia, usuarioId]);
    return { ...l, nota_reference_code: referencia };
  });

  const fe = proveedorFE();
  let nota = null;
  let fallo = null;
  for (let intento = 1; intento <= 3 && !nota?.validado; intento++) {
    try { nota = await fe.emitirNotaAjusteNomina({ referenceCode: liq.nota_reference_code, numeroNomina: liq.numero }); } catch (err) { fallo = err; if (!esReintentable(err)) break; }
    if (!nota?.validado && intento < 3) await espera(3000);
  }
  if (!nota?.validado) {
    throw badRequest(`La nota de ajuste no quedó validada: ${fallo?.message ?? 'la DIAN todavía no responde'}. Inténtelo de nuevo en unos minutos; se usa la misma referencia.`);
  }
  await pool.query(
    `UPDATE sst.nomina_liquidaciones SET estado = 'ANULADO', nota_numero = $2, nota_cune = $3, anulada_en = now(), actualizado_por = $4 WHERE id = $1`,
    [id, nota.numeroDocumento, nota.cufe, usuarioId],
  );
  return obtenerLiquidacion(id);
}
