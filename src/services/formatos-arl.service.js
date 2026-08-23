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
import { indiceModalidad, indiceTipoActividadBolivar } from '../utils/bolivar.js';
import { entregaDeLaOrden } from './entrega-arl.service.js';

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
  at031: {
    archivo: 'bolivar/seguimiento.pdf', modo: 'acroform', alcance: 'sesion',
    tipo: 'seguimiento', nombre: 'seguimiento.pdf',
    campos: camposSeguimientoBolivar, marcas: marcasSeguimientoBolivar,
  },
  at028: {
    archivo: 'bolivar/asistencia.pdf', modo: 'acroform', alcance: 'sesion',
    tipo: 'asistencia', nombre: 'asistencia.pdf',
    campos: camposAsistenciaBolivar,
  },

  // --- AXA Colpatria ---
  asistentesAxa: {
    archivo: 'colpatria/asistencia.pdf', modo: 'plano', alcance: 'sesion',
    tipo: 'asistencia', nombre: 'asistencia.pdf',
    casillas: () => CASILLAS_ASISTENCIA_COLPATRIA, valores: valoresAsistenciaColpatria,
  },
  fichaAxa: {
    archivo: 'colpatria/ficha-gestion.pdf', modo: 'acroform', alcance: 'orden',
    tipo: 'ficha_gestion', nombre: 'ficha-de-gestion.pdf',
    campos: camposFichaAxa,
  },
  informeAxa: {
    archivo: 'colpatria/informe-tecnico.docx', modo: 'adjunto', alcance: 'orden',
    tipo: 'informe_tecnico', nombre: 'informe-tecnico (plantilla).docx',
  },

  // --- Colmena ---
  prestacionColmena: {
    archivo: 'colmena/prestacion-servicios.pdf', modo: 'plano', alcance: 'sesion',
    tipo: 'prestacion_servicios', nombre: 'prestacion-de-servicios.pdf',
    casillas: () => CASILLAS_PRESTACION_COLMENA, valores: valoresPrestacionColmena,
  },
  asistenciaColmena: {
    archivo: 'colmena/asistencia.pdf', modo: 'plano', alcance: 'sesion',
    tipo: 'asistencia', nombre: 'asistencia.pdf',
    casillas: () => CASILLAS_ASISTENCIA_COLMENA, valores: valoresAsistenciaColmena,
  },
  evaluacionColmena: {
    archivo: 'colmena/evaluacion.pdf', modo: 'plano', alcance: 'sesion',
    tipo: 'evaluacion', nombre: 'evaluacion.pdf',
    casillas: () => CASILLAS_EVALUACION_COLMENA, valores: valoresEvaluacionColmena,
  },
  registroEjecucionColmena: {
    archivo: 'colmena/registro-ejecucion.xls', modo: 'adjunto', alcance: 'orden',
    tipo: 'registro_ejecucion', nombre: 'registro-de-ejecucion.xls',
  },
  plantillaColmena: {
    archivo: 'colmena/plantilla-presentaciones.pptx', modo: 'adjunto', alcance: 'orden',
    tipo: 'plantilla_presentacion', nombre: 'plantilla-de-presentaciones.pptx',
  },
  informeColmenaA: {
    archivo: 'colmena/informe-tipo-a.docx', modo: 'adjunto', alcance: 'orden',
    tipo: 'informe_tipo_a', nombre: 'informe tipo A (plantilla).docx',
  },
  informeColmenaB: {
    archivo: 'colmena/informe-tipo-b.docx', modo: 'adjunto', alcance: 'orden',
    tipo: 'informe_tipo_b', nombre: 'informe tipo B (plantilla).docx',
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
async function rellenarAcroForm(rutaPlantilla, valores, marcas = []) {
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
    Text9: temaDeLaOrden(orden),             // Tema y/o Actividad a realizar
    Text11: sesion.horaInicio,               // Horario · De
    Text12: sesion.horaFin,                  // Horario · Hasta
    Text13: orden.ciudad_ejecucion,          // Ciudad / Departamento de prestación
    Text14: sesion.horas,                    // No. Total de Horas
    Text15: aliado.nombre,                   // Nombre Aliado Estratégico
    Text16: profesional?.nombre,             // Participante ARL
  };
}

/** Seguimiento de Reuniones y Actividades · Forma AT-031. */
function camposSeguimientoBolivar(orden, profesional, sesion, aliado) {
  const contacto = contactoEmpresa(orden);
  return {
    Text1: sesion.dia,                       // Fecha de prestación · DD
    Text2: sesion.mes,                       // MM
    3: sesion.anio,                          // AAAA
    4: orden.codigo_cronograma,              // SIPAB No. Cronograma
    5: orden.secuencia,                      // Secuencia
    6: orden.empresa_nombre,                 // Empresa
    7: orden.direccion,                      // Dirección
    8: orden.nit_nic,                        // NIT - Grupo
    9: enBlanco(orden.contacto_sst_telefono) || orden.contacto_empresa_telefono,
    10: orden.contacto_sst_correo,           // Correo Electrónico
    11: orden.ciudad_ejecucion,              // Ciudad / Departamento de prestación
    13: aliado.plan_bolivar,                 // PLAN
    // 16 (Asesor Gestión del Riesgo) lo pone Bolívar, no nosotros.
    14: sesion.horaInicio,                   // Hora Inicio
    15: sesion.horaFin,                      // Hora Salida
    17: aliado.nombre,                       // Nombre Aliado Estratégico
    18: aliado.codigo_bolivar,               // Código Aliado Estratégico
    19: profesional?.nombre,                 // Participantes ARL · Nombres
    20: profesional?.especialidad || 'ASESOR SST',   // Participantes ARL · Cargo
    21: contacto.nombre,                     // Participantes Empresa · Nombres
    22: contacto.cargo,                      // Participantes Empresa · Cargo
    27: temaDeLaOrden(orden),                // Actividad a realizar
    // 28 (Temas desarrollados), 29/31/32 (compromisos), 42 (observaciones) y
    // 43-47 (próxima reunión) son de la sesión: los diligencia el profesional.
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
  // Fila de datos de "Descripción del servicio solicitado". Solo se rellenan
  // las dos columnas que la orden conoce: la actividad y las unidades
  // contratadas. Línea de intervención, programa y componentes son la
  // clasificación interna de Colmena, y "ejecutada" solo se sabe al terminar.
  ['actividad', 406, 822, 158],
  ['cantidad_solicitada', 572, 822, 84],
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
async function rellenarPdfPlano(rutaPlantilla, casillas, valores) {
  const doc = await PDFDocument.load(await fs.readFile(rutaPlantilla));
  const pagina = doc.getPage(0);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const negro = rgb(0, 0, 0);

  for (const [clave, x, y, ancho] of casillas) {
    let texto = enBlanco(valores[clave]);
    if (!texto) continue;
    let tamano = TAMANO_BASE;
    while (tamano > TAMANO_MINIMO && font.widthOfTextAtSize(texto, tamano) > ancho) tamano -= 0.5;
    while (texto.length > 1 && font.widthOfTextAtSize(texto, tamano) > ancho) {
      texto = `${texto.slice(0, -2)}…`;
    }
    pagina.drawText(texto, { x, y, size: tamano, font, color: negro });
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
 */
function tramoDe(franjas) {
  const fechas = franjas.map((f) => enBlanco(f?.fecha)).filter(Boolean).sort();
  const corta = (iso) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
    return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
  };
  return { fechaInicio: corta(fechas[0]), fechaFin: corta(fechas[fechas.length - 1]) };
}

/** Un formato ya generado, listo para adjuntarse al correo. */
function salida(def, buffer, sufijo) {
  // El sufijo solo aparece cuando de verdad hay varias sesiones: con una visita
  // normal el adjunto se llama "asistencia.pdf" a secas. Se inserta ANTES de la
  // extensión, no al final, o el archivo dejaría de abrirse ("asistencia.pdf-2").
  const punto = def.nombre.lastIndexOf('.');
  const filename = sufijo && punto > 0
    ? `${def.nombre.slice(0, punto)}${sufijo}${def.nombre.slice(punto)}`
    : def.nombre;
  return { tipo: def.tipo, filename, buffer };
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
export async function generarFormatosArl({ orden, profesional, franjas = [], aliado }) {
  const entrega = entregaDeLaOrden(orden);
  if (!entrega.formatos.length) return [];

  const identidad = { ...ALIADO_POR_DEFECTO, ...(aliado || {}) };
  const definiciones = entrega.formatos.map((clave) => FORMATOS[clave]).filter(Boolean);

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
    generados.push(salida(def, await construir(def, orden, profesional, tramo, identidad), ''));
  }

  // 2) Los de alcance 'sesion': uno por franja.
  for (const [i, franja] of sesiones.entries()) {
    const sesion = sesionDe(orden, franja);
    const sufijo = sesiones.length > 1 ? `-${i + 1}` : '';
    for (const def of definiciones.filter((d) => d.alcance === 'sesion')) {
      generados.push(salida(def, await construir(def, orden, profesional, sesion, identidad), sufijo));
    }
  }
  return generados;
}

/** Rellena UN formato según su modo. */
async function construir(def, orden, profesional, sesion, aliado) {
  const ruta = path.join(RAIZ, ...def.archivo.split('/'));
  if (def.modo === 'adjunto') {
    // Se manda tal cual: es una plantilla que el profesional redacta en Word o
    // en Excel, no un formato con casillas que se puedan prediligenciar.
    return fs.readFile(ruta);
  }
  if (def.modo === 'acroform') {
    return rellenarAcroForm(
      ruta,
      def.campos(orden, profesional, sesion, aliado),
      def.marcas ? def.marcas(orden) : [],
    );
  }
  return rellenarPdfPlano(ruta, def.casillas(), def.valores(orden, profesional, sesion, aliado));
}
