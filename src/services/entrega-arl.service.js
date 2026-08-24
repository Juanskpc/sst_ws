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
 * Desde el **24-ago-2026** eso ya no se escribe dos veces. Lo que hay que
 * devolver se DERIVA de los formatos que salen (`DEVUELVE`), y a mano solo se
 * declara lo que vuelve sin haber ido adjunto (`extras`). Antes eran dos listas
 * paralelas y se separaron: el correo de una asistencia técnica de Bolívar
 * mandaba un solo formato y pedía de vuelta dos.
 *
 * Por qué vive aparte de `formatos-arl.service.js`: aquí están las REGLAS (qué
 * documentos y qué soportes), allí el REGISTRO (dónde está cada archivo y cómo
 * se rellena). El portal público y la asignación necesitan lo primero sin
 * arrastrar `pdf-lib` ni los assets.
 */
import { normalizarTipoActividadBolivar } from '../utils/bolivar.js';
import { esCategoriaValida, ordenCategoria } from './soportes.service.js';

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
 * Un nombre de actividad → la clave de enrutamiento.
 *
 * Se compara por subcadena y sin tildes porque el texto no está normalizado: es
 * como la ARL redactó el título de la orden. Lo que no encaja no se fuerza —
 * devuelve null y la orden cae en la regla de respaldo de su ARL.
 *
 * ⚠️ Hasta el 24-ago-2026 esto se aplicaba también al **tipo de orden** del
 * catálogo CFG-04, y era una confusión: ese catálogo dice **cuánto se le paga la
 * hora al profesional**, no qué formatos exige la ARL. Una asistencia técnica se
 * puede estar cobrando a tarifa de asesoría —es una decisión de precios— y eso
 * no puede cambiarle los papeles que se radican. Ya no se consulta.
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
 * Es el respaldo para las órdenes que nadie diligenció: las cargadas antes de
 * que el desplegable existiera para AXA y Colmena, y las que se guardaron sin
 * elegir tipo.
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
 * Los tipos de actividad que ofrece cada ARL, por su letra.
 *
 * Bolívar usa las seis del AT-031 porque son las que trae su Excel SIPAB. AXA y
 * Colmena solo distinguen asesoría de capacitación; **AXA parte además las
 * asesorías por las HORAS** (el corte está en 16), y eso no es un tipo más que
 * elegir: son dos juegos de formatos que salen del mismo tipo y de un dato que
 * la orden ya tiene.
 *
 * Espejo de `LETRAS_POR_ARL` en `sst_app/src/app/core/bolivar.ts`.
 */
export const TIPOS_ACTIVIDAD_POR_ARL = {
  bolivar: ['A', 'T', 'C', 'E', 'M', 'O'],
  colpatria: ['A', 'C'],
  colmena: ['A', 'C'],
};

/** Lo que se ofrece cuando la ARL no es ninguna de las tres conocidas. */
const TIPOS_POR_DEFECTO = ['A', 'T', 'C'];

/** Las letras que se le pueden elegir a una orden de esta ARL. */
export function tiposActividadDeArl(arlNombre) {
  return TIPOS_ACTIVIDAD_POR_ARL[carpetaArl(arlNombre)] ?? TIPOS_POR_DEFECTO;
}

/**
 * El tipo de actividad de una orden, y DE DÓNDE salió.
 *
 * ⚠️ **Esto no es el «tipo de orden» del catálogo de Configuración.** Son dos
 * conceptos que se llamaban casi igual y llegaron a mezclarse en este archivo:
 *
 *   * **Tipo de actividad ante la ARL** (`tipo_servicio_arl`, este) → decide
 *     **qué formatos** se le mandan al profesional y qué tiene que devolver.
 *   * **Tipo de orden** (CFG-04, `tipo_orden_id`) → decide **el valor de la hora**
 *     que se le paga. No interviene aquí en absoluto.
 *
 * Por orden de autoridad:
 *
 *  1. **`tipo_servicio_arl`**, que es lo que se eligió al cargar la orden (y en
 *     Bolívar llega ya puesto desde la columna del SIPAB). En las tres ARL: la
 *     letra es el código interno, no un invento de Bolívar.
 *  2. **El título de la actividad**, tal como lo escribió la ARL en el
 *     documento. Es lo único que queda cuando nadie eligió el tipo.
 *
 * Devolver el origen no es un adorno: permite avisar a quien asigna de que el
 * juego de formatos se decidió con la fuente más débil.
 */
export function tipoActividadDeOrden(orden) {
  const letra = normalizarTipoActividadBolivar(orden?.tipo_servicio_arl);
  if (letra) return { tipo: POR_LETRA[letra], origen: 'seleccion' };

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
 * En qué casilla del portal vuelve cada formato, ya diligenciado y firmado.
 *
 * Esto es lo que arregla el desajuste que reportó el cliente el 24-ago-2026:
 * la lista de lo que había que devolver se escribía A MANO en cada regla, al
 * lado de la lista de formatos, y las dos se separaron. Una asistencia técnica
 * de Bolívar sale con un solo formato —el AT-031 de seguimiento— y el correo le
 * pedía además una «Lista de asistencia» que no iba adjunta y que la ARL no
 * exige: los asistentes se firman DENTRO del propio AT-031.
 *
 * Ahora la lista se DERIVA de los formatos que salen. Lo que se escribe a mano
 * es solo lo que vuelve sin haber ido adjunto (`extras`), que por definición no
 * puede deducirse de aquí.
 *
 * `null` = ese formato no vuelve por el portal. Son de dos clases: los que son
 * material de trabajo (la plantilla de presentaciones de Colmena) y los que sí
 * se devuelven a la ARL pero para los que el portal **no tiene casilla**
 * (evaluación y registro de ejecución de Colmena). Lo segundo es un hueco
 * conocido, no una decisión: se pedirían el día que se añadan las casillas.
 */
const DEVUELVE = {
  // Bolívar · el AT-031 de seguimiento ES el acta de la visita.
  at031: 'acta',
  at028: 'asistencia',
  informeBolivar: 'informe',

  // AXA Colpatria · la ficha de gestión y el informe técnico ocupan la misma
  // casilla: son el informe de la actividad, y nunca salen los dos a la vez.
  asistentesAxa: 'asistencia',
  fichaAxa: 'informe',
  informeAxa: 'informe',

  // Colmena · la prestación de servicios es lo que firma la empresa para dar la
  // visita por prestada; hace de acta.
  prestacionColmena: 'acta',
  asistenciaColmena: 'asistencia',
  informeColmenaA: 'informe',
  informeColmenaB: 'informe',
  evaluacionColmena: null,
  registroEjecucionColmena: null,
  plantillaColmena: null,
};

/**
 * Qué se manda y qué se pide, en orden de especificidad: **gana la primera
 * regla que encaje**, así que las condicionadas van antes que las generales.
 *
 * `formatos` son claves del registro de `formatos-arl.service.js`. De ellos
 * sale, por `DEVUELVE`, casi toda la lista de lo que hay que subir.
 * `extras` son las casillas que se piden SIN mandar formato: el registro
 * fotográfico, que no tiene formulario, y el informe de una ARL que no nos ha
 * entregado el suyo en blanco. Va por separado para que se lea como lo que es
 * —una excepción— y no se pueda volver a desajustar de los formatos.
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
    extras: ['evidencias'],
  },
  {
    arl: 'bolivar', tipo: TIPOS_ACTIVIDAD.CAPACITACION, modalidad: 'VIRTUAL',
    formatos: ['at031'],
    extras: ['evidencias'],
    nota: 'Al ser una capacitación VIRTUAL no se adjunta el registro de asistencia AT-028: ' +
          'la ARL solo lo admite en actividades presenciales. En su lugar suba la evidencia de ' +
          'la sesión (captura de los asistentes conectados).',
  },
  // Asesoría y asistencia técnica no llevan registro fotográfico (lo dijo el
  // cliente) ni lista de asistencia aparte: los asistentes se firman dentro del
  // propio AT-031. La asistencia técnica sí entrega informe de gestión.
  {
    arl: 'bolivar', tipo: TIPOS_ACTIVIDAD.ASISTENCIA_TECNICA,
    formatos: ['at031', 'informeBolivar'],
    nota: 'El informe de gestión que va adjunto es un EJEMPLO ya diligenciado de otra visita: ' +
          'es el modelo que usa Bolívar, no un formato en blanco. Úselo como guía y reescriba ' +
          'TODO su contenido con los datos de esta orden —empresa, NIT, fechas, hallazgos, ' +
          'fotografías y su propia firma— antes de subirlo en la casilla "Informe técnico o de ' +
          'gestión". No lo devuelva con los datos del ejemplo.',
  },
  {
    arl: 'bolivar', tipo: TIPOS_ACTIVIDAD.ASESORIA,
    formatos: ['at031'],
  },

  // --- AXA Colpatria -------------------------------------------------------
  // El corte de 16 parte las asesorías en dos: por debajo, ficha de gestión;
  // por encima, informe técnico completo.
  //
  // AXA no entrega formato de acta: la ficha de gestión (o el informe técnico)
  // es su registro de la visita, así que no se pide un «acta» aparte que el
  // profesional tendría que inventarse.
  {
    arl: 'colpatria', tipo: TIPOS_ACTIVIDAD.ASESORIA, horasHasta: CORTE_HORAS_AXA,
    formatos: ['asistentesAxa', 'fichaAxa'],
    extras: ['evidencias'],
  },
  {
    arl: 'colpatria', tipo: TIPOS_ACTIVIDAD.ASESORIA,
    formatos: ['asistentesAxa', 'informeAxa'],
    extras: ['evidencias'],
  },
  {
    arl: 'colpatria', tipo: TIPOS_ACTIVIDAD.CAPACITACION,
    formatos: ['asistentesAxa'],
    extras: ['evidencias'],
  },

  // --- Colmena -------------------------------------------------------------
  {
    arl: 'colmena', tipo: TIPOS_ACTIVIDAD.CAPACITACION,
    formatos: ['prestacionColmena', 'asistenciaColmena', 'registroEjecucionColmena',
               'evaluacionColmena', 'plantillaColmena'],
    extras: ['evidencias'],
  },
  {
    arl: 'colmena', tipo: TIPOS_ACTIVIDAD.ASESORIA,
    formatos: ['prestacionColmena', 'asistenciaColmena', 'informeColmenaA', 'informeColmenaB'],
    extras: ['evidencias'],
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
  bolivar: { formatos: ['at031'] },
  colpatria: { formatos: ['asistentesAxa'], extras: ['evidencias'] },
  colmena: {
    formatos: ['prestacionColmena', 'asistenciaColmena'],
    extras: ['evidencias'],
  },
};

/**
 * Casillas que se piden cuando no se sabe nada de la orden (ARL desconocida).
 *
 * Aquí no hay formatos de los que deducir nada —no salió ni un PDF—, así que se
 * piden los tres soportes de siempre y que el administrador afine al revisar.
 */
export const SOPORTES_POR_DEFECTO = ['acta', 'asistencia', 'evidencias'];

/**
 * Lo que el profesional tiene que subir: los formatos que se le mandaron, ya
 * firmados, más los extras de la regla. Sin repeticiones —dos formatos pueden
 * volver en la misma casilla, como los dos informes de Colmena— y en el orden
 * en que se revisan.
 */
function soportesDe(formatos = [], extras = []) {
  const claves = [
    ...formatos.map((f) => DEVUELVE[f]).filter(Boolean),
    ...extras,
  ];
  return [...new Set(claves)].sort((a, b) => ordenCategoria(a) - ordenCategoria(b));
}

/**
 * Comprobación al arrancar, no al asignar: un formato sin entrada en `DEVUELVE`
 * saldría adjunto y NO se pediría de vuelta, y un `extra` mal escrito se
 * perdería en la casilla «otros». Las dos cosas solo se notarían al revisar los
 * soportes de una visita que ya ocurrió, así que es mejor no arrancar.
 */
for (const regla of [...REGLAS, ...Object.values(RESPALDO)]) {
  for (const clave of regla.formatos ?? []) {
    if (!(clave in DEVUELVE)) {
      throw new Error(`[entrega-arl] el formato '${clave}' no dice en qué casilla vuelve (DEVUELVE).`);
    }
  }
  for (const extra of regla.extras ?? []) {
    if (!esCategoriaValida(extra)) {
      throw new Error(`[entrega-arl] '${extra}' no es una casilla del portal.`);
    }
  }
}

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
      soportes: soportesDe(regla.formatos, regla.extras),
      nota: regla.nota ?? null,
      arl, tipo, origen, porRespaldo: false,
    };
  }

  const respaldo = RESPALDO[arl];
  return {
    formatos: respaldo ? [...respaldo.formatos] : [],
    // Sin ARL conocida no hay formatos, y sin formatos no hay nada que derivar.
    soportes: respaldo ? soportesDe(respaldo.formatos, respaldo.extras) : [...SOPORTES_POR_DEFECTO],
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
      : 'La orden no tiene diligenciado el "Tipo de actividad ARL", que es lo que decide los ' +
        'formatos, y su título tampoco lo dice: se envió el juego base de la ARL. Diligéncielo ' +
        'en la ficha y vuelva a asignar.';
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
  // El título es la fuente débil: no lo eligió nadie, se dedujo de cómo la ARL
  // redactó la orden.
  if (entrega.origen === 'titulo') {
    return `El tipo de actividad se dedujo del título de la orden (${entrega.tipo.toLowerCase().replace(/_/g, ' ')}) ` +
           'porque la orden no lo tiene elegido. Diligencie "Tipo de actividad ARL" en la ficha, ' +
           'o compruebe que los formatos adjuntos son los correctos.';
  }
  return null;
}
