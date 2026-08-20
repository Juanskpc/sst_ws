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
 * ARLs cuyos formatos reales ya están cargados en `assets/formatos-arl/`.
 *
 * La clave es el nombre de la ARL en la BD pasado por `slugArl()`. 'AXA
 * Colpatria' cae en 'axa colpatria', y por eso se acepta también ese alias:
 * la carpeta se llama `colpatria` porque así lo llama todo el mundo aquí.
 */
const CATALOGO = {
  bolivar: ['asistencia', 'seguimiento'],
  colmena: ['asistencia', 'evaluacion'],
  colpatria: ['asistencia'],
};

/** 'AXA Colpatria' → 'colpatria'. El resto se queda como está. */
function carpetaArl(nombre) {
  const slug = slugArl(nombre);
  return slug.includes('colpatria') ? 'colpatria' : slug;
}

/** ¿Esta ARL trae formato propio, o hay que caer en las plantillas genéricas? */
export function tieneFormatosPropios(arlNombre) {
  return Boolean(CATALOGO[carpetaArl(arlNombre)]);
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
 * Escribe los campos indicados y los deja de solo lectura. Los nombres de campo
 * del formato de Bolívar son los que puso quien lo diseñó ("Text2", "13"), así
 * que la correspondencia con su etiqueta impresa se documenta en cada mapa.
 */
async function rellenarAcroForm(rutaPlantilla, valores) {
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
    // Los grupos de opción (Tipo de Actividad, Tipo de Servicio, ¿Próxima
    // reunión?) van sin marcar a propósito — ver nota en el README de assets.
  };
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
 * Genera los formatos de la ARL de la orden, uno por franja de visita.
 * Devuelve `[{ tipo, filename, buffer }]`, vacío si la ARL no tiene formatos.
 */
export async function generarFormatosArl({ orden, profesional, franjas = [], aliado }) {
  const arl = carpetaArl(orden.arl_nombre);
  if (!CATALOGO[arl]) return [];

  const identidad = { ...ALIADO_POR_DEFECTO, ...(aliado || {}) };
  // Sin franjas se emite igualmente un juego, con las casillas de fecha y
  // horario en blanco: el profesional ya tiene el formato correcto en la mano.
  const sesiones = (franjas.length ? franjas : [null]).slice(0, MAXIMO_JUEGOS);
  if (franjas.length > MAXIMO_JUEGOS) {
    console.warn(
      `[formatos] ${orden.codigo}: ${franjas.length} franjas; se adjuntan las ${MAXIMO_JUEGOS} primeras`
    );
  }

  const salida = [];
  for (const [i, franja] of sesiones.entries()) {
    const sesion = sesionDe(orden, franja);
    // El sufijo solo aparece cuando de verdad hay varias sesiones: con una
    // visita normal el adjunto se llama "asistencia.pdf" a secas.
    const sufijo = sesiones.length > 1 ? `-${i + 1}` : '';

    if (arl === 'bolivar') {
      salida.push({
        tipo: 'asistencia',
        filename: `asistencia${sufijo}.pdf`,
        buffer: await rellenarAcroForm(
          path.join(RAIZ, 'bolivar', 'asistencia.pdf'),
          camposAsistenciaBolivar(orden, profesional, sesion, identidad),
        ),
      });
      salida.push({
        tipo: 'seguimiento',
        filename: `seguimiento${sufijo}.pdf`,
        buffer: await rellenarAcroForm(
          path.join(RAIZ, 'bolivar', 'seguimiento.pdf'),
          camposSeguimientoBolivar(orden, profesional, sesion, identidad),
        ),
      });
    }

    if (arl === 'colmena') {
      salida.push({
        tipo: 'asistencia',
        filename: `asistencia${sufijo}.pdf`,
        buffer: await rellenarPdfPlano(
          path.join(RAIZ, 'colmena', 'asistencia.pdf'), CASILLAS_ASISTENCIA_COLMENA, {
            ciudad: orden.ciudad_ejecucion,
            facilitador: profesional?.nombre,
            fecha: sesion.fechaCorta,
            empresa: orden.empresa_nombre,
            telefono: enBlanco(orden.contacto_sst_telefono) || orden.contacto_empresa_telefono,
            hora_inicio: sesion.horaInicio,
            hora_fin: sesion.horaFin,
            // `contrato` es el número de contrato de Colmena con la empresa y no
            // viaja en la orden: se deja en blanco.
            contrato: '',
            tema: temaDeLaOrden(orden),
            numero_orden: orden.numero_orden,
          },
        ),
      });
      salida.push({
        tipo: 'evaluacion',
        filename: `evaluacion${sufijo}.pdf`,
        buffer: await rellenarPdfPlano(
          path.join(RAIZ, 'colmena', 'evaluacion.pdf'), CASILLAS_EVALUACION_COLMENA, {
            ciudad: orden.ciudad_ejecucion,
            dia: sesion.dia,
            mes: sesion.mes,
            anio: sesion.anio,
            empresa: orden.empresa_nombre,
            nit: orden.nit_nic,
            facilitador: profesional?.nombre,
            tema: temaDeLaOrden(orden),
          },
        ),
      });
    }

    if (arl === 'colpatria') {
      salida.push({
        tipo: 'asistencia',
        filename: `asistencia${sufijo}.pdf`,
        buffer: await rellenarPdfPlano(
          path.join(RAIZ, 'colpatria', 'asistencia.pdf'), CASILLAS_ASISTENCIA_COLPATRIA, {
            ciudad: orden.ciudad_ejecucion,
            fecha: sesion.fechaCorta,
            duracion: sesion.horas,
            numero_orden: orden.numero_orden,
            empresa: orden.empresa_nombre,
            // "Sede" es dónde se presta el servicio, que es la dirección que
            // trae la orden de servicio de AXA.
            sede: orden.direccion,
            proveedor: identidad.nombre,
            tema: temaDeLaOrden(orden),
            expositor: profesional?.nombre,
            // "Pagina" se numera a mano: el profesional añade hojas si se le
            // llenan los 15 renglones de asistentes.
          },
        ),
      });
    }
  }
  return salida;
}
