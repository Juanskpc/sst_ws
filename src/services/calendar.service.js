/**
 * ASG-05 · Evento de calendario para la visita programada.
 *
 * El requisito pide "agregar un evento al calendario del administrador y del
 * profesional (GMAIL)". Se resuelve con una invitación iCalendar adjunta al
 * correo de asignación y no con la API de Google Calendar: esa exige OAuth por
 * usuario (o una cuenta de servicio con delegación en todo el dominio) y
 * credenciales que el despliegue no tiene, y solo funcionaría si tanto el
 * administrador como el profesional usaran cuentas del mismo dominio Google.
 * Un .ics con METHOD:REQUEST lo entiende Gmail —lo muestra como invitación, con
 * su botón de añadir al calendario— y también Outlook y el calendario del
 * celular, que es donde el asesor lo va a mirar en campo.
 *
 * El UID es estable por orden a propósito: al reprogramar (ASG-07) se manda
 * otra invitación con el mismo UID y un SEQUENCE mayor, así el calendario
 * MUEVE la visita existente en vez de dejar dos eventos y que el profesional se
 * presente el día que no es.
 */

import { horasTexto } from '../utils/formato.js';
import { referenciaOrden } from '../utils/referencia-orden.js';

/** Escapa el texto según RFC 5545: la coma, el punto y coma y la barra son separadores. */
function escapar(valor) {
  return String(valor ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Dobla las líneas a 75 octetos, como exige el RFC.
 *
 * Se cuenta en BYTES y no en caracteres porque los nombres de empresa llevan
 * tildes y eñes: cortar por caracteres se pasa del límite y hay clientes que
 * descartan el evento entero sin avisar.
 */
function doblar(linea) {
  const bytes = Buffer.from(linea, 'utf8');
  if (bytes.length <= 75) return linea;
  const trozos = [];
  let inicio = 0;
  let limite = 75;
  while (inicio < bytes.length) {
    let fin = Math.min(inicio + limite, bytes.length);
    // No partir un carácter multibyte por la mitad: retrocede hasta el inicio
    // del carácter (los bytes de continuación UTF-8 son 10xxxxxx).
    while (fin < bytes.length && (bytes[fin] & 0xc0) === 0x80) fin--;
    trozos.push(bytes.subarray(inicio, fin).toString('utf8'));
    inicio = fin;
    limite = 74; // las líneas continuadas empiezan por un espacio
  }
  return trozos.join('\r\n ');
}

/** Fecha en formato UTC del RFC 5545 (20260701T140000Z). */
function aFechaIcs(valor) {
  return new Date(valor).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** 'YYYY-MM-DD' + 'HH:MM' de Colombia → Date. Ver `instanteCO` en orders.routes. */
function fechaHoraCO(fecha, hora) {
  return new Date(`${fecha}T${hora}:00-05:00`);
}

/**
 * Construye las invitaciones de la visita: **un archivo .ics por franja**.
 *
 * Devuelve un arreglo vacío si la OS no tiene ni franjas ni fecha programada: se
 * puede asignar un profesional sin fecha, y una invitación sin cuándo no le
 * sirve a nadie.
 *
 * ASG-02 · Una visita partida (mañana y tarde, o varios días) genera un VEVENT
 * por franja, cada uno con su propio UID (`os-<id>-<n>`) y en **su propio
 * archivo**. Ninguna de las dos cosas es opcional: un solo evento largo le
 * ocuparía al profesional también las horas del medio, que están libres, y
 * varios VEVENT dentro de un mismo archivo hacen que Gmail muestre solo el
 * primero (comprobado, ver el comentario del `return`).
 *
 * @param {object} orden        OS expandida (vw_ordenes_expandidas).
 * @param {object} profesional  Ficha del profesional asignado.
 * @param {object} organizador  Quien asigna: { nombre, correo }.
 * @param {number} secuencia    Nº de revisión; sube en cada reprogramación.
 * @param {Array}  franjas      Franjas de la visita ([] = OS a la antigua).
 * @param {number} previas      Cuántas franjas tenía antes de reprogramar.
 * @param {string} sufijoUid    Distingue las invitaciones de un asesor adicional
 *                              de las del principal (misma orden, otro horario).
 * @param {Array}  todas        26-nov-2026 · Todas las franjas del asesor, cuando
 *                              `franjas` es solo lo nuevo de un envío por partes: la
 *                              sesión se numera contra la visita entera.
 * @param {Array}  canceladas   26-nov-2026 · Franjas ya enviadas que dejaron de
 *                              existir (con su `ics_uid`): salen como CANCELADAS.
 *                              Si se pasa, reemplaza a `previas`.
 * @returns {{contenido: string, nombre: string}[]}
 */
export function construirInvitaciones({
  orden, profesional, organizador, secuencia = 0, franjas = [], previas = 0, sufijoUid = '',
  todas = null, canceladas = null,
}) {
  const visita = Array.isArray(todas) && todas.length ? todas : franjas;
  // El UID es el de la franja (`ics_uid`, fijo por sesión desde el 26-nov); el
  // posicional queda para las franjas sin él (pruebas y órdenes a la antigua).
  const tramos = Array.isArray(franjas) && franjas.length
    ? franjas.map((f, i) => {
        const pos = visita.indexOf(f);
        const n = pos >= 0 ? pos + 1 : i + 1;
        return {
          inicio: fechaHoraCO(f.fecha, f.hora_inicio),
          fin: fechaHoraCO(f.fecha, f.hora_fin),
          uid: f.ics_uid || `os-${orden.id}${sufijoUid}-${n}@jdd-iacore`,
          etiqueta: visita.length > 1 ? ` (${n}/${visita.length})` : '',
          cancelado: false,
          sesion: n,
          franja: f,
        };
      })
    : [];

  // Sin franjas se mantiene el comportamiento de siempre: un evento que dura las
  // horas de la OS. Si no vienen se asume una hora, que es mejor que un evento
  // de duración cero (hay calendarios que lo ocultan).
  // Un correo que solo cancela sesiones no lleva este evento de respaldo.
  if (!tramos.length && !canceladas?.length) {
    if (!orden?.fecha_programada) return [];
    const inicio = new Date(orden.fecha_programada);
    const horas = Number(orden.horas_asignadas) > 0 ? Number(orden.horas_asignadas) : 1;
    tramos.push({
      inicio,
      fin: new Date(inicio.getTime() + horas * 60 * 60 * 1000),
      uid: `os-${orden.id}${sufijoUid}@jdd-iacore`,
      etiqueta: '',
      cancelado: false,
      sesion: 1,
    });
  }

  // Reprogramar con MENOS franjas que antes dejaría los eventos sobrantes vivos
  // en el calendario del profesional, y se presentaría un día que ya no toca.
  // Se mandan cancelados con el mismo UID para que el cliente los tache.
  // 26-nov-2026 · Con `canceladas` se cancela CADA sesión retirada por su UID, con
  // su fecha real; `previas` (por posición) queda para quien no las conozca.
  if (Array.isArray(canceladas)) {
    for (const f of canceladas) {
      tramos.push({
        inicio: fechaHoraCO(f.fecha, f.hora_inicio),
        fin: fechaHoraCO(f.fecha, f.hora_fin),
        uid: f.ics_uid,
        etiqueta: ' (cancelada)',
        cancelado: true,
        fecha: f.fecha,
        franja: f,
      });
    }
  } else {
    for (let i = franjas.length; i < previas; i++) {
      const ref = tramos[0];
      tramos.push({
        inicio: ref.inicio,
        fin: ref.fin,
        uid: `os-${orden.id}${sufijoUid}-${i + 1}@jdd-iacore`,
        etiqueta: ' (cancelada)',
        cancelado: true,
        sesion: i + 1,
      });
    }
  }

  const lugar = [orden.direccion, orden.ciudad_ejecucion].filter(Boolean).join(', ');
  const descripcion = [
    `Orden de servicio: ${orden.codigo}`,
    // P2 (26-oct-2026) · Cronograma y secuencia (Bolívar) o número de orden
    // (demás ARL), como en el registro de asistencia AT-028.
    orden.codigo_cronograma ? `Cronograma: ${orden.codigo_cronograma} · Secuencia: ${orden.secuencia}` : null,
    !orden.codigo_cronograma && orden.numero_orden ? `N.º de orden: ${orden.numero_orden}` : null,
    (orden.arl_id ? `ARL: ${orden.arl_nombre || '—'}` : `Cliente: ${orden.pagador_nombre || '—'}`),
    `Empresa: ${orden.empresa_nombre || '—'}`,
    // La actividad a desarrollar es `tipo_actividad` (la «Descripción» del SIPAB),
    // no `descripcion`, que guarda las observaciones enteras (decisión del 20-oct).
    orden.tipo_actividad ? `Actividad a desarrollar: ${orden.tipo_actividad}` : null,
    `Horas: ${horasTexto(orden.horas_asignadas)}`,
    orden.contacto_sst_nombre ? `Contacto SST: ${orden.contacto_sst_nombre} ${orden.contacto_sst_telefono || ''}`.trim() : null,
    orden.descripcion ? `\nObservaciones: ${orden.descripcion}` : null,
  ].filter(Boolean).join('\n');

  const evento = (t) => [
    'BEGIN:VEVENT',
    `UID:${t.uid}`,
    `SEQUENCE:${secuencia}`,
    `DTSTAMP:${aFechaIcs(new Date())}`,
    `DTSTART:${aFechaIcs(t.inicio)}`,
    `DTEND:${aFechaIcs(t.fin)}`,
    `SUMMARY:${escapar(`${referenciaOrden(orden)} · ${orden.empresa_nombre || 'Visita SST'}${t.etiqueta}`)}`,
    `DESCRIPTION:${escapar(descripcion)}`,
    lugar ? `LOCATION:${escapar(lugar)}` : null,
    t.cancelado ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED',
    organizador?.correo
      ? `ORGANIZER;CN=${escapar(organizador.nombre || 'JD&D Consultores')}:mailto:${organizador.correo}`
      : null,
    // RSVP para que el profesional pueda confirmar y el administrador lo vea.
    profesional?.correo
      ? `ATTENDEE;CN=${escapar(profesional.nombre || '')};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${profesional.correo}`
      : null,
    // El administrador va como asistente además de organizador: así el evento
    // le entra también a SU calendario, que es la otra mitad del requisito.
    organizador?.correo
      ? `ATTENDEE;CN=${escapar(organizador.nombre || 'Administración')};ROLE=CHAIR;PARTSTAT=ACCEPTED:mailto:${organizador.correo}`
      : null,
    // Recordatorio la víspera: el riesgo del FRS es que el profesional no se
    // presente o no suba los soportes a tiempo. En las canceladas sobra.
    ...(t.cancelado
      ? []
      : [
          'BEGIN:VALARM',
          'TRIGGER:-PT24H',
          'ACTION:DISPLAY',
          `DESCRIPTION:${escapar(`Visita mañana: ${orden.empresa_nombre || orden.codigo}`)}`,
          'END:VALARM',
        ]),
    'END:VEVENT',
  ];

  /** Envuelve uno o más VEVENT en un VCALENDAR completo. */
  const calendario = (eventos) => {
    const lineas = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//JD&D Consultores//IA-Core//ES',
      'CALSCALE:GREGORIAN',
      // REQUEST y no PUBLISH: es una convocatoria a una persona concreta, y es lo
      // que hace que Gmail la pinte como invitación en vez de como un adjunto.
      'METHOD:REQUEST',
      ...eventos,
      'END:VCALENDAR',
    ].filter(Boolean);
    // CRLF obligatorio: con \n suelto hay clientes que rechazan el archivo.
    return lineas.map(doblar).join('\r\n') + '\r\n';
  };

  // Un archivo POR FRANJA, no uno con todos los eventos dentro.
  //
  // Se comprobó en Gmail con una visita de 2 franjas: del .ics con dos VEVENT y
  // METHOD:REQUEST solo pintaba la tarjeta del primero ("… (1/2)"), así que la
  // segunda mitad de la visita no llegaba nunca al calendario del profesional.
  // Un adjunto por franja lo obliga a mostrar una tarjeta por cada una. Los UID
  // siguen siendo los mismos (`os-<id>-<n>`), de modo que reprogramar mueve cada
  // evento en su sitio y las franjas sobrantes se siguen cancelando.
  //
  // 22-nov-2026 · El nombre dice que es una INVITACIÓN DE CALENDARIO y de qué
  // sesión. Con «OS-2026-0249-1de4.ics» el cliente creyó que eran los formatos
  // que faltaban (reporte del 20-nov). Las canceladas lo dicen y no cuentan en
  // el «de N», que es el número de sesiones vigentes.
  // 26-nov-2026 · «de N» cuenta la visita entera (`todas`), no solo lo que va en
  // este correo: en un envío por partes la sesión nueva es la 3 de 3, no la 1 de 1.
  const vigentes = visita.length || tramos.filter((t) => !t.cancelado).length;
  const ddmmaaaa = (iso) => String(iso).split('-').reverse().join('-');
  return tramos.map((t) => ({
    contenido: calendario(evento(t)),
    nombre: t.cancelado
      ? (t.fecha
          ? `Calendario - sesion CANCELADA (${ddmmaaaa(t.fecha)}) - ${orden.codigo}.ics`
          : `Calendario - sesion ${t.sesion} CANCELADA - ${orden.codigo}.ics`)
      : vigentes > 1
        ? `Calendario - sesion ${t.sesion} de ${vigentes} - ${orden.codigo}.ics`
        : `Calendario - ${orden.codigo}.ics`,
    // Para el cuerpo del correo: qué sesión es y cuándo.
    sesion: t.sesion ?? null,
    total: vigentes,
    inicio: t.inicio,
    fin: t.fin,
    cancelado: t.cancelado,
    // La franja de la que sale (para describirla en el correo).
    franja: t.franja ?? null,
  }));
}

/**
 * Adjunto listo para nodemailer.
 *
 * El `contentType` con `method=REQUEST` es lo que distingue una invitación de
 * un archivo adjunto cualquiera; sin él Gmail ofrece descargar el .ics en vez
 * de mostrar los botones de respuesta.
 */
export function adjuntosInvitacion(invitaciones) {
  return (invitaciones ?? []).map((inv) => ({
    filename: inv.nombre,
    content: inv.contenido,
    contentType: 'text/calendar; charset=utf-8; method=REQUEST',
  }));
}
