/**
 * FOR · Formatos OFICIALES de cada ARL, prediligenciados con los datos de la OS.
 *
 * Lo que el profesional recibía antes eran hojas genéricas de la plataforma: le
 * servían para ver que el correo traía adjuntos, pero no para radicar. Lo que la
 * ARL exige es SU formato, con su membrete y su código de forma, así que aquí no
 * se dibuja un documento nuevo — se abre el formato en blanco que entrega la ARL
 * (`assets/formatos-arl/`) y se le escriben encima los datos que ya se conocen.
 *
 * La frontera de qué se rellena y qué no es deliberada: va prediligenciado todo
 * lo que la OS ya sabe (empresa, NIT, fecha, horario, ciudad, tema, profesional)
 * y se deja INTACTO todo lo que solo existe después de la sesión —los temas
 * desarrollados, los compromisos, las observaciones, la lista de asistentes y
 * las firmas—. Rellenar eso sería inventarse el acta de una visita que aún no
 * ocurrió.
 *
 * En los PDF de Bolívar los datos van en los campos del propio formulario y se
 * marcan de SOLO LECTURA en vez de aplanar el documento: así el profesional
 * todavía puede escribir a máquina el resto si prefiere no hacerlo a mano, pero
 * no puede alterar sin querer lo que la orden ya fijó.
 *
 * Un juego de formatos POR FRANJA: una visita partida en dos días son dos
 * sesiones, cada una con su fecha, su horario y su propia lista de asistentes.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { horaAmPm, horasTexto } from '../utils/formato.js';
import { indiceModalidad, indiceTipoActividadBolivar, normalizarModalidadEjecucion } from '../utils/bolivar.js';
import { entregaDeLaOrden, tipoActividadDeOrden } from './entrega-arl.service.js';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'formatos-arl');

/**
 * Identidad de JD&D ante la ARL. Se sobreescribe con `sst.configuracion`.
 *
 * Los tres valores salen de los propios formatos que entregó Bolívar, que no
 * venían del todo en blanco: traían el nombre y el código de aliado ya escritos
 * y el plan puesto en PECAT. Se conservan aquí para que el formato siga saliendo
 * como hasta ahora, pero editables: el código de aliado lo asigna la ARL y el
 * plan puede no ser el mismo para todas las empresas.
 */
export const ALIADO_POR_DEFECTO = {
  nombre: 'JD Y D CONSULTORES',
  codigo_bolivar: '6484',
  plan_bolivar: 'PECAT',
};

/**
 * Tope de juegos de formatos por correo. Una OS de 50 horas puede quedar
 * repartida en muchas franjas, y el adjunto número treinta no ayuda a nadie:
 * pasado el tope se avisa y el resto se entrega aparte.
 */
const MAXIMO_JUEGOS = 8;

/** 'Bolívar' → 'bolivar'. Sin tildes ni mayúsculas: el nombre viene de la BD. */
export function slugArl(nombre) {
  return String(nombre ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .trim().toLowerCase();
}

/**
 * REGISTRO de formatos: dónde vive cada archivo y cómo se rellena.
 *
 * Las claves son las que usan las reglas de `entrega-arl.service.js`, que es
 * quien decide CUÁLES salen para cada orden. Aquí solo está el cómo.
 *
 *   `modo`
 *     'acroform' → PDF con formulario; se escribe por nombre de campo.
 *     'plano'    → PDF sin formulario; el valor se dibuja por coordenadas.
 *     'adjunto'  → se manda tal cual, sin tocar. Son los .docx/.xls/.pptx: no
 *                  son formatos con casillas sino guiones que el profesional
 *                  redacta en Word, y reescribirles el contenido descuadraría
 *                  el documento sin ganar nada (ver el caso de Colmena en el
 *                  README de assets).
 *
 *   `alcance`
 *     'sesion' → UNO POR FRANJA. Una visita partida en dos días son dos
 *                sesiones, cada una con su fecha, su horario y su propia lista
 *                de asistentes.
 *     'orden'  → uno por orden. Un informe de gestión o una ficha técnica de
 *                una asistencia técnica de tres días es UNO, no tres; emitir
 *                tres copias del mismo guión llena el correo de ruido y agota
 *                antes el tope de adjuntos.
 */
const FORMATOS = {
  // --- Bolívar · PDF con formulario ---
  // T0-13 · alcance 'orden': Bolívar pidió UN solo AT-031 por orden, aunque la
  // visita se reparta en varios días (el AT-028 de asistencia sí va uno por
  // sesión, y sigue en 'sesion' más abajo). `camposSeguimientoBolivar` recibe
  // por eso el TRAMO de la visita entera (`tramoDe`), no una sesión suelta.
  at031: {
    archivo: 'bolivar/seguimiento.pdf', modo: 'acroform', alcance: 'orden',
    tipo: 'seguimiento', nombre: 'seguimiento.pdf',
    etiqueta: 'Seguimiento de reuniones y actividades (AT-031)',
    campos: camposSeguimientoBolivar, marcas: marcasSeguimientoBolivar,
    // Vista previa · van en "Observaciones y sugerencias", ANTES del detalle de
    // sesiones que el sistema ya pone ahí.
    observaciones: { campo: '42' },
    editables: () => EDITABLES_AT031,
  },
  at028: {
    archivo: 'bolivar/asistencia.pdf', modo: 'acroform', alcance: 'sesion',
    tipo: 'asistencia', nombre: 'asistencia.pdf',
    etiqueta: 'Registro de asistencia (AT-028)',
    campos: camposAsistenciaBolivar,
    editables: () => EDITABLES_AT028,
    // Vista previa · el AT-028 no tiene campo de formulario para esto: se
    // escribe sobre las rayas de "Observaciones del participante ARL".
    observaciones: { renglones: () => RENGLONES_OBS_AT028 },
  },
  // El informe de gestión de las asistencias técnicas. ⚠️ NO es un formato en
  // blanco: es un informe REAL ya redactado, el único modelo que entregó el
  // cliente, y lleva la razón social y el NIT de una empresa, el nombre y la
  // licencia del profesional que lo firmó y el registro fotográfico de aquella
  // visita. Va como EJEMPLO —así se llama el adjunto y así lo dice el correo—
  // para que el profesional escriba el suyo encima, no para diligenciarlo.
  // Cuando la ARL entregue el formato en blanco, se reemplaza el archivo.
  informeBolivar: {
    archivo: 'bolivar/informe-gestion.docx', modo: 'adjunto', alcance: 'orden',
    tipo: 'informe_gestion', nombre: 'informe de gestion (EJEMPLO diligenciado).docx',
    etiqueta: 'Informe de gestión · EJEMPLO de otra visita, para reescribirlo entero',
  },

  // --- AXA Colpatria ---
  asistentesAxa: {
    archivo: 'colpatria/asistencia.pdf', modo: 'plano', alcance: 'sesion',
    tipo: 'asistencia', nombre: 'asistencia.pdf',
    etiqueta: 'Registro listado de asistencia',
    casillas: () => CASILLAS_ASISTENCIA_COLPATRIA, valores: valoresAsistenciaColpatria,
    editables: () => EDITABLES_ASISTENCIA_AXA,
  },
  fichaAxa: {
    archivo: 'colpatria/ficha-gestion.pdf', modo: 'acroform', alcance: 'orden',
    tipo: 'ficha_gestion', nombre: 'ficha-de-gestion.pdf',
    etiqueta: 'Ficha de gestión del proveedor',
    campos: camposFichaAxa,
    editables: () => EDITABLES_FICHA_AXA,
  },
  informeAxa: {
    archivo: 'colpatria/informe-tecnico.docx', modo: 'adjunto', alcance: 'orden',
    tipo: 'informe_tecnico', nombre: 'informe-tecnico (plantilla).docx',
    etiqueta: 'Formato de informe técnico (Word)',
  },

  // --- Colmena ---
  // T0-11 · `fechaImpresion: true` estampa "Fecha de impresión: DD/MM/AAAA" en
  // el margen inferior derecho (7 pt, sin tapar nada): es la fecha en que se
  // GENERA el documento, no la de la visita, que sigue en blanco a propósito
  // (supuesto por defecto de la ficha; ninguna de las celdas DD/MM/AAAA impresas
  // se toca). Solo los tres formatos de Colmena la llevan.
  // 29-sep · El informe de prestación que Colmena acepta es el SPM-F 38 que ELLA
  // misma genera: es el PDF de la orden de servicio que llega a JD&D, y ya trae
  // su "Fecha Impresión", la línea/programa/componente/actividad y las horas
  // solicitadas. Por eso, cuando la orden se importó de ese PDF, se escribe
  // encima del original (`sobreOriginal`); el PSP-F-007 de la plantilla solo
  // queda de respaldo para una orden sin archivo (cargada a mano, o cuyo PDF ya
  // no está en el almacenamiento). Así lo mostró JD&D con fotos del original
  // frente a lo que generaba Orbita.
  prestacionColmena: {
    archivo: 'colmena/prestacion-servicios.pdf', modo: 'plano', alcance: 'sesion',
    tipo: 'prestacion_servicios', nombre: 'prestacion-de-servicios.pdf',
    etiqueta: 'Informe de prestación de servicios',
    casillas: () => CASILLAS_PRESTACION_COLMENA, valores: valoresPrestacionColmena,
    editables: () => EDITABLES_PRESTACION_COLMENA,
    fechaImpresion: true,
    sobreOriginal: {
      casillas: () => CASILLAS_PRESTACION_COLMENA_ORIGINAL,
      valores: valoresPrestacionColmenaOriginal,
      // Recuadro "OBSERVACIONES Y RECOMENDACIONES DEL PROVEEDOR Y/O DEL CLIENTE".
      observaciones: { renglones: () => RENGLONES_OBS_SPM38 },
      // El resto del SPM-F 38 lo escribió Colmena: solo es de Orbita el nombre.
      editables: () => EDITABLES_SPM38,
    },
  },
  // 29-sep · La asistencia vigente es el "Registro de Ejecución de Actividades
  // de Prevención y de Formación" (PSP-F-006 V3 03/2026), el que JD&D radica de
  // verdad. Colmena lo entrega en Excel (`registro-ejecucion.xls`); se exportó
  // UNA vez a PDF carta apaisado para escribir encima sin que se descuadre,
  // igual que se hizo con la V2.4 que reemplaza.
  asistenciaColmena: {
    archivo: 'colmena/registro-ejecucion.pdf', modo: 'plano', alcance: 'sesion',
    tipo: 'asistencia', nombre: 'asistencia.pdf',
    etiqueta: 'Registro de ejecución de actividades (PSP-F-006 V3)',
    casillas: () => CASILLAS_REGISTRO_EJECUCION_COLMENA, valores: valoresRegistroEjecucionColmena,
    marcas: marcasRegistroEjecucionColmena,
    observaciones: { renglones: () => RENGLONES_OBS_REGISTRO_EJECUCION },
    editables: () => EDITABLES_REGISTRO_EJECUCION_COLMENA,
  },
  evaluacionColmena: {
    archivo: 'colmena/evaluacion.pdf', modo: 'plano', alcance: 'sesion',
    tipo: 'evaluacion', nombre: 'evaluacion.pdf',
    etiqueta: 'Evaluación de la sesión (PSP-F-010)',
    casillas: () => CASILLAS_EVALUACION_COLMENA, valores: valoresEvaluacionColmena,
    editables: () => EDITABLES_EVALUACION_COLMENA,
    fechaImpresion: true,
  },
  registroEjecucionColmena: {
    archivo: 'colmena/registro-ejecucion.xls', modo: 'adjunto', alcance: 'orden',
    tipo: 'registro_ejecucion', nombre: 'registro-de-ejecucion.xls',
    etiqueta: 'Registro de ejecución de actividades (Excel)',
  },
  plantillaColmena: {
    archivo: 'colmena/plantilla-presentaciones.pptx', modo: 'adjunto', alcance: 'orden',
    tipo: 'plantilla_presentacion', nombre: 'plantilla-de-presentaciones.pptx',
    etiqueta: 'Plantilla de presentaciones (PowerPoint)',
  },
  informeColmenaA: {
    archivo: 'colmena/informe-tipo-a.docx', modo: 'adjunto', alcance: 'orden',
    tipo: 'informe_tipo_a', nombre: 'informe tipo A (plantilla).docx',
    etiqueta: 'Informe de prestación de servicios · tipo A (Word)',
  },
  informeColmenaB: {
    archivo: 'colmena/informe-tipo-b.docx', modo: 'adjunto', alcance: 'orden',
    tipo: 'informe_tipo_b', nombre: 'informe tipo B (plantilla).docx',
    etiqueta: 'Informe técnico de servicios · tipo B (Word)',
  },
};

/**
 * ¿Esta ARL trae formato propio, o hay que caer en las plantillas genéricas?
 *
 * Se pregunta a las REGLAS, no a una lista aparte: si una ARL tiene entrega
 * definida (aunque sea la de respaldo), sus formatos mandan sobre cualquier
 * plantilla genérica de CFG-03.
 */
export function tieneFormatosPropios(arlNombre) {
  return entregaDeLaOrden({ arl_nombre: arlNombre }).formatos.length > 0;
}

// ---------------------------------------------------------------------------
// Datos de la OS → valores tal como se escriben en el formato
// ---------------------------------------------------------------------------

const enBlanco = (v) => (v === null || v === undefined ? '' : String(v).trim());

/**
 * El asunto de la sesión. `tipo_actividad` es el campo que trae el título real
 * ("CAP TRABAJO SEGURO EN ALTURAS"); `descripcion` es el volcado del documento
 * de la ARL y solo sirve de último recurso, recortado, porque en algunas OS
 * arrastra páginas enteras de texto legal.
 */
function temaDeLaOrden(orden) {
  const tipo = enBlanco(orden.tipo_actividad);
  if (tipo) return tipo;
  const desc = enBlanco(orden.descripcion);
  return desc.length > 160 ? `${desc.slice(0, 157)}…` : desc;
}

/**
 * Quién firma por la empresa. Se prefiere el responsable de SST: es quien
 * acompaña la visita y quien firma el formato, mientras que el contacto
 * administrativo puede ser de nómina o de compras.
 */
function contactoEmpresa(orden) {
  if (enBlanco(orden.contacto_sst_nombre)) {
    return { nombre: enBlanco(orden.contacto_sst_nombre), cargo: 'RESPONSABLE SST' };
  }
  return {
    nombre: enBlanco(orden.contacto_empresa_nombre),
    cargo: enBlanco(orden.contacto_empresa_cargo),
  };
}

const aMinutos = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm ?? ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * Los datos de UNA sesión. Sin franjas —se puede asignar profesional antes de
 * cerrar la fecha— la sesión queda sin día ni horario y esas casillas salen en
 * blanco, que es justo lo que hay que hacer: en el formato impreso un hueco se
 * rellena a bolígrafo, una fecha inventada no se puede corregir.
 */
function sesionDe(orden, franja) {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(enBlanco(franja?.fecha));
  const inicio = aMinutos(franja?.hora_inicio);
  const fin = aMinutos(franja?.hora_fin);
  const horasFranja = inicio !== null && fin !== null && fin > inicio ? (fin - inicio) / 60 : null;
  return {
    dia: iso ? iso[3] : '',
    mes: iso ? iso[2] : '',
    anio: iso ? iso[1] : '',
    fechaCorta: iso ? `${iso[3]}/${iso[2]}/${iso[1]}` : '',
    horaInicio: franja?.hora_inicio ? horaAmPm(franja.hora_inicio) : '',
    horaFin: franja?.hora_fin ? horaAmPm(franja.hora_fin) : '',
    // Las horas de ESTA sesión, no las de la orden: una visita de 8 h partida en
    // dos mañanas lleva "4" en cada registro de asistencia.
    horas: horasFranja !== null ? horasTexto(horasFranja) : horasTexto(orden.horas_asignadas),
  };
}

// ---------------------------------------------------------------------------
// Bolívar · PDF con formulario (AcroForm)
// ---------------------------------------------------------------------------

const TAMANO_BASE = 8;
const TAMANO_MINIMO = 5.5;
/** Altura a partir de la cual una casilla es un recuadro de varias líneas. */
const ALTO_MULTILINEA = 20;

/**
 * Encaja un valor en su casilla. Las del formato de Bolívar son estrechas de
 * verdad —la de "De:" del horario mide 33 puntos, donde "08:00 AM" a 8 pt no
 * cabe— y el visor recorta por el borde sin avisar: la hora salía impresa como
 * "08:00 A". Así que primero se encoge la letra y, si aun así no entra, se
 * recorta con puntos suspensivos, que al menos se ve que falta algo.
 *
 * Los recuadros altos (la actividad a realizar) se dejan en paz: ahí el texto
 * fluye en varias líneas y encogerlo solo lo haría más difícil de leer.
 */
function ajustarACasilla(campo, texto, font) {
  const rect = campo.acroField.getWidgets()[0]?.getRectangle();
  if (!rect || rect.height >= ALTO_MULTILINEA) return { texto, tamano: TAMANO_BASE };

  // Dos puntos de margen a cada lado, que es el recuadro que dibuja el propio
  // formato alrededor del texto.
  const util = Math.max(rect.width - 4, 8);
  let tamano = TAMANO_BASE;
  while (tamano > TAMANO_MINIMO && font.widthOfTextAtSize(texto, tamano) > util) tamano -= 0.5;

  let ajustado = texto;
  while (ajustado.length > 1 && font.widthOfTextAtSize(ajustado, tamano) > util) {
    ajustado = `${ajustado.slice(0, -2)}…`;
  }
  return { texto: ajustado, tamano };
}

/**
 * Marca UNA casilla de un grupo de opción, dibujándola sobre la página.
 *
 * No se usa `form.getRadioGroup(nombre).select(...)`, y no es por gusto: los
 * seis botones de "Tipo de Actividad" del AT-031 —y los dos de "Tipo de
 * Servicio"— **comparten el mismo valor de exportación** (`"Opción1"`), tal como
 * los dejó quien diseñó el formato. Seleccionar por valor los enciende TODOS a
 * la vez, que es la razón por la que estos grupos se dejaron sin marcar durante
 * meses y la casilla se rellenaba a bolígrafo sobre el impreso.
 *
 * Dibujar la equis sobre el rectángulo del widget elegido esquiva el problema
 * entero: no depende de cómo cada visor resuelva un grupo ambiguo, y es lo mismo
 * que ya se hace con los tres formatos planos (`rellenarPdfPlano`). El grupo se
 * queda sin valor, que en un formato que se imprime da igual.
 *
 * @param indice  Posición dentro del grupo, en el orden en que están impresas
 *                las casillas. Fuera de rango (o -1) no marca nada, que es lo
 *                que hay que hacer cuando la orden no trae el dato.
 */
function marcarOpcion(doc, form, fuente, nombreGrupo, indice) {
  if (!Number.isInteger(indice) || indice < 0) return;
  let grupo;
  try {
    grupo = form.getRadioGroup(nombreGrupo);
  } catch {
    // Un formato reemplazado por la ARL puede traer otros nombres de grupo. Se
    // registra y se sigue: mejor un formato con la casilla sin marcar que
    // ningún formato adjunto.
    console.warn(`[formatos] grupo de opción "${nombreGrupo}" ausente`);
    return;
  }
  const widget = grupo.acroField.getWidgets()[indice];
  if (!widget) {
    console.warn(`[formatos] "${nombreGrupo}" no tiene casilla ${indice}`);
    return;
  }
  const rect = widget.getRectangle();
  const pagina = paginaDelWidget(doc, widget);
  // La equis se dibuja centrada en el recuadro impreso. El tamaño sale de la
  // altura de la casilla (11 pt en el AT-031) para que siga cuadrando si la ARL
  // publica el formato a otra escala.
  const tamano = Math.max(5, Math.min(rect.height, rect.width) * 0.85);
  const ancho = fuente.widthOfTextAtSize('X', tamano);
  pagina.drawText('X', {
    x: rect.x + (rect.width - ancho) / 2,
    // 0.72 es la proporción de la altura de una mayúscula sobre el cuerpo de la
    // letra: sin ella la equis se apoya en el borde inferior del recuadro.
    y: rect.y + (rect.height - tamano * 0.72) / 2,
    size: tamano,
    font: fuente,
    color: rgb(0, 0, 0),
  });
}

/**
 * La página en la que vive un widget.
 *
 * El AT-031 tiene una sola página, así que bastaría con la primera; se resuelve
 * de verdad (por la referencia `/P` del widget, y si no está, buscándolo entre
 * los `/Annots` de cada página) para que un formato de varias páginas no acabe
 * con la equis dibujada en la hoja equivocada, que es un fallo silencioso: el
 * PDF sale bien formado y nadie lo nota hasta que la ARL devuelve el soporte.
 */
function paginaDelWidget(doc, widget) {
  const paginas = doc.getPages();
  const refPagina = widget.P();
  if (refPagina) {
    const encontrada = paginas.find((p) => p.ref === refPagina);
    if (encontrada) return encontrada;
  }
  const refWidget = widget.dict.context.getObjectRef(widget.dict);
  const porAnotacion = paginas.find((p) => (p.node.Annots()?.asArray() ?? []).includes(refWidget));
  return porAnotacion ?? paginas[0];
}

/**
 * Escribe los campos indicados y los deja de solo lectura. Los nombres de campo
 * del formato de Bolívar son los que puso quien lo diseñó ("Text2", "13"), así
 * que la correspondencia con su etiqueta impresa se documenta en cada mapa.
 *
 * @param marcas  Casillas de grupos de opción a marcar: `[[grupo, índice], …]`.
 *                Ver `marcarOpcion` para por qué no se seleccionan por valor.
 */
async function rellenarAcroForm(rutaPlantilla, valores, marcas = [], { parrafo = null } = {}) {
  const doc = await PDFDocument.load(await fs.readFile(rutaPlantilla));
  const form = doc.getForm();
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);

  // Los formatos que entrega la ARL no llegan vacíos del todo: arrastran restos
  // de la última vez que alguien los usó. Se limpia todo antes de escribir para
  // que en el formato solo haya lo que puso esta orden.
  for (const campo of form.getFields()) {
    if (campo.constructor.name === 'PDFTextField') campo.setText('');
  }

  for (const [nombre, valor] of Object.entries(valores)) {
    const texto = enBlanco(valor);
    if (!texto) continue;
    let campo;
    try {
      campo = form.getTextField(nombre);
    } catch {
      // Un formato reemplazado por la ARL puede traer otros nombres de campo. Se
      // registra y se sigue: mejor un formato con una casilla vacía que ningún
      // formato adjunto.
      console.warn(`[formatos] campo "${nombre}" ausente en ${path.basename(rutaPlantilla)}`);
      continue;
    }
    const { texto: ajustado, tamano } = ajustarACasilla(campo, texto, helvetica);
    // Varias líneas (observaciones de la vista previa + detalle de sesiones) y
    // el ajuste de un texto largo al ancho de una casilla alta (objetivo,
    // resultados…) solo ocurren si el campo está marcado como multilínea.
    const alto = campo.acroField.getWidgets()[0]?.getRectangle()?.height ?? 0;
    if (ajustado.includes('\n') || alto >= ALTO_MULTILINEA) campo.enableMultiline();
    campo.setText(ajustado);
    // La apariencia se dibuja a partir de este "default appearance", y algunos
    // campos del formato traían un gris claro heredado. Se fija en negro: esto
    // se imprime y se fotocopia para radicarlo ante la ARL.
    campo.acroField.setDefaultAppearance(`/Helv ${tamano} Tf 0 g`);
    campo.enableReadOnly();
  }

  // Sin esto el visor tendría que generar las apariencias por su cuenta, y los
  // que no lo hacen (varios lectores de móvil) enseñan el formato en blanco.
  form.updateFieldAppearances(helvetica);
  form.acroForm.dict.delete(form.acroForm.dict.context.obj('NeedAppearances'));

  // Las marcas van DESPUÉS de las apariencias: se dibujan en el contenido de la
  // página, no en el formulario, así que regenerarlas después las borraría.
  const negrita = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const [grupo, indice] of marcas) marcarOpcion(doc, form, negrita, grupo, indice);
  if (parrafo) escribirRenglones(doc.getPage(0), helvetica, parrafo.texto, parrafo.renglones);

  return Buffer.from(await doc.save());
}

/** Registro de Asistencia · FORMA AT-028. */
function camposAsistenciaBolivar(orden, profesional, sesion, aliado) {
  return {
    Text1: orden.codigo_cronograma,          // Cronograma
    Text2: orden.secuencia,                  // Secuencia
    Text3: sesion.dia,                       // Fecha · DD
    Text4: sesion.mes,                       // Fecha · MM
    Text5: sesion.anio,                      // Fecha · AAAA
    Text6: orden.empresa_nombre,             // Empresa
    Text7: orden.nit_nic,                    // NIT - Grupo
    Text8: aliado.plan_bolivar,              // Plan
    // El tema escrito a mano (T0-05) gana; sin él, el título del SIPAB como siempre.
    Text9: enBlanco(orden.tema_actividad) || temaDeLaOrden(orden), // Tema y/o Actividad a realizar
    Text11: sesion.horaInicio,               // Horario · De
    Text12: sesion.horaFin,                  // Horario · Hasta
    Text13: orden.ciudad_ejecucion,          // Ciudad / Departamento de prestación
    Text14: sesion.horas,                    // No. Total de Horas
    Text15: aliado.nombre,                   // Nombre Aliado Estratégico
    Text16: profesional?.nombre,             // Participante ARL
  };
}

/**
 * Seguimiento de Reuniones y Actividades · Forma AT-031.
 *
 * T0-13 · Recibe el TRAMO de la visita entera (`tramoDe`), no una sesión: es un
 * solo documento aunque haya varios días. `tramo.dia/mes/anio` y
 * `tramo.horaInicio` son los de la PRIMERA sesión; `tramo.horaFin`, los de la
 * ÚLTIMA (supuesto por defecto de la ficha, Q-06).
 */
function camposSeguimientoBolivar(orden, profesional, tramo, aliado) {
  const contacto = contactoEmpresa(orden);
  return {
    Text1: tramo.dia,                        // Fecha de prestación · DD
    Text2: tramo.mes,                        // MM
    3: tramo.anio,                           // AAAA
    4: orden.codigo_cronograma,              // SIPAB No. Cronograma
    5: orden.secuencia,                      // Secuencia
    6: orden.empresa_nombre,                 // Empresa
    7: orden.direccion,                      // Dirección
    8: orden.nit_nic,                        // NIT - Grupo
    9: enBlanco(orden.contacto_sst_telefono) || orden.contacto_empresa_telefono,
    10: orden.contacto_sst_correo,           // Correo Electrónico
    11: orden.ciudad_ejecucion,              // Ciudad / Departamento de prestación
    13: aliado.plan_bolivar,                 // PLAN
    14: tramo.horaInicio,                    // Hora Inicio (de la primera sesión)
    15: tramo.horaFin,                       // Hora Salida (de la última sesión)
    16: orden.asesor_gestion_riesgo,         // Asesor Gestión del Riesgo (del SIPAB)
    17: aliado.nombre,                       // Nombre Aliado Estratégico
    18: aliado.codigo_bolivar,               // Código Aliado Estratégico
    19: profesional?.nombre,                 // Participantes ARL · Nombres
    20: profesional?.especialidad || 'ASESOR SST',   // Participantes ARL · Cargo
    21: contacto.nombre,                     // Participantes Empresa · Nombres
    22: contacto.cargo,                      // Participantes Empresa · Cargo
    27: temaDeLaOrden(orden),                // Actividad a realizar
    // Temas desarrollados: solo si alguien escribió el tema a mano (T0-05). Sin él
    // queda en blanco, como antes: repetir aquí el título de arriba no aporta nada.
    28: enBlanco(orden.tema_actividad) || undefined,
    // T0-13 · Con un solo documento para varios días, "Fecha de prestación" y el
    // horario ya no alcanzan a contar la historia completa: aquí va el detalle
    // sesión a sesión ("Sesiones: 19/08 8:00-10:00; 20/08 8:00-10:00"), y solo
    // cuando de verdad hay más de un día — con uno solo repetirlo no aporta.
    42: enBlanco(tramo.observaciones) || undefined,
    // 29/31/32 (compromisos) y 43-47 (próxima reunión) son de la sesión: los
    // diligencia el profesional.
  };
}

/**
 * Casillas del AT-031 que se marcan a partir de la orden.
 *
 * Son los dos enumerados que Bolívar exige desde el comunicado
 * SNPARL-40035219-2025: el tipo de actividad (A/T/C/E/M/O) y el tipo de servicio
 * (presencial o virtual). El índice sale del catálogo de `utils/bolivar.js`, que
 * lista las opciones **en el mismo orden en que están impresas** en el formato.
 *
 * "¿Próxima reunión?" (`Group3`) se queda sin marcar a propósito: es de la
 * sesión, no de la orden, y solo se sabe cuando la visita ya ocurrió.
 */
function marcasSeguimientoBolivar(orden) {
  return [
    ['Group1', indiceTipoActividadBolivar(orden.tipo_servicio_arl)],
    ['Group2', indiceModalidad(orden.modalidad_ejecucion)],
  ];
}

// ---------------------------------------------------------------------------
// PDF planos · el valor se dibuja sobre la línea impresa
// ---------------------------------------------------------------------------

/**
 * Casillas de un formato sin formulario: `[clave, x, línea base, ancho útil]`.
 * El ancho llega hasta la siguiente división de la tabla y está medido sobre el
 * propio archivo de `assets/`, así que **cambiar la plantilla obliga a volver a
 * medir**.
 */

/** Colmena · Evaluación Sesión de Capacitación (PSP-F-010), vertical. */
const CASILLAS_EVALUACION_COLMENA = [
  ['ciudad', 124, 590, 195],
  ['dia', 372, 590, 25],
  ['mes', 420, 590, 45],
  ['anio', 492, 590, 53],
  ['empresa', 190, 577, 188],
  ['nit', 406, 577, 139],
  ['facilitador', 190, 564, 355],
  ['tema', 120, 550, 425],
];

/**
 * Colmena · Informe de Prestación de Servicios · PSP-F-007 V3.3, vertical y
 * grande (887 × 1148 pt).
 *
 * Las coordenadas se midieron sobre la imagen del formato, no sobre sus
 * etiquetas: en una tabla el rótulo puede estar encima, a la izquierda o dentro
 * de su celda, y deducirlo del texto produce un PDF impecable con los datos en
 * la columna de al lado. Para rehacerlo:
 *   node scripts/inspeccionar-formato.mjs assets/formatos-arl/colmena/prestacion-servicios.pdf  *        --png /tmp/psp007.png --escala 4 --zona 60 890 830 1000
 *
 * ⚠️ **La fecha (DD/MM/AAAA) se deja a mano a propósito.** Son tres celdas de
 * 33 pt con el rótulo "DD"/"MM"/"AAAA" impreso DENTRO, sin renglón libre encima
 * ni debajo: el número solo cabe encima del rótulo, y un formato que sale con
 * "01" pisando "DD" parece un error del sistema. En papel se rellena a
 * bolígrafo, y la fecha va igualmente en los otros dos formatos de Colmena.
 *
 * La casilla PERSONA NATURAL / PERSONA JURÍDICA tampoco se marca: es una
 * declaración sobre la figura legal del proveedor, y la plataforma no guarda
 * ese dato — deducirlo del nombre sería firmar por el cliente.
 */
const CASILLAS_PRESTACION_COLMENA = [
  ['hora', 310, 968, 110],
  ['numero_orden', 485, 968, 320],
  ['empresa', 185, 934, 620],
  ['nit', 95, 905, 270],
  ['ciudad', 560, 905, 245],
  // Fila de datos de "Descripción del servicio solicitado". Se rellenan la
  // actividad y las dos columnas de cantidad: "Solicitada" son las horas
  // TOTALES de la orden (lo que pide el documento) y "Ejecutada" las de ESTA
  // sesión (T0-12) — en una orden de 8 h repartida en dos franjas de 4, cada
  // PSP-F-007 sale con 8 solicitadas y 4 ejecutadas. Línea de intervención,
  // programa y componentes son la clasificación interna de Colmena.
  ['actividad', 406, 822, 158],
  ['cantidad_solicitada', 572, 822, 84],
  ['cantidad_ejecutada', 684, 822, 84],
  // Sobre las rayas del bloque de firma.
  ['razon_social_proveedor', 75, 403, 445],
  ['nombre_profesional', 75, 360, 445],
];

/**
 * Colmena · Registro de asistencia, apaisado.
 *
 * Este formato solo existía en Word y se enviaba como `.docx`. Word recolocaba
 * el texto a su aire —con el dato dentro, la casilla de "Empresa" se le iba a
 * una segunda línea y el formato se descuadraba— así que se convirtió UNA vez a
 * PDF y aquí el valor se dibuja sobre la raya, donde no se mueve.
 */
const CASILLAS_ASISTENCIA_COLMENA = [
  ['ciudad', 66, 518, 162],
  ['facilitador', 380, 518, 126],
  ['fecha', 613, 518, 123],
  ['empresa', 72, 503, 220],
  ['telefono', 372, 503, 135],
  ['hora_inicio', 643, 503, 65],
  ['contrato', 74, 488, 188],
  ['tema', 353, 488, 194],
  ['hora_fin', 629, 488, 89],
  ['numero_orden', 142, 473, 127],
];

/**
 * Colmena · SPM-F 38, el PDF de la propia orden (carta vertical, 612 × 792).
 * Medido sobre la orden 2246190 con `inspeccionar-formato.mjs`. Solo se rellena
 * lo que ese documento deja en blanco y la orden ya sabe: la fecha y la hora de
 * ESTA sesión, las horas ejecutadas en ella y el nombre del profesional. El
 * quinto elemento `'centro'` centra el valor en su celda.
 */
const CASILLAS_PRESTACION_COLMENA_ORIGINAL = [
  ['dia', 124, 686, 28, 'centro'],
  ['mes', 152, 686, 29, 'centro'],
  ['anio', 181, 686, 28, 'centro'],
  ['hora', 210, 686, 53, 'centro'],
  // Columna "Ejecutada (en la sesión programada)", a la altura del "Solicitada".
  ['cantidad_ejecutada', 466, 540, 114, 'centro'],
  ['nombre_profesional', 182, 214, 300],
];

/**
 * Colmena · Registro de Ejecución de Actividades (PSP-F-006 V3), carta
 * apaisada (792 × 612), sobre `colmena/registro-ejecucion.pdf`.
 */
const CASILLAS_REGISTRO_EJECUCION_COLMENA = [
  ['ciudad', 170, 505, 160],
  ['fecha', 458, 505, 70],
  ['hora_inicio', 578, 505, 33],
  ['hora_fin', 651, 505, 33],
  ['empresa', 170, 489, 160],
  ['numero_orden', 502, 489, 180],
  ['razon_social_proveedor', 105, 98, 150],
  ['nombre_profesional', 290, 98, 180],
];

/**
 * Vista previa · casillas del formato que se pueden revisar y corregir desde la
 * pantalla antes de enviar (29-sep, pedido de JD&D). La vista previa llega ya
 * llenada como siempre; aquí se declara qué se deja tocar y con qué rótulo.
 *
 *   campo       nombre del campo en el PDF (AcroForm) o clave de `valores` (plano)
 *   etiqueta    rótulo impreso junto a la casilla (medido con inspeccionar-formato)
 *   multilinea  se edita en un área de texto
 *   fecha       'DD/MM/AA' | 'DD/MM/AAAA': se edita con selector de fecha y se
 *               imprime en ese formato
 *   partes      [dd, mm, aaaa]: una sola fecha repartida en tres casillas
 *
 * Lo que sale de la AGENDA (fecha y horario de la sesión, horas de la franja) no
 * se ofrece: si se editara aquí, el formato diría una cosa y la agenda, el .ics
 * y la cuenta de cobro otra. Eso se cambia reprogramando.
 */
const EDITABLES_AT031 = [
  { campo: '6', etiqueta: 'Empresa' },
  { campo: '7', etiqueta: 'Dirección' },
  { campo: '8', etiqueta: 'NIT - Grupo' },
  { campo: '9', etiqueta: 'Teléfono' },
  { campo: '10', etiqueta: 'Correo electrónico' },
  { campo: '11', etiqueta: 'Ciudad / Departamento de prestación' },
  { campo: '4', etiqueta: 'SIPAB No. Cronograma' },
  { campo: '5', etiqueta: 'Secuencia' },
  { campo: '13', etiqueta: 'Plan' },
  { campo: '16', etiqueta: 'Asesor Gestión del Riesgo' },
  { campo: '17', etiqueta: 'Nombre aliado estratégico' },
  { campo: '18', etiqueta: 'Código aliado estratégico' },
  { campo: '19', etiqueta: 'Participante ARL · nombre' },
  { campo: '20', etiqueta: 'Participante ARL · cargo' },
  { campo: '23', etiqueta: 'Segundo participante ARL · nombre' },
  { campo: '24', etiqueta: 'Segundo participante ARL · cargo' },
  { campo: '21', etiqueta: 'Participante empresa · nombre' },
  { campo: '22', etiqueta: 'Participante empresa · cargo' },
  { campo: '25', etiqueta: 'Segundo participante empresa · nombre' },
  { campo: '26', etiqueta: 'Segundo participante empresa · cargo' },
  { campo: '27', etiqueta: 'Actividad a realizar', multilinea: true },
  { campo: '28', etiqueta: 'Temas desarrollados en la actividad', multilinea: true },
  { campo: '29', etiqueta: 'Decisiones y/o compromisos adquiridos', multilinea: true },
  { campo: '31', etiqueta: 'Responsable(s) de los compromisos', multilinea: true },
  { campo: '32', etiqueta: 'Fecha de los compromisos', fecha: 'DD/MM/AAAA' },
  { campo: '43', etiqueta: 'Próxima reunión · tema' },
  { campo: 'proxima_fecha', etiqueta: 'Próxima reunión · fecha', partes: ['44', '45', '46'] },
  { campo: '47', etiqueta: 'Próxima reunión · hora' },
];
const EDITABLES_AT028 = [
  { campo: 'Text6', etiqueta: 'Empresa' },
  { campo: 'Text7', etiqueta: 'NIT - Grupo' },
  { campo: 'Text1', etiqueta: 'Cronograma' },
  { campo: 'Text2', etiqueta: 'Secuencia' },
  { campo: 'Text8', etiqueta: 'Plan' },
  { campo: 'Text9', etiqueta: 'Tema y/o actividad a realizar' },
  { campo: 'Text13', etiqueta: 'Ciudad / Departamento de prestación' },
  { campo: 'Text15', etiqueta: 'Nombre aliado estratégico' },
  { campo: 'Text16', etiqueta: 'Participante ARL' },
];
const EDITABLES_FICHA_AXA = [
  { campo: 'FECHA 2', etiqueta: 'Fecha de diligenciamiento', fecha: 'DD/MM/AA' },
  { campo: 'nombre', etiqueta: 'Nombre del proveedor' },
  { campo: 'nombre 2', etiqueta: 'Número de orden de servicio (OS)' },
  { campo: 'nombre 3', etiqueta: 'Actividad técnica contratada (OS)' },
  { campo: 'nombre 4', etiqueta: 'Objetivo/alcance de la actividad', multilinea: true },
  { campo: 'nombre 5', etiqueta: 'Unidades contratadas (OS)' },
  { campo: 'nombre 6', etiqueta: 'Nombre de la empresa/cliente (OS)' },
  { campo: 'nombre 7', etiqueta: 'Ciudad y centro de trabajo' },
  { campo: 'nombre 8', etiqueta: 'Población objeto', multilinea: true },
  { campo: 'nombre 11', etiqueta: 'Profesionales ejecutores de la actividad', multilinea: true },
  { campo: 'nombre 12', etiqueta: 'Licencia en SO/SST o tarjeta profesional', multilinea: true },
  { campo: 'nombre 19', etiqueta: 'Eje técnico · actividades ejecutadas vs. tiempo', multilinea: true },
  { campo: 'nombre 20', etiqueta: 'Resultados', multilinea: true },
  { campo: 'nombre 21', etiqueta: 'Análisis de los resultados', multilinea: true },
  { campo: 'nombre 22', etiqueta: 'Recomendaciones', multilinea: true },
  { campo: 'nombre 23', etiqueta: 'Conclusiones', multilinea: true },
];
const EDITABLES_ASISTENCIA_AXA = [
  { campo: 'empresa', etiqueta: 'Empresa' },
  { campo: 'sede', etiqueta: 'Sede' },
  { campo: 'ciudad', etiqueta: 'Ciudad' },
  { campo: 'numero_orden', etiqueta: 'N.º de orden' },
  { campo: 'tema', etiqueta: 'Tema' },
  { campo: 'proveedor', etiqueta: 'Proveedor' },
  { campo: 'expositor', etiqueta: 'Expositor' },
];
const EDITABLES_REGISTRO_EJECUCION_COLMENA = [
  { campo: 'empresa', etiqueta: 'Empresa' },
  { campo: 'ciudad', etiqueta: 'Ciudad' },
  { campo: 'numero_orden', etiqueta: 'Nro(s) de orden(es) de servicio(s)' },
  { campo: 'razon_social_proveedor', etiqueta: 'Razón social del proveedor' },
  { campo: 'nombre_profesional', etiqueta: 'Nombre del profesional ejecutor' },
];
const EDITABLES_SPM38 = [
  { campo: 'nombre_profesional', etiqueta: 'Nombre del profesional' },
];
const EDITABLES_PRESTACION_COLMENA = [
  { campo: 'empresa', etiqueta: 'Nombre de la empresa' },
  { campo: 'nit', etiqueta: 'NIT' },
  { campo: 'ciudad', etiqueta: 'Ciudad de ejecución' },
  { campo: 'numero_orden', etiqueta: 'N.º de orden de servicio' },
  { campo: 'actividad', etiqueta: 'Actividad' },
  { campo: 'cantidad_solicitada', etiqueta: 'Cantidad solicitada' },
  { campo: 'razon_social_proveedor', etiqueta: 'Razón social del proveedor' },
  { campo: 'nombre_profesional', etiqueta: 'Nombre del profesional' },
];
const EDITABLES_EVALUACION_COLMENA = [
  { campo: 'empresa', etiqueta: 'Empresa' },
  { campo: 'nit', etiqueta: 'NIT' },
  { campo: 'ciudad', etiqueta: 'Ciudad' },
  { campo: 'facilitador', etiqueta: 'Facilitador' },
  { campo: 'tema', etiqueta: 'Tema' },
];

/**
 * Vista previa · renglones donde se escriben las observaciones del administrador,
 * `[x, línea base, ancho]`, de arriba abajo. El texto se reparte por palabras y,
 * si no cabe, el último renglón termina en "…" (el límite de 500 caracteres de la
 * API hace que eso sea raro).
 */
const RENGLONES_OBS_SPM38 = [[36, 503, 540], [36, 493, 540], [36, 483, 540], [36, 473, 540]];
const RENGLONES_OBS_REGISTRO_EJECUCION = [[109, 132, 568], [109, 123, 568], [109, 114, 568]];
const RENGLONES_OBS_AT028 = [[185, 99, 400], [32, 83, 555], [32, 67, 555]];

/** Centro de los hexágonos de Modalidad y Tipo de actividad del PSP-F-006 V3. */
const MARCAS_REGISTRO_EJECUCION_COLMENA = {
  modalidad: { VIRTUAL: [197.5, 477], PRESENCIAL: [249.4, 477] },
  // Colmena solo distingue asesoría y capacitación (`TIPOS_ACTIVIDAD_POR_ARL`):
  // la asesoría es la última casilla, "Otra actividad de asesoría y/o
  // acompañamiento al SG-SST". Chequeo preventivo y prueba tamiz no los presta JD&D.
  tipo: { CAPACITACION: [227.6, 461], ASESORIA: [644.8, 461] },
};

/** AXA Colpatria · Formato Registro Listado de Asistencia, apaisado. */
const CASILLAS_ASISTENCIA_COLPATRIA = [
  ['ciudad', 93, 512, 175],
  ['fecha', 341, 512, 75],
  ['duracion', 485, 512, 75],
  ['numero_orden', 678, 512, 85],
  ['empresa', 103, 471, 165],
  ['sede', 318, 471, 98],
  ['proveedor', 558, 471, 205],
  ['tema', 85, 443, 331],
  ['expositor', 558, 443, 120],
];

// ---------------------------------------------------------------------------
// Qué valor va en cada casilla de los formatos planos
// ---------------------------------------------------------------------------

/** AXA Colpatria · Registro Listado de Asistencia. */
function valoresAsistenciaColpatria(orden, profesional, sesion, aliado) {
  return {
    ciudad: orden.ciudad_ejecucion,
    fecha: sesion.fechaCorta,
    duracion: sesion.horas,
    numero_orden: orden.numero_orden,
    empresa: orden.empresa_nombre,
    // "Sede" es dónde se presta el servicio, que es la dirección de la orden.
    sede: orden.direccion,
    proveedor: aliado.nombre,
    tema: temaDeLaOrden(orden),
    expositor: profesional?.nombre,
    // "Pagina" se numera a mano: el profesional añade hojas si se le llenan los
    // 15 renglones de asistentes.
  };
}

/** Colmena · Registro de asistencia (PSP-F-006). */
function valoresAsistenciaColmena(orden, profesional, sesion) {
  return {
    ciudad: orden.ciudad_ejecucion,
    facilitador: profesional?.nombre,
    fecha: sesion.fechaCorta,
    empresa: orden.empresa_nombre,
    telefono: enBlanco(orden.contacto_sst_telefono) || orden.contacto_empresa_telefono,
    hora_inicio: sesion.horaInicio,
    hora_fin: sesion.horaFin,
    // `contrato` es el número de contrato de Colmena con la empresa y no viaja
    // en la orden: se deja en blanco.
    contrato: '',
    tema: temaDeLaOrden(orden),
    numero_orden: orden.numero_orden,
  };
}

/** Colmena · Registro de Ejecución de Actividades (PSP-F-006 V3). */
function valoresRegistroEjecucionColmena(orden, profesional, sesion, aliado) {
  return {
    ciudad: orden.ciudad_ejecucion,
    fecha: sesion.fechaCorta,
    hora_inicio: sesion.horaInicio,
    hora_fin: sesion.horaFin,
    empresa: orden.empresa_nombre,
    numero_orden: orden.numero_orden,
    razon_social_proveedor: aliado.nombre,
    nombre_profesional: profesional?.nombre,
  };
}

/** Qué hexágonos del PSP-F-006 V3 se marcan: la modalidad y el tipo de actividad. */
function marcasRegistroEjecucionColmena(orden) {
  const { modalidad, tipo } = MARCAS_REGISTRO_EJECUCION_COLMENA;
  return [
    modalidad[normalizarModalidadEjecucion(orden.modalidad_ejecucion)],
    tipo[tipoActividadDeOrden(orden).tipo],
  ].filter(Boolean);
}

/**
 * Colmena · SPM-F 38 original. La fecha y la hora son las de ESTA sesión y
 * "Ejecutada" sus horas (T0-12: una orden de 12 h en dos días de 6 lleva 6 en
 * cada copia); "Solicitada" ya la trae impresa el documento de Colmena.
 */
function valoresPrestacionColmenaOriginal(orden, profesional, sesion) {
  return {
    dia: sesion.dia,
    mes: sesion.mes,
    anio: sesion.anio,
    hora: [sesion.horaInicio, sesion.horaFin].filter(Boolean).join(' - '),
    cantidad_ejecutada: sesion.horas,
    nombre_profesional: profesional?.nombre,
  };
}

/** Colmena · Evaluación Sesión de Capacitación (PSP-F-010). */
function valoresEvaluacionColmena(orden, profesional, sesion) {
  return {
    ciudad: orden.ciudad_ejecucion,
    dia: sesion.dia,
    mes: sesion.mes,
    anio: sesion.anio,
    empresa: orden.empresa_nombre,
    nit: orden.nit_nic,
    facilitador: profesional?.nombre,
    tema: temaDeLaOrden(orden),
  };
}

/** Colmena · Informe de Prestación de Servicios (PSP-F-007). */
function valoresPrestacionColmena(orden, profesional, sesion, aliado) {
  const horario = [sesion.horaInicio, sesion.horaFin].filter(Boolean).join(' a ');
  return {
    hora: horario,
    numero_orden: orden.numero_orden,
    empresa: orden.empresa_nombre,
    nit: orden.nit_nic,
    ciudad: orden.ciudad_ejecucion,
    actividad: temaDeLaOrden(orden),
    cantidad_solicitada: horasTexto(orden.horas_asignadas),
    // T0-12 · Las horas de ESTA sesión, no las de la orden: es la misma regla
    // que ya usan el AT-028 de Bolívar y el registro de AXA (`sesion.horas`).
    cantidad_ejecutada: sesion.horas,
    razon_social_proveedor: aliado.nombre,
    nombre_profesional: profesional?.nombre,
  };
}

/**
 * AXA Colpatria · Ficha de Gestión técnica.
 *
 * Los campos se llaman "nombre", "nombre 2"… "nombre 23" porque quien diseñó el
 * formulario los numeró por orden de creación, así que la correspondencia con
 * el rótulo impreso va anotada campo a campo. **Están repartidos en tres
 * páginas** y el nombre no lo dice: comprobar con
 * `scripts/inspeccionar-formato.mjs`, que imprime la página de cada widget.
 *
 * Es un formato de ORDEN, no de sesión: lleva fecha de inicio y de fin de la
 * actividad completa, no el horario de una franja.
 */
function camposFichaAxa(orden, profesional, tramo, aliado) {
  return {
    // --- Página 1 ---
    // "FECHA 2" (fecha de diligenciamiento) se deja en blanco: es cuándo el
    // profesional redacta la ficha, que es después de la visita.
    'nombre': aliado.nombre,                    // Nombre del proveedor
    'nombre 2': orden.numero_orden,             // Número de Orden de Servicio (OS)
    'nombre 3': temaDeLaOrden(orden),           // Actividad técnica contratada (OS)
    // 'nombre 4' (Objetivo/alcance de la actividad) lo redacta el profesional.
    'nombre 5': horasTexto(orden.horas_asignadas),  // Unidades contratadas (OS)
    'nombre 6': orden.empresa_nombre,           // Nombre de la empresa/cliente (OS)
    'nombre 7': [enBlanco(orden.ciudad_ejecucion), enBlanco(orden.direccion)]
      .filter(Boolean).join(' · '),             // Ciudad y centro de trabajo
    // 'nombre 8' (Población objeto) solo se sabe en la sesión.
    // --- Página 2 ---
    'nombre 9': tramo.fechaInicio,              // Fecha de inicio de actividad
    'nombre 10': tramo.fechaFin,                // Fecha de fin de actividad
    'nombre 11': profesional?.nombre,           // Profesionales ejecutores de la actividad
    // 'nombre 12' (Licencia en SO/SST o tarjeta profesional): la plataforma no
    // guarda el número de licencia del profesional; lo escribe él.
    // --- Página 3 --- 'nombre 19'..'nombre 23' son el informe de la visita
    // (eje técnico, resultados, recomendaciones, conclusiones): posteriores.
  };
}

/**
 * Escribe los valores sobre un formato sin formulario.
 *
 * La letra se encoge hasta caber en su casilla en vez de dejar que el texto
 * invada la columna vecina o se salga de la raya; solo si ni al mínimo entra se
 * recorta con puntos suspensivos, que al menos se ve que falta algo.
 */
/**
 * T0-11 · Tamaño y margen de la "Fecha de impresión" que llevan los tres PDF de
 * Colmena. 7 pt porque es una anotación de trazabilidad, no un dato del
 * formato: tiene que leerse sin competir con lo que sí hay que diligenciar. El
 * margen se midió con `inspeccionar-formato.mjs` contra los tres PDF: el más
 * bajo de los tres tiene su último texto en y≈52 (el código "PSP-F-… V…" del
 * pie), así que y=20 queda libre en los tres sin tapar nada.
 */
const TAMANO_FECHA_IMPRESION = 7;
const MARGEN_FECHA_IMPRESION = 24;

/**
 * Escribe los valores sobre un formato sin formulario.
 *
 * La letra se encoge hasta caber en su casilla en vez de dejar que el texto
 * invada la columna vecina o se salga de la raya; solo si ni al mínimo entra se
 * recorta con puntos suspensivos, que al menos se ve que falta algo.
 *
 * `fechaImpresion: true` añade, en el margen inferior derecho, "Fecha de
 * impresión: DD/MM/AAAA" con la fecha de HOY (T0-11): es la fecha en que se
 * generó el documento, no la de la visita, que sigue en blanco en el PDF (la
 * pone el asesor a mano, tal como estaba). Solo lo piden los tres formatos de
 * Colmena; AXA, que también es `modo: 'plano'`, no lo lleva.
 */
async function rellenarPdfPlano(plantilla, casillas, valores, { fechaImpresion = false, marcas = [], parrafo = null } = {}) {
  // `plantilla` es la ruta del formato en blanco o, para el SPM-F 38 de Colmena,
  // el PDF original de la orden ya leído del almacenamiento.
  const doc = await PDFDocument.load(Buffer.isBuffer(plantilla) ? plantilla : await fs.readFile(plantilla));
  const pagina = doc.getPage(0);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const negro = rgb(0, 0, 0);

  for (const [clave, x, y, ancho, alineacion] of casillas) {
    let texto = enBlanco(valores[clave]);
    if (!texto) continue;
    let tamano = TAMANO_BASE;
    while (tamano > TAMANO_MINIMO && font.widthOfTextAtSize(texto, tamano) > ancho) tamano -= 0.5;
    while (texto.length > 1 && font.widthOfTextAtSize(texto, tamano) > ancho) {
      texto = `${texto.slice(0, -2)}…`;
    }
    const xFinal = alineacion === 'centro' ? x + (ancho - font.widthOfTextAtSize(texto, tamano)) / 2 : x;
    pagina.drawText(texto, { x: xFinal, y, size: tamano, font, color: negro });
  }

  if (parrafo) escribirRenglones(pagina, font, parrafo.texto, parrafo.renglones);

  // Casillas de opción dibujadas (los hexágonos del PSP-F-006 V3): una "X"
  // centrada en el punto medido. No son campos de formulario, así que se dibujan.
  if (marcas.length) {
    const negrita = await doc.embedFont(StandardFonts.HelveticaBold);
    for (const [cx, cy] of marcas) {
      pagina.drawText('X', { x: cx - negrita.widthOfTextAtSize('X', 8) / 2, y: cy - 2.8, size: 8, font: negrita, color: negro });
    }
  }

  if (fechaImpresion) {
    const hoy = new Date();
    const dd = String(hoy.getDate()).padStart(2, '0');
    const mm = String(hoy.getMonth() + 1).padStart(2, '0');
    const texto = `Fecha de impresión: ${dd}/${mm}/${hoy.getFullYear()}`;
    const ancho = font.widthOfTextAtSize(texto, TAMANO_FECHA_IMPRESION);
    pagina.drawText(texto, {
      x: pagina.getWidth() - MARGEN_FECHA_IMPRESION - ancho,
      y: MARGEN_FECHA_IMPRESION - 4,
      size: TAMANO_FECHA_IMPRESION,
      font,
      color: negro,
    });
  }

  return Buffer.from(await doc.save());
}

// ---------------------------------------------------------------------------
// Punto de entrada
// ---------------------------------------------------------------------------

/**
 * Los datos de la ORDEN entera, para los formatos de alcance 'orden': un
 * informe o una ficha técnica cubre toda la actividad, así que lo que necesita
 * es la fecha en que empieza y la fecha en que termina, no el horario de una
 * franja suelta.
 *
 * T0-13 · El AT-031 de Bolívar (único por orden desde esta tanda) necesita
 * además el desglose día/mes/año y el horario de la PRIMERA y la ÚLTIMA sesión
 * —no solo la fecha—, y el detalle sesión a sesión cuando la visita cruza más
 * de un día. Se calcula aquí y no en `sesionDe()` porque es del TRAMO completo,
 * no de una franja suelta; los demás formatos de alcance 'orden' (AXA) siguen
 * usando solo `fechaInicio`/`fechaFin`, que no cambiaron.
 */
function tramoDe(franjas) {
  // Por fecha+hora real, no por el orden en que se cargaron las franjas: "la
  // primera sesión" y "la última" son las del calendario, no las de la lista.
  const ordenadas = franjas
    .filter((f) => enBlanco(f?.fecha))
    .slice()
    .sort((a, b) => `${a.fecha}T${enBlanco(a.hora_inicio) || '00:00'}`
      .localeCompare(`${b.fecha}T${enBlanco(b.hora_inicio) || '00:00'}`));
  const corta = (iso) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
    return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
  };
  const primera = ordenadas[0] ?? null;
  const ultima = ordenadas[ordenadas.length - 1] ?? null;
  const isoPrimera = primera ? /^(\d{4})-(\d{2})-(\d{2})/.exec(primera.fecha) : null;

  // Sin cero a la izquierda en la hora ("8:00", no "08:00"): así se ve el
  // ejemplo de la ficha, y ahorra espacio en una casilla que ya lleva varias
  // sesiones seguidas. Las franjas llegan de Postgres como `time::text`
  // ("08:00:00"): sin cortar los segundos salía "8:00:00-10:00:00".
  const horaCorta = (hhmm) => String(hhmm ?? '').slice(0, 5).replace(/^0(\d:)/, '$1');
  const dias = [...new Set(ordenadas.map((f) => f.fecha))];
  const observaciones = dias.length > 1
    ? `Sesiones: ${ordenadas
        .map((f) => `${corta(f.fecha).slice(0, 5)} ${horaCorta(f.hora_inicio)}-${horaCorta(f.hora_fin)}`)
        .join('; ')}`
    : '';

  return {
    fechaInicio: corta(primera?.fecha),
    fechaFin: corta(ultima?.fecha),
    dia: isoPrimera ? isoPrimera[3] : '',
    mes: isoPrimera ? isoPrimera[2] : '',
    anio: isoPrimera ? isoPrimera[1] : '',
    horaInicio: primera?.hora_inicio ? horaAmPm(primera.hora_inicio) : '',
    horaFin: ultima?.hora_fin ? horaAmPm(ultima.hora_fin) : '',
    observaciones,
  };
}

/** Un formato ya generado, listo para adjuntarse al correo. */
function salida(def, { buffer, admiteObservaciones, editables = [] }, sufijo) {
  // El sufijo solo aparece cuando de verdad hay varias sesiones: con una visita
  // normal el adjunto se llama "asistencia.pdf" a secas. Se inserta ANTES de la
  // extensión, no al final, o el archivo dejaría de abrirse ("asistencia.pdf-2").
  const punto = def.nombre.lastIndexOf('.');
  const filename = sufijo && punto > 0
    ? `${def.nombre.slice(0, punto)}${sufijo}${def.nombre.slice(punto)}`
    : def.nombre;
  // `etiqueta` y `prediligenciado` viajan hasta el correo: es lo que permite
  // enumerar en el cuerpo los documentos que ESTA orden lleva de verdad, en vez
  // de hablar en abstracto de "los formatos de la ARL".
  return {
    tipo: def.tipo, filename, buffer,
    etiqueta: def.etiqueta || def.nombre,
    prediligenciado: def.modo !== 'adjunto',
    clave: def.clave,
    admiteObservaciones,
    editables,
  };
}

/**
 * Genera los formatos que le corresponden a esta orden.
 *
 * CUÁLES lo deciden las reglas de `entrega-arl.service.js` (ARL + tipo de
 * actividad + horas + modalidad); aquí solo se rellenan. Los de alcance
 * 'sesion' salen uno por franja; los de alcance 'orden', una sola vez.
 *
 * Devuelve `[{ tipo, filename, buffer }]`, vacío si la ARL no tiene formatos.
 */
export async function generarFormatosArl({
  orden, profesional, franjas = [], aliado, original = null, observaciones = {}, campos = {},
}) {
  const entrega = entregaDeLaOrden(orden);
  if (!entrega.formatos.length) return [];

  const identidad = { ...ALIADO_POR_DEFECTO, ...(aliado || {}) };
  // La clave (at031, asistenciaColmena…) viaja con cada definición: es con la
  // que se guardan las observaciones de la vista previa y con la que la pantalla
  // las vuelve a pedir.
  const definiciones = entrega.formatos
    .filter((clave) => FORMATOS[clave])
    .map((clave) => ({ ...FORMATOS[clave], clave }));
  const obsDe = (def) => enBlanco(observaciones?.[def.clave]);
  const extra = (def) => ({ observacion: obsDe(def), campos: campos?.[def.clave] || {} });

  // Sin franjas se emite igualmente un juego, con las casillas de fecha y
  // horario en blanco: el profesional ya tiene el formato correcto en la mano.
  const sesiones = (franjas.length ? franjas : [null]).slice(0, MAXIMO_JUEGOS);
  if (franjas.length > MAXIMO_JUEGOS) {
    console.warn(
      `[formatos] ${orden.codigo}: ${franjas.length} franjas; se adjuntan las ${MAXIMO_JUEGOS} primeras`
    );
  }
  const tramo = tramoDe(franjas);
  const generados = [];

  // 1) Los de alcance 'orden': uno solo, con el tramo completo de la visita.
  for (const def of definiciones.filter((d) => d.alcance === 'orden')) {
    generados.push(salida(def, await construir(def, orden, profesional, tramo, identidad, original, extra(def)), ''));
  }

  // 2) Los de alcance 'sesion': uno por franja.
  for (const [i, franja] of sesiones.entries()) {
    const sesion = sesionDe(orden, franja);
    const sufijo = sesiones.length > 1 ? `-${i + 1}` : '';
    for (const def of definiciones.filter((d) => d.alcance === 'sesion')) {
      generados.push(salida(def, await construir(def, orden, profesional, sesion, identidad, original, extra(def)), sufijo));
    }
  }
  return generados;
}

/** Rellena UN formato según su modo. */
async function construir(def, orden, profesional, sesion, aliado, original = null, { observacion = '', campos: delUsuario = {} } = {}) {
  // Devuelve `{ buffer, admiteObservaciones }`. Lo segundo le dice a la vista
  // previa si ESTE archivo tiene dónde escribir las observaciones (el informe de
  // Colmena sí sobre su original, no en la plantilla de respaldo), para no
  // ofrecer un cuadro de texto que después no se imprime.
  if (def.sobreOriginal && await esOriginalUtilizable(original)) {
    const obs = def.sobreOriginal.observaciones;
    const valores = def.sobreOriginal.valores(orden, profesional, sesion, aliado);
    const editables = aplicarEditables(def.sobreOriginal.editables?.() ?? [], valores, delUsuario);
    return {
      buffer: await rellenarPdfPlano(
        original, def.sobreOriginal.casillas(), valores,
        { parrafo: obs && observacion ? { renglones: obs.renglones(), texto: observacion } : null },
      ),
      admiteObservaciones: !!obs,
      editables,
    };
  }
  const ruta = path.join(RAIZ, ...def.archivo.split('/'));
  if (def.modo === 'adjunto') {
    // Se manda tal cual: es una plantilla que el profesional redacta en Word o
    // en Excel, no un formato con casillas que se puedan prediligenciar.
    return { buffer: await fs.readFile(ruta), admiteObservaciones: false, editables: [] };
  }
  const obs = def.observaciones;
  const parrafo = obs?.renglones && observacion ? { renglones: obs.renglones(), texto: observacion } : null;
  if (def.modo === 'acroform') {
    const campos = def.campos(orden, profesional, sesion, aliado);
    const editables = aplicarEditables(def.editables?.() ?? [], campos, delUsuario);
    // En un campo del formulario, lo que escribió el administrador va PRIMERO y
    // lo que ya ponía el sistema (el detalle de sesiones del AT-031) debajo.
    if (obs?.campo && observacion) {
      campos[obs.campo] = [observacion, enBlanco(campos[obs.campo])].filter(Boolean).join('\n');
    }
    return {
      buffer: await rellenarAcroForm(ruta, campos, def.marcas ? def.marcas(orden) : [], { parrafo }),
      admiteObservaciones: !!obs,
      editables,
    };
  }
  const valores = def.valores(orden, profesional, sesion, aliado);
  const editables = aplicarEditables(def.editables?.() ?? [], valores, delUsuario);
  return {
    buffer: await rellenarPdfPlano(
      ruta, def.casillas(), valores,
      { fechaImpresion: !!def.fechaImpresion, marcas: def.marcas ? def.marcas(orden) : [], parrafo },
    ),
    admiteObservaciones: !!obs,
    editables,
  };
}

/** '30/09/26' o '30/09/2026' → '2026-09-30' (vacío si no es una fecha así). */
function isoDeImpreso(texto) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(enBlanco(texto));
  if (!m) return '';
  const anio = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${anio}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

/** '2026-09-30' → '30/09/26' | '30/09/2026' según lo que pide la casilla. */
function impresoDeIso(iso, formato) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return formato === 'DD/MM/AA' ? `${m[3]}/${m[2]}/${m[1].slice(2)}` : `${m[3]}/${m[2]}/${m[1]}`;
}

/**
 * Vista previa · aplica sobre `valores` (lo que el sistema llenó, campo → texto)
 * lo que el administrador corrigió en la pantalla, y devuelve la lista de casillas
 * editables con su valor para mostrarlas.
 *
 * Solo manda lo del usuario si trae algo: dejar una casilla vacía en la pantalla
 * vuelve al valor del sistema en vez de borrar un dato de la orden. Las fechas
 * viajan en ISO (lo que da el selector) y se imprimen en el formato de la casilla.
 */
function aplicarEditables(lista, valores, delUsuario = {}) {
  return lista.map((e) => {
    const sistema = e.partes
      ? (e.partes.every((p) => enBlanco(valores[p]))
        ? `${enBlanco(valores[e.partes[2]])}-${enBlanco(valores[e.partes[1]])}-${enBlanco(valores[e.partes[0]])}`
        : '')
      : e.fecha ? isoDeImpreso(valores[e.campo]) : enBlanco(valores[e.campo]);
    const bruto = delUsuario?.[e.campo];
    let usuario = typeof bruto === 'string'
      ? (e.multilinea ? bruto.trim() : bruto.replace(/\s+/g, ' ').trim())
      : '';
    // Una fecha guardada como texto ("12/10/2026", de antes del selector) se
    // pasa a ISO: si no, el selector la mostraría en blanco.
    if ((e.fecha || e.partes) && usuario && !/^\d{4}-\d{2}-\d{2}$/.test(usuario)) {
      usuario = isoDeImpreso(usuario) || usuario;
    }
    if (usuario) {
      const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(usuario);
      if (e.partes) {
        if (iso) [valores[e.partes[0]], valores[e.partes[1]], valores[e.partes[2]]] = [iso[3], iso[2], iso[1]];
      } else {
        valores[e.campo] = e.fecha ? impresoDeIso(usuario, e.fecha) : usuario;
      }
    }
    return {
      campo: e.campo,
      etiqueta: e.etiqueta,
      multilinea: !!e.multilinea,
      tipo: e.fecha || e.partes ? 'fecha' : 'texto',
      valor: usuario || sistema,
      sistema,
    };
  });
}

/**
 * Vista previa · escribe un texto libre repartido por palabras sobre renglones
 * `[x, línea base, ancho]`. Los saltos de línea del usuario se aplanan: en un
 * formato impreso manda el espacio de las rayas, no el formato del texto. Si no
 * cabe, el último renglón acaba en "…", que al menos deja ver que falta algo.
 */
function escribirRenglones(pagina, font, texto, renglones, tamano = TAMANO_BASE) {
  const palabras = enBlanco(texto).replace(/\s+/g, ' ').split(' ').filter(Boolean);
  let i = 0;
  renglones.forEach(([x, y, ancho], n) => {
    let linea = '';
    while (i < palabras.length) {
      const prueba = linea ? `${linea} ${palabras[i]}` : palabras[i];
      if (linea && font.widthOfTextAtSize(prueba, tamano) > ancho) break;
      linea = prueba;
      i += 1;
    }
    if (n === renglones.length - 1 && i < palabras.length) {
      while (linea.length > 1 && font.widthOfTextAtSize(`${linea}…`, tamano) > ancho) linea = linea.slice(0, -1);
      linea = `${linea}…`;
    }
    if (linea) pagina.drawText(linea, { x, y, size: tamano, font, color: rgb(0, 0, 0) });
  });
}

/**
 * ¿El archivo con el que se importó la orden sirve de informe de prestación?
 * Las coordenadas de `CASILLAS_PRESTACION_COLMENA_ORIGINAL` son las del SPM-F 38:
 * una sola página carta vertical. Cualquier otra cosa (un PDF con varias órdenes,
 * un escaneo, otro tamaño) escribiría los datos fuera de sitio, así que en ese
 * caso se vuelve a la plantilla PSP-F-007 en vez de arriesgarse.
 */
async function esOriginalUtilizable(original) {
  if (!Buffer.isBuffer(original)) return false;
  try {
    const doc = await PDFDocument.load(original, { ignoreEncryption: true });
    if (doc.getPageCount() !== 1) return false;
    const { width, height } = doc.getPage(0).getSize();
    return Math.abs(width - 612) < 2 && Math.abs(height - 792) < 2;
  } catch {
    return false;
  }
}
