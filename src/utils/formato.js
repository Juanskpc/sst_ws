/**
 * Cómo se escriben fechas, horas y cantidades de horas de cara al usuario final
 * (correos, invitaciones de calendario y formatos PDF).
 *
 * Vive aquí y no en cada módulo porque los tres canales hablan de la MISMA
 * visita: si el correo dice "02:00 PM" y el PDF adjunto "14:00", el profesional
 * tiene que traducir mentalmente para comprobar que coinciden.
 *
 * La zona horaria va fija en Colombia a propósito: `toLocaleString` usa la del
 * proceso, así que un despliegue en un VPS en UTC le imprimiría al profesional
 * una hora de visita corrida cinco horas.
 */

const ZONA = 'America/Bogota';

const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/**
 * Partes de un instante ya trasladadas a la hora de Colombia.
 *
 * Se sacan con `formatToParts` y no formateando a texto para leerlas después:
 * el separador y el "a. m./p. m." de cada locale cambian entre versiones de
 * ICU, y aquí hace falta un resultado estable.
 */
function partesCO(valor) {
  // `new Date(null)` es el epoch, no una fecha inválida: sin este corte, una OS
  // sin fecha programada se imprimiría como "mié 31 dic 1969".
  if (valor === null || valor === undefined || valor === '') return null;
  const fecha = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(fecha.getTime())) return null;
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONA,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(fecha);
  const v = (tipo) => partes.find((p) => p.type === tipo)?.value ?? '';
  // 'hour' en hour12:false devuelve 24 a medianoche en algunas versiones.
  const hora = Number(v('hour')) % 24;
  return {
    anio: v('year'),
    mes: Number(v('month')),
    dia: Number(v('day')),
    hora,
    minuto: Number(v('minute')),
  };
}

/**
 * 'HH:MM' (hora de pared, como la guarda una franja) → '02:00 PM'.
 *
 * Formato de 12 horas con AM/PM en mayúsculas, que es como lo lee el
 * profesional en campo.
 */
/**
 * Pesos colombianos, sin decimales: `$ 21.020`.
 *
 * Vive aquí y no en el módulo de facturación porque lo usan también el correo de
 * asignación (los viáticos de la orden) y los formatos: una cifra de dinero se
 * escribe igual en todo el producto o el profesional cree que son dos cosas
 * distintas.
 */
export const enPesosCO = (v) =>
  new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 })
    .format(Number(v) || 0);

export function horaAmPm(hhmm) {
  // Se exige el formato completo: `Number('')` es 0, así que sin esta guarda un
  // valor vacío se imprimiría como una medianoche perfectamente creíble.
  const m24 = /^(\d{1,2}):(\d{2})/.exec(String(hhmm ?? '').trim());
  if (!m24) return '—';
  const hora = Number(m24[1]);
  const minuto = Number(m24[2]);
  if (hora > 23 || minuto > 59) return '—';
  const periodo = hora >= 12 ? 'PM' : 'AM';
  const doce = hora % 12 === 0 ? 12 : hora % 12;
  return `${String(doce).padStart(2, '0')}:${String(minuto).padStart(2, '0')} ${periodo}`;
}

/** Instante → '14/08/2026' (hora de Colombia). */
export function fechaCorta(valor) {
  const p = partesCO(valor);
  if (!p) return 'por definir';
  return `${String(p.dia).padStart(2, '0')}/${String(p.mes).padStart(2, '0')}/${p.anio}`;
}

/** Instante → 'vie 14 ago 2026 · 02:00 PM' (hora de Colombia). */
export function fechaHoraCO(valor) {
  const p = partesCO(valor);
  if (!p) return 'por definir';
  return `${rotuloDia(p)} · ${horaAmPm(`${String(p.hora).padStart(2, '0')}:${String(p.minuto).padStart(2, '0')}`)}`;
}

/** 'YYYY-MM-DD' (fecha suelta, sin hora) → 'vie 14 ago 2026'. */
export function fechaDiaCO(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  if (!m) return String(iso ?? '—');
  // Mediodía para que ningún desfase de zona la cambie de día.
  const d = new Date(`${iso}T12:00:00-05:00`);
  return `${DIAS[d.getDay()]} ${Number(m[3])} ${MESES[Number(m[2]) - 1]} ${m[1]}`;
}

function rotuloDia(p) {
  const d = new Date(`${p.anio}-${String(p.mes).padStart(2, '0')}-${String(p.dia).padStart(2, '0')}T12:00:00-05:00`);
  return `${DIAS[d.getDay()]} ${p.dia} ${MESES[p.mes - 1]} ${p.anio}`;
}

/**
 * Cantidad de horas como la escribiría una persona: `4`, `4 y 30 min`, `45 min`.
 *
 * `horas_asignadas` es NUMERIC en la BD, así que el driver lo entrega como
 * '4.00' y ese decimal acababa impreso tal cual en el correo y en los formatos.
 */
export function horasTexto(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const total = Math.round(n * 60);
  const horas = Math.floor(total / 60);
  const minutos = total % 60;
  if (!minutos) return `${horas}`;
  if (!horas) return `${minutos} min`;
  return `${horas} y ${minutos} min`;
}

/**
 * La misma cantidad pero con la unidad puesta: `4 h`, `4 h 30 min`, `45 min`.
 *
 * `horasTexto` da "4" a secas porque siempre va bajo una etiqueta que ya dice
 * "Horas". Cuando la cifra viaja suelta dentro de una línea —el listado de
 * órdenes de la pre-cuenta— ese "4" no se entiende, y "4 y 30 min h" tampoco.
 */
export function horasConUnidad(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const total = Math.round(n * 60);
  const horas = Math.floor(total / 60);
  const minutos = total % 60;
  if (!horas) return `${minutos} min`;
  return minutos ? `${horas} h ${minutos} min` : `${horas} h`;
}
