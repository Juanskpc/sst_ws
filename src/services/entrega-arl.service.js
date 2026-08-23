/**
 * FOR/SUP · QUÉ se le manda al profesional y QUÉ tiene que devolver, según la
 * ARL, el tipo de actividad, las horas y la modalidad.
 *
 * Hasta ago-2026 esto era una lista plana por ARL: Bolívar mandaba siempre sus
 * dos formatos, Colmena los suyos, AXA el suyo, y el portal pedía siempre las
 * mismas tres casillas. La realidad que describió el cliente —y que confirman
 * los formatos que entregó cada ARL— es una matriz:
 *
 *   * Una **asesoría** de Bolívar no lleva registro de asistencia; una
 *     **capacitación**, sí — pero solo si es **presencial**, porque el
 *     comunicado SNPARL-40035219-2025 dice que el AT-028 es «únicamente para
 *     actividades presenciales».
 *   * Una **asesoría de AXA de 20 horas** lleva informe técnico; la misma
 *     asesoría de 8 horas lleva ficha de gestión. El corte está en 16.
 *   * Una **asistencia técnica** entrega informe; una capacitación, no.
 *
 * Y de la misma regla sale lo que el profesional tiene que subir: pedirle un
 * registro fotográfico de una asesoría de Bolívar es pedirle algo que la ARL no
 * exige, y no pedirle el informe de una asistencia técnica es descubrir que
 * falta cuando ya no hay a quién reclamárselo.
 *
 * Por qué vive aparte de `formatos-arl.service.js`: aquí están las REGLAS (qué
 * documentos y qué soportes), allí el REGISTRO (dónde está cada archivo y cómo
 * se rellena). El portal público y la asignación necesitan lo primero sin
 * arrastrar `pdf-lib` ni los assets.
 */
import { esBolivar, normalizarTipoActividadBolivar } from '../utils/bolivar.js';

/** 'AXA Colpatria' → 'colpatria'; 'Bolívar' → 'bolivar'. Sin tildes. */
export function carpetaArl(nombre) {
  const slug = String(nombre ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .trim().toLowerCase();
  return slug.includes('colpatria') ? 'colpatria' : slug;
}

// ---------------------------------------------------------------------------
// Tipo de actividad, normalizado entre las tres ARL
// ---------------------------------------------------------------------------

/**
 * Las claves con las que se enruta. Son las categorías de negocio, no las de
 * ninguna ARL en concreto: Bolívar las llama por letra, AXA y Colmena por el
 * nombre de la carpeta en la que entregan sus formatos.
 */
export const TIPOS_ACTIVIDAD = {
  ASESORIA: 'ASESORIA',
  ASISTENCIA_TECNICA: 'ASISTENCIA_TECNICA',
  CAPACITACION: 'CAPACITACION',
  SERVICIO_ESPECIALIZADO: 'SERVICIO_ESPECIALIZADO',
  MATERIAL: 'MATERIAL',
  OTROS: 'OTROS',
};

/** La letra del AT-031 → la clave de enrutamiento. */
const POR_LETRA = {
  A: TIPOS_ACTIVIDAD.ASESORIA,
  T: TIPOS_ACTIVIDAD.ASISTENCIA_TECNICA,
  C: TIPOS_ACTIVIDAD.CAPACITACION,
  E: TIPOS_ACTIVIDAD.SERVICIO_ESPECIALIZADO,
  M: TIPOS_ACTIVIDAD.MATERIAL,
  O: TIPOS_ACTIVIDAD.OTROS,
};

/**
 * El nombre del catálogo CFG-04 → la clave de enrutamiento.
 *
 * Se compara por subcadena y sin tildes porque el catálogo lo edita el cliente
 * desde Configuración: hoy dice "Capacitación", mañana puede decir
 * "Capacitaciones" o "CAPACITACION". Lo que no encaja no se fuerza — devuelve
 * null y la orden cae en la regla de respaldo de su ARL.
 */
function porNombreDeTipo(nombre) {
  const t = String(nombre ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  if (!t.trim()) return null;
  if (t.includes('asistencia')) return TIPOS_ACTIVIDAD.ASISTENCIA_TECNICA;
  if (t.includes('capacit') || t.includes('formacion')) return TIPOS_ACTIVIDAD.CAPACITACION;
  if (t.includes('asesor')) return TIPOS_ACTIVIDAD.ASESORIA;
  if (t.includes('especializ')) return TIPOS_ACTIVIDAD.SERVICIO_ESPECIALIZADO;
  if (t.includes('material')) return TIPOS_ACTIVIDAD.MATERIAL;
  return null;
}

/**
 * El TÍTULO de la actividad, tal como lo escribió la ARL en el documento.
 *
 * Es la tercera fuente y existe por una razón muy concreta: el catálogo CFG-04
 * lo edita el cliente para **cobrar**, no para clasificar formatos, y hoy no
 * tiene una entrada "Asesoría" — así que una asesoría de AXA o de Colmena no se
 * puede reconocer por ahí (ver la decisión D-8 del plan de la tanda).
 *
 * AXA abrevia con un prefijo de tres letras en el propio título de la orden
 * ("ASE CONTROL ACCIDENTALIDAD PROFESIONAL", "CAP TRABAJO SEGURO EN ALTURAS");
 * Colmena lo escribe con todas sus letras. El prefijo se mira PRIMERO porque es
 * más específico: un título que empieza por "CAP" es una capacitación aunque
 * más adelante mencione la palabra asesoría.
 */
function porTituloDeActividad(titulo) {
  const t = String(titulo ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .trim().toUpperCase();
  if (!t) return null;
  if (/^ASE\b/.test(t)) return TIPOS_ACTIVIDAD.ASESORIA;
  if (/^CAP\b/.test(t)) return TIPOS_ACTIVIDAD.CAPACITACION;
  if (/^(AT|ASIS)\b/.test(t)) return TIPOS_ACTIVIDAD.ASISTENCIA_TECNICA;
  return porNombreDeTipo(t);
}

/**
 * El tipo de actividad de una orden, y DE DÓNDE salió.
 *
 * Por orden de autoridad:
 *
 *  1. **La letra del SIPAB**, en Bolívar. La escribió la ARL en el documento de
 *     origen y es la que se marca en el formato que se le radica: no hay fuente
 *     mejor.
 *  2. **El tipo de orden** (CFG-04). Ojo: es la categoría con la que se le
 *     **paga** al profesional y puede no coincidir con la actividad — una
 *     asistencia técnica se puede estar cobrando a tarifa de asesoría, que es
 *     una decisión de precios y no de formatos.
 *  3. **El título de la actividad**, que es lo único que queda cuando el
 *     catálogo no tiene una categoría equivalente.
 *
 * Devolver el origen no es un adorno: permite avisar a quien asigna de que el
 * juego de formatos se decidió con la fuente más débil.
 */
export function tipoActividadDeOrden(orden) {
  if (esBolivar(orden?.arl_nombre)) {
    const letra = normalizarTipoActividadBolivar(orden?.tipo_servicio_arl);
    if (letra) return { tipo: POR_LETRA[letra], origen: 'letra' };
  }
  const porCatalogo = porNombreDeTipo(orden?.tipo_orden);
  if (porCatalogo) return { tipo: porCatalogo, origen: 'catalogo' };

  const porTitulo = porTituloDeActividad(orden?.tipo_actividad);
  if (porTitulo) return { tipo: porTitulo, origen: 'titulo' };

  return { tipo: null, origen: null };
}

// ---------------------------------------------------------------------------
// Las reglas
// ---------------------------------------------------------------------------

/**
 * Corte de horas de AXA Colpatria para las asesorías.
 *
 * Las carpetas del cliente lo escriben como «16 unidades» y «superiores a 16
 * horas». Se compara contra `horas_asignadas`, que es lo único cuantitativo que
 * tiene la orden. ⚠️ Si la actividad no se mide en horas el número significa
 * otra cosa; ver `avisoDeEntrega()`.
 */
const CORTE_HORAS_AXA = 16;

/**
 * Qué se manda y qué se pide, en orden de especificidad: **gana la primera
 * regla que encaje**, así que las condicionadas van antes que las generales.
 *
 * `formatos` son claves del registro de `formatos-arl.service.js`.
 * `soportes` son casillas del portal (`soportes.service.js`).
 * `nota` sale en el correo del profesional cuando hace falta explicarle algo
 * que no viaja como adjunto.
 */
const REGLAS = [
  // --- Bolívar -------------------------------------------------------------
  // El AT-028 (registro de asistencia) SOLO en presencial: lo prohíbe el
  // comunicado de la ARL. Sin él tampoco se le pide la lista firmada de vuelta.
  {
    arl: 'bolivar', tipo: TIPOS_ACTIVIDAD.CAPACITACION, modalidad: 'PRESENCIAL',
    formatos: ['at031', 'at028'],
    soportes: ['acta', 'asistencia', 'evidencias'],
  },
  {
    arl: 'bolivar', tipo: TIPOS_ACTIVIDAD.CAPACITACION, modalidad: 'VIRTUAL',
    formatos: ['at031'],
    soportes: ['acta', 'evidencias'],
    nota: 'Al ser una capacitación VIRTUAL no se adjunta el registro de asistencia AT-028: ' +
          'la ARL solo lo admite en actividades presenciales. En su lugar suba la evidencia de ' +
          'la sesión (captura de los asistentes conectados).',
  },
  // Asesoría y asistencia técnica no llevan registro fotográfico (lo dijo el
  // cliente). La asistencia técnica sí entrega informe de gestión.
  {
    arl: 'bolivar', tipo: TIPOS_ACTIVIDAD.ASISTENCIA_TECNICA,
    formatos: ['at031'],
    soportes: ['acta', 'asistencia', 'informe'],
    nota: 'Esta asistencia técnica requiere INFORME DE GESTIÓN. Aún no tenemos el formato en ' +
          'blanco de la ARL cargado en la plataforma, así que redáctelo con el modelo habitual ' +
          'de Bolívar y súbalo en la casilla "Informe técnico o de gestión".',
  },
  {
    arl: 'bolivar', tipo: TIPOS_ACTIVIDAD.ASESORIA,
    formatos: ['at031'],
    soportes: ['acta', 'asistencia'],
  },

  // --- AXA Colpatria -------------------------------------------------------
  // El corte de 16 parte las asesorías en dos: por debajo, ficha de gestión;
  // por encima, informe técnico completo.
  {
    arl: 'colpatria', tipo: TIPOS_ACTIVIDAD.ASESORIA, horasHasta: CORTE_HORAS_AXA,
    formatos: ['asistentesAxa', 'fichaAxa'],
    soportes: ['acta', 'asistencia', 'evidencias', 'informe'],
  },
  {
    arl: 'colpatria', tipo: TIPOS_ACTIVIDAD.ASESORIA,
    formatos: ['asistentesAxa', 'informeAxa'],
    soportes: ['acta', 'asistencia', 'evidencias', 'informe'],
  },
  {
    arl: 'colpatria', tipo: TIPOS_ACTIVIDAD.CAPACITACION,
    formatos: ['asistentesAxa'],
    soportes: ['acta', 'asistencia', 'evidencias'],
  },

  // --- Colmena -------------------------------------------------------------
  {
    arl: 'colmena', tipo: TIPOS_ACTIVIDAD.CAPACITACION,
    formatos: ['prestacionColmena', 'asistenciaColmena', 'registroEjecucionColmena',
               'evaluacionColmena', 'plantillaColmena'],
    soportes: ['acta', 'asistencia', 'evidencias'],
  },
  {
    arl: 'colmena', tipo: TIPOS_ACTIVIDAD.ASESORIA,
    formatos: ['prestacionColmena', 'asistenciaColmena', 'informeColmenaA', 'informeColmenaB'],
    soportes: ['acta', 'asistencia', 'evidencias', 'informe'],
    nota: 'Se adjuntan los DOS modelos de informe de Colmena (tipo A y tipo B). Use el que ' +
          'corresponda a esta actividad y descarte el otro.',
  },
];

/**
 * Respaldo por ARL cuando ninguna regla encaja (tipo de actividad desconocido,
 * o una letra E/M/O de Bolívar que el cliente todavía no ha detallado).
 *
 * Existe porque **una orden sin formatos es un correo sin un solo PDF**, que es
 * exactamente lo que estuvo pasando con Colmena durante semanas: el profesional
 * llegaba a la visita sin los papeles de la ARL. Ante la duda se manda el
 * formato base de esa ARL, que sirve siempre, y se piden los soportes de
 * siempre.
 */
const RESPALDO = {
  bolivar: { formatos: ['at031'], soportes: ['acta', 'asistencia'] },
  colpatria: { formatos: ['asistentesAxa'], soportes: ['acta', 'asistencia', 'evidencias'] },
  colmena: {
    formatos: ['prestacionColmena', 'asistenciaColmena'],
    soportes: ['acta', 'asistencia', 'evidencias'],
  },
};

/** Casillas que se piden cuando no se sabe nada de la orden (ARL desconocida). */
export const SOPORTES_POR_DEFECTO = ['acta', 'asistencia', 'evidencias'];

const numero = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** ¿Encaja esta regla con la orden? */
function encaja(regla, { arl, tipo, modalidad, horas }) {
  if (regla.arl !== arl) return false;
  if (regla.tipo && regla.tipo !== tipo) return false;
  if (regla.modalidad && regla.modalidad !== modalidad) return false;
  // Sin horas no se puede aplicar un corte por horas: la regla no encaja y se
  // pasa a la siguiente, que es la general. Mejor mandar el juego completo que
  // decidir el formato con un dato que no existe.
  if (regla.horasHasta != null && !(horas != null && horas <= regla.horasHasta)) return false;
  return true;
}

/**
 * Qué se le entrega al profesional y qué tiene que devolver.
 *
 * @returns {{formatos: string[], soportes: string[], nota: string|null,
 *            arl: string, tipo: string|null, porRespaldo: boolean}}
 */
export function entregaDeLaOrden(orden) {
  const arl = carpetaArl(orden?.arl_nombre);
  const { tipo, origen } = tipoActividadDeOrden(orden);
  const modalidad = String(orden?.modalidad_ejecucion ?? '').trim().toUpperCase() || null;
  const horas = numero(orden?.horas_asignadas);

  const regla = REGLAS.find((r) => encaja(r, { arl, tipo, modalidad, horas }));
  if (regla) {
    return {
      formatos: [...regla.formatos],
      soportes: [...regla.soportes],
      nota: regla.nota ?? null,
      arl, tipo, origen, porRespaldo: false,
    };
  }

  const respaldo = RESPALDO[arl];
  return {
    formatos: respaldo ? [...respaldo.formatos] : [],
    soportes: respaldo ? [...respaldo.soportes] : [...SOPORTES_POR_DEFECTO],
    nota: null,
    arl, tipo, origen, porRespaldo: true,
  };
}

/**
 * Qué conviene advertirle a QUIEN ASIGNA (no al profesional) sobre esta entrega.
 *
 * Son los casos en que la matriz decidió con un dato incompleto y el resultado
 * puede no ser el que la ARL espera. Se avisa en la respuesta de la asignación,
 * que es el único momento en que alguien puede corregirlo antes de que el
 * correo salga.
 */
export function avisoDeEntrega(orden, entrega) {
  if (!entrega.arl) return null;
  if (entrega.porRespaldo) {
    return entrega.tipo
      ? `No hay una regla de formatos para ${entrega.tipo.toLowerCase().replace(/_/g, ' ')} en ` +
        `esta ARL: se envió el juego base. Confírmelo antes de que el profesional ejecute.`
      : 'No se pudo determinar el tipo de actividad de la orden (falta el tipo de orden, o la ' +
        'letra del AT-031 en Bolívar): se envió el juego base de formatos de la ARL.';
  }
  // El corte de AXA se aplica sobre `horas_asignadas`, y las carpetas de la ARL
  // hablan de "unidades". En una orden que no se mide en horas el número
  // significa otra cosa y el corte puede caer del lado equivocado.
  if (entrega.arl === 'colpatria' && entrega.tipo === TIPOS_ACTIVIDAD.ASESORIA) {
    const horas = numero(orden?.horas_asignadas);
    if (horas == null) {
      return 'La asesoría de AXA no tiene horas, así que se envió el informe técnico (el juego ' +
             'de más de 16 unidades). Si son 16 o menos, corresponde la ficha de gestión.';
    }
  }
  // El título es la fuente más débil de las tres: no lo eligió nadie, se dedujo
  // de cómo la ARL redactó la orden.
  if (entrega.origen === 'titulo') {
    return `El tipo de actividad se dedujo del título de la orden (${entrega.tipo.toLowerCase().replace(/_/g, ' ')}), ` +
           'porque el catálogo de tipos de orden no tiene una categoría equivalente. ' +
           'Compruebe que los formatos adjuntos son los correctos.';
  }
  return null;
}
