/**
 * Genera órdenes de servicio de EJEMPLO para poder probar el pipeline sin usar
 * documentos reales de clientes.
 *
 *   node --import tsx scripts/generar-ordenes-ejemplo.mjs
 *
 * Produce:
 *   · PDFs con el formato de AXA Colpatria  → docs/OrdenesEjemplo/Colpatria/
 *   · Excel con el formato SIPAB de Bolívar → docs/BasesDatosEjemplo/
 *
 * **Todos los datos son inventados.** Las empresas, NIT, personas, teléfonos y
 * correos no existen: es justo lo que diferencia estos archivos de los de
 * `docs/OrdenesEjemplo/`, que son documentos reales de clientes y por eso están
 * en `.gitignore` (razones sociales, NIT y hasta la seguridad social de una
 * persona). Estos se pueden compartir, commitear y enseñar en una demo sin
 * exponer a nadie.
 *
 * El layout del PDF replica el de la orden real `Colpatria/orden_001.pdf`
 * (carta apaisada, 792×612) porque la extracción lee el TEXTO del PDF: si los
 * rótulos no dicen lo mismo —"EMPRESA:", "AFILIACIÓN No:", "FECHA VENCIMIENTO
 * PARA PROGRAMACIÓN:"— el modelo no encuentra los campos.
 *
 * Los números de orden salen de un bloque propio (0002200xxx) para no chocar
 * con los de las órdenes reales ya cargadas: si coincidieran, el dedup de
 * IMP-08/09 las marcaría como duplicadas y no se podrían procesar.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import ExcelJS from 'exceljs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..', '..', 'jdd_consultores_app', 'docs');
const DIR_PDF = path.join(RAIZ, 'OrdenesEjemplo', 'Colpatria');
const DIR_XLS = path.join(RAIZ, 'BasesDatosEjemplo');

// ---------------------------------------------------------------------------
// Datos de ejemplo (inventados)
// ---------------------------------------------------------------------------

/** El proveedor somos nosotros: es fijo en todas las órdenes de la ARL. */
const PROVEEDOR = {
  nombre: 'JDYD CONSULTORES EN SISTEMAS DE GESTION',
  nit: '901203812',
  direccion: 'BRR CORAZON DE JESUS C 24 1',
  telefono: '3182901821',
  ciudad: 'PASTO',
};

const ORDENES = [
  {
    numero: '0002200101', upr: '713', fechaOrden: '2026-08-03',
    empresa: 'TRANSPORTES ANDINA DEL SUR S A S', afiliacion: '9021455',
    nit: '901455780', centro: 'OPERACIONES Y LOGISTICA',
    direccion: 'CRA 22 NO 18 40 BOMBONA', telefono: '6027451200',
    contacto: 'LUCIA RENGIFO', cargo: 'JEFE DE TALENTO HUMANO', telContacto: '3104558921',
    codigo: 'SEI410', actividad: 'CAP TRABAJO SEGURO EN ALTURAS', ciudad: 'PASTO',
    horas: 8, valorHora: 58856, modalidad: 'PRESENCIAL',
    sstNombre: 'ANDRES FELIPE OSORIO', sstTel: '3145890217',
    sstCorreo: 'sst@transportesandina.com.co', sedeAct: 'CRA 22 NO 18 40, PASTO',
  },
  {
    numero: '0002200102', upr: '713', fechaOrden: '2026-08-05',
    empresa: 'AGROINDUSTRIAS EL MIRADOR LTDA', afiliacion: '9018744',
    nit: '900874312', centro: 'PLANTA DE PROCESO',
    direccion: 'KM 3 VIA PANAMERICANA', telefono: '6027733410',
    contacto: 'HERNAN DARIO PAZ', cargo: 'REPRESENTANTE LEGAL', telContacto: '3187740123',
    codigo: 'SEI228', actividad: 'CAP RIESGO QUIMICO', ciudad: 'IPIALES',
    horas: 4, valorHora: 58856, modalidad: 'PRESENCIAL',
    sstNombre: 'MARTHA LUCIA BURBANO', sstTel: '3122087745',
    sstCorreo: 'seguridad@elmirador.com.co', sedeAct: 'KM 3 VIA PANAMERICANA, IPIALES',
  },
  {
    numero: '0002200103', upr: '713', fechaOrden: '2026-08-06',
    empresa: 'CONFECCIONES LA PRIMAVERA S A S', afiliacion: '9016620',
    nit: '901662045', centro: 'AREA DE CORTE Y CONFECCION',
    direccion: 'CLL 14 NO 9 33 CENTRO', telefono: '6027908822',
    contacto: 'DIANA CAROLINA MELO', cargo: 'COORDINADORA ADMINISTRATIVA', telContacto: '3005512078',
    codigo: 'SEI135', actividad: 'INSPECCION DE PUESTOS DE TRABAJO', ciudad: 'TUQUERRES',
    horas: 6, valorHora: 61200, modalidad: 'PRESENCIAL',
    sstNombre: 'JAIRO ANTONIO CUARAN', sstTel: '3169943012',
    sstCorreo: 'sgsst@laprimavera.com.co', sedeAct: 'CLL 14 NO 9 33, TUQUERRES',
  },
  {
    numero: '0002200104', upr: '713', fechaOrden: '2026-08-07',
    empresa: 'LACTEOS SAN FERNANDO S A', afiliacion: '9003017',
    nit: '890301774', centro: 'DISTRIBUCION',
    direccion: 'AV LOS ESTUDIANTES NO 12 55', telefono: '6027311945',
    contacto: 'MARLON CAICEDO', cargo: 'REPRESENTANTE LEGAL', telContacto: '3182233990',
    codigo: 'SEI652', actividad: 'CAP SEGURIDAD VIAL', ciudad: 'PASTO',
    horas: 10, valorHora: 58856, modalidad: 'PRESENCIAL',
    sstNombre: 'FELIPE VARGAS TORRES', sstTel: '3147206440',
    sstCorreo: 'seguridad.trabajo@lacteossanfernando.co', sedeAct: 'AV LOS ESTUDIANTES NO 12 55, PASTO',
  },
  {
    numero: '0002200105', upr: '713', fechaOrden: '2026-08-10',
    empresa: 'CONSTRUCTORA VALLE VERDE S A S', afiliacion: '9012089',
    nit: '901208955', centro: 'OBRA CIVIL PUERTO',
    direccion: 'CLL 5 NO 2 18 BARRIO PANAMA', telefono: '6027220145',
    contacto: 'OSCAR IVAN QUIÑONES', cargo: 'DIRECTOR DE OBRA', telContacto: '3115509923',
    codigo: 'SEI318', actividad: 'CAP MANEJO MANUAL DE CARGAS', ciudad: 'TUMACO',
    horas: 12, valorHora: 64500, modalidad: 'PRESENCIAL',
    sstNombre: 'GLORIA ESPERANZA MINA', sstTel: '3178820456',
    sstCorreo: 'hseq@valleverde.com.co', sedeAct: 'CLL 5 NO 2 18, TUMACO',
  },
  {
    numero: '0002200106', upr: '713', fechaOrden: '2026-08-11',
    empresa: 'DISTRIBUIDORA NARIÑO EXPRESS LTDA', afiliacion: '9005561',
    nit: '900556128', centro: 'BODEGA CENTRAL',
    direccion: 'CRA 27 NO 6 12 SUR', telefono: '6027665500',
    contacto: 'SANDRA MILENA ORTEGA', cargo: 'GERENTE OPERATIVA', telContacto: '3143398871',
    codigo: 'SEI092', actividad: 'MEDICION DE ILUMINACION', ciudad: 'PASTO',
    horas: 3, valorHora: 72000, modalidad: 'PRESENCIAL',
    sstNombre: 'CARLOS EDUARDO BENAVIDES', sstTel: '3196614238',
    sstCorreo: 'sst@narinoexpress.co', sedeAct: 'CRA 27 NO 6 12 SUR, PASTO',
  },
  {
    // 16 h: obliga a repartir la visita en varias franjas (ASG-02).
    numero: '0002200107', upr: '713', fechaOrden: '2026-08-12',
    empresa: 'CLINICA SANTA ISABEL S A S', afiliacion: '9017334',
    nit: '901733460', centro: 'HOSPITALIZACION Y URGENCIAS',
    direccion: 'CRA 10 NO 15 70', telefono: '6027744120',
    contacto: 'PATRICIA ELENA ROSERO', cargo: 'JEFE DE ENFERMERIA', telContacto: '3126678543',
    codigo: 'SEI501', actividad: 'CAP RIESGO BIOLOGICO', ciudad: 'IPIALES',
    horas: 16, valorHora: 58856, modalidad: 'PRESENCIAL',
    sstNombre: 'RUBEN DARIO CHAVES', sstTel: '3157790021',
    sstCorreo: 'seguridadysalud@clinicasantaisabel.co', sedeAct: 'CRA 10 NO 15 70, IPIALES',
  },
  {
    // Horas con media: comprueba el formato "4 y 30 min" del correo y los PDF.
    numero: '0002200108', upr: '713', fechaOrden: '2026-08-13',
    empresa: 'METALMECANICA DEL PACIFICO S A S', afiliacion: '9009123',
    nit: '900912337', centro: 'TALLER DE SOLDADURA',
    direccion: 'VIA AL AEROPUERTO KM 2', telefono: '6027201188',
    contacto: 'JOSE LUIS ANGULO', cargo: 'SUPERVISOR DE PLANTA', telContacto: '3102245567',
    codigo: 'SEI277', actividad: 'CAP RIESGO MECANICO', ciudad: 'TUMACO',
    horas: 4.5, valorHora: 58856, modalidad: 'VIRTUAL',
    sstNombre: 'YENNY ALEXANDRA CAICEDO', sstTel: '3181123409',
    sstCorreo: 'sst@metalpacifico.com.co', sedeAct: 'SESION VIRTUAL - TEAMS',
  },
];

// ---------------------------------------------------------------------------
// Utilidades de formato (las de la ARL, no las nuestras)
// ---------------------------------------------------------------------------

/** '2026-08-03' → '03/08/2026', que es como escribe las fechas AXA. */
function fechaCO(iso) {
  const [a, m, d] = iso.split('-');
  return `${d}/${m}/${a}`;
}

/** Suma días a una fecha ISO y la devuelve en formato AXA. */
function vencimiento(iso, dias = 90) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + dias);
  return fechaCO(d.toISOString().slice(0, 10));
}

/** 588560 → '$ 588.560,00' (puntos de miles, coma decimal). */
function pesos(n) {
  const entero = Math.trunc(n);
  const dec = Math.round((n - entero) * 100);
  const miles = entero.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `$ ${miles},${String(dec).padStart(2, '0')}`;
}

/** 4.5 → '4,5'; 8 → '8'. La ARL usa coma decimal. */
function cantidad(n) {
  return Number.isInteger(n) ? String(n) : String(n).replace('.', ',');
}

// ---------------------------------------------------------------------------
// PDF con el formato de AXA Colpatria
// ---------------------------------------------------------------------------

async function generarPdf(o) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([792, 612]);            // carta apaisada, como la real
  const normal = await doc.embedFont(StandardFonts.Helvetica);
  const negrita = await doc.embedFont(StandardFonts.HelveticaBold);
  const negro = rgb(0.1, 0.1, 0.1);

  const texto = (t, x, y, { size = 8, font = normal, color = negro } = {}) =>
    page.drawText(String(t), { x, y, size, font, color });

  const linea = (y, x1 = 40, x2 = 752) =>
    page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: 0.7, color: rgb(0.6, 0.6, 0.6) });

  // --- Encabezado de la ARL ---
  texto('AXA COLPATRIA', 40, 567, { size: 13, font: negrita });
  texto('SEGUROS DE VIDA S.A', 40, 555, { size: 8, font: negrita });
  texto(`ORDEN DE SERVICIO EXTERNA NÚMERO: 71 - ${o.numero}`, 40, 543, { size: 9, font: negrita });
  texto(`UPR: ${o.upr}`, 40, 531);
  texto(fechaCO(o.fechaOrden), 140, 531);

  // --- Destinatario: el proveedor (nosotros) ---
  texto('Señores:', 40, 507);
  texto(PROVEEDOR.nombre, 40, 495, { font: negrita });
  texto(`NIT/CED: ${PROVEEDOR.nit}`, 40, 483);
  texto(PROVEEDOR.direccion, 40, 471);
  texto(`Telefono: ${PROVEEDOR.telefono}`, 40, 459);
  texto(PROVEEDOR.ciudad, 40, 447);

  // --- Empresa donde se ejecuta la visita ---
  linea(437);
  texto(`EMPRESA: ${o.empresa}`, 40, 425, { font: negrita });
  texto(`AFILIACIÓN No: ${o.afiliacion}`, 400, 425);
  texto(`C.TRABAJO: ${o.centro}`, 540, 425);
  texto(`DIRECCIÓN: ${o.direccion}`, 40, 413);
  texto(`TELÉFONO: ${o.telefono}`, 400, 413);
  texto(`NIT: ${o.nit}`, 540, 413);
  texto(`PERSONA CONTACTO: ${o.contacto}`, 40, 401);
  texto(`CARGO: ${o.cargo}`, 400, 401);
  texto(`TELÉFONO: ${o.telContacto}`, 610, 401);
  linea(391);

  texto('Apreciados señores:', 40, 381);
  texto('Con la presente autorizamos la realización de los siguientes procedimientos.', 40, 358);

  // --- Tabla de actividades ---
  linea(330);
  const cols = [40, 110, 330, 430, 505, 570, 660];
  const cab = ['ACTIVIDAD', 'DESCRIPCIÓN', 'REGIONAL EJECUCIÓN', 'CIUDAD EJECUCIÓN', 'CANTIDAD', 'VR. UNITARIO', 'VR TOTAL'];
  cab.forEach((c, i) => texto(c, cols[i], 320, { size: 7, font: negrita }));
  linea(314);

  const total = o.valorHora * o.horas;
  const fila = [o.codigo, o.actividad, o.ciudad, o.ciudad, cantidad(o.horas), pesos(o.valorHora), pesos(total)];
  fila.forEach((c, i) => texto(c, cols[i], 301, { size: 8 }));
  texto('PROF', 40, 290, { size: 7 });
  linea(286);
  texto('TOTAL', 40, 276, { size: 8, font: negrita });
  texto(cantidad(o.horas), cols[4], 276, { size: 8, font: negrita });
  texto(pesos(total), cols[6], 276, { size: 8, font: negrita });
  linea(268);

  // --- Observaciones: de aquí salen el contacto SST y la modalidad ---
  linea(164);
  texto(`OBSERVACIONES: Nombre, Cargo:${o.sstNombre} ,${o.actividad}  Tel, Sede`, 40, 154, { size: 7 });
  texto(`Act:${o.sstTel},${o.sstCorreo.toUpperCase()}  Inf. Adic:${o.sedeAct} ,${o.modalidad}`, 40, 143, { size: 7 });

  texto('FECHA VENCIMIENTO PARA', 40, 112, { size: 8, font: negrita });
  texto('PROGRAMACIÓN:', 40, 104, { size: 8, font: negrita });
  texto(vencimiento(o.fechaOrden), 160, 108, { size: 9, font: negrita });

  // --- Firmas ---
  texto('YESICA JOHANA GUERRERO SOLARTE', 40, 84, { size: 7 });
  texto('ALEJANDRO MARTINEZ VERGARA', 430, 84, { size: 7 });
  texto('TÉCNICO EN SEGURIDAD INDUSTRIAL', 40, 66, { size: 7 });
  texto('DIRECTOR DE UNIDAD DE PREVENCIÓN DE RIESGOS', 430, 66, { size: 7 });
  texto('ALEJANDRO MARTINEZ VERGARA', 40, 42, { size: 7 });
  texto('DEISY JULIET ESPINOSA CASTILLO', 430, 42, { size: 7 });
  texto('PREAPROBACIÓN', 40, 24, { size: 7, font: negrita });
  texto('APROBACIÓN', 430, 24, { size: 7, font: negrita });

  return doc.save();
}

// ---------------------------------------------------------------------------
// Excel con el formato SIPAB de Bolívar
// ---------------------------------------------------------------------------

/**
 * Encabezados EXACTOS del SIPAB real (`base_datos_bolivar.xlsx`). El orden y la
 * redacción importan: `SIPAB_HEADERS` de `extraction.service.js` los reconoce
 * por nombre exacto, y una columna renombrada deja de mapearse al campo canónico.
 */
const CABECERAS_SIPAB = [
  'Nit Empresa', 'Razon Social', 'Descripcion Estado Empresa', 'En Mora',
  'Numero Cronograma', 'Actividad Cronograma', 'Actividad Programa', 'Descripcion',
  'Unidad Medida', 'Act Programadas', 'Act Ejecutadas', 'Act Canceladas',
  'Act Reprogramadas', 'Aplazadas', 'Autor Fact', 'Tipo Servicio',
  'Nro Trabajadores Programados', 'Fecha Programada', 'Fecha Ejecutada',
  'Fecha Reprogramada', 'Hora Programada', 'Hora Ejecutada', 'Nivel Aplicacion',
  'Valor Transporte', 'Valor Alojamiento', 'Valor Alimentacion',
  'Valor Tiempo Muerto', 'Valor Desplazamiento', 'Autoriza Viaticos',
  'Valor Material Complementario', 'Proveedor', 'Nombre Proveedor',
  'Profesional', 'Nombre Profesional', 'Asesor Gestion Riesgos Crono',
  'Nombre Asesor Gestion Riesgos', 'Director Sectorial', 'Nombre Director Sectorial',
  'Observaciones', 'Num pol', 'Ubicacion Actividad',
];

/**
 * Filas del SIPAB de ejemplo, con la MISMA forma que el reporte real:
 *  · `programa` es el código del plan (columna "Actividad Programa"), y el
 *    título de la actividad va aparte, en la columna "Descripcion".
 *  · la ciudad, la dirección, el teléfono y el contacto de la empresa NO tienen
 *    columna propia: viajan dentro del bloque de "Ubicacion Actividad".
 *  · el correo y el celular del responsable de SST solo aparecen —cuando
 *    aparecen— escritos dentro de las observaciones.
 * Una fila se mide en UNIDADES y no en horas, y las fechas alternan entre fecha
 * de Excel y el texto `18/aug/2026`, porque el SIPAB real mezcla las dos cosas.
 */
const FILAS_SIPAB = [
  { nit: '901455780', razon: 'TRANSPORTES ANDINA DEL SUR S A S', programa: '508.05.01', actividad: 'PROGRAMA DE PREVENCION CONTRA CAIDAS', horas: 8,  fecha: '2026-08-18', ciudad: 'PASTO',     direccion: 'CR 21A 17 27',      telefono: '3105006718', contacto: 'JULLY VANESA GETIAL',   obs: 'CAPACITACION EN TRABAJO SEGURO EN ALTURAS / JULLY VANESA GETIAL (COORD. SST) 316 3348612 SST@ANDINADELSUR.COM.CO' },
  { nit: '900874312', razon: 'AGROINDUSTRIAS EL MIRADOR LTDA',   programa: '508.09.04', actividad: 'PROGRAMA DE RIESGO QUIMICO',          horas: 4,  fecha: '2026-08-19', ciudad: 'IPIALES',   direccion: 'CL 16 # 22 68 CENTRO', telefono: '7258745',    contacto: 'MARTHA LUCIA BURBANO', obs: 'CAPACITACION EN MANEJO DE SUSTANCIAS QUIMICAS. CONTACTO: MARTHA BURBANO 320 6560433' },
  { nit: '901662045', razon: 'CONFECCIONES LA PRIMAVERA S A S',  programa: '508.12.01', actividad: 'VIGILANCIA EPIDEMIOLOGICA DE ERGONOMIA', horas: 6, fecha: '2026-08-20', ciudad: 'TUQUERRES', direccion: 'AV LA PLAYA CL 5 6 15', telefono: '3174231638', contacto: 'JAIRO ANTONIO CUARAN', obs: 'INSPECCION DE PUESTOS DE TRABAJO. REQUIERE REGISTRO FOTOGRAFICO Y FORMATO DE ASISTENCIA' },
  { nit: '890301774', razon: 'LACTEOS SAN FERNANDO S A',         programa: '412.04.26', actividad: 'PROGRAMA DE SEGURIDAD VIAL',          horas: 10, fecha: '2026-08-21', ciudad: 'PASTO',     direccion: 'CLL 18 # 18 60',       telefono: '3808955',    contacto: 'FELIPE VARGAS TORRES', obs: 'CAPACITACION EN SEGURIDAD VIAL PARA CONDUCTORES / FELIPE VARGAS 317 2186903; SST@LACTEOSSANFERNANDO.COM' },
  { nit: '901208955', razon: 'CONSTRUCTORA VALLE VERDE S A S',   programa: '508.04.16', actividad: 'PROGRAMA DE ORDEN Y LIMPIEZA',        horas: 12, fecha: '2026-08-24', ciudad: 'TUMACO',    direccion: 'CR 40 A 17 A 35',      telefono: '3207889508', contacto: 'GLORIA ESPERANZA MINA', obs: 'CAPACITACION EN MANEJO MANUAL DE CARGAS. DEFINIR HORA CON LA EMPRESA' },
  { nit: '900556128', razon: 'DISTRIBUIDORA NARIÑO EXPRESS LTDA',programa: '508.27.02', actividad: 'HABITOS SALUDABLES CONSERVACION AUDITIVA', horas: 3, fecha: '2026-08-25', ciudad: 'PASTO',   direccion: 'AV 5N 23AN 35',        telefono: '3366700',    contacto: 'CARLOS BENAVIDES',     obs: 'MEDICION DE ILUMINACION EN BODEGA. CONTACTO: CARLOS BENAVIDES 310 2492927' },
  { nit: '901733460', razon: 'CLINICA SANTA ISABEL S A S',       programa: '508.11.15', actividad: 'PRIMEROS AUXILIOS',                   horas: 16, fecha: '2026-08-26', ciudad: 'IPIALES',   direccion: 'CL 19 # 31 C 19',      telefono: '3158754736', contacto: 'RUBEN DARIO CHAVES',   obs: 'CAPACITACION EN RIESGO BIOLOGICO / RUBEN CHAVES (COORD. TALENTO HUMANO) SST@SANTAISABEL.COM.CO 315 8754736' },
  { nit: '900912337', razon: 'METALMECANICA DEL PACIFICO S A S', programa: '414.01.03', actividad: 'INVESTIGACION DE ACCIDENTE GRAVE',    horas: 1,  fecha: '2026-08-27', ciudad: 'TUMACO',    direccion: 'VEREDA EL ALISO BODEGA 3', telefono: '3366700', contacto: 'YENNY A. CAICEDO',     obs: 'INVESTIGACION DE SINIESTRO GRAVE OCURRIDO EL 12-AUG-26', unidad: 'UNIDADES' },
  { nit: '901044219', razon: 'PANIFICADORA EL TRIGAL LTDA',      programa: '508.12.01', actividad: 'PROGRAMA DE HIGIENE POSTURAL',        horas: 4,  fecha: '2026-08-28', ciudad: 'PASTO',     direccion: 'CR 21A 17 27',         telefono: '3105006718', contacto: 'LINA MARCELA JOJOA',   obs: 'ASESORIA EN PAUSAS ACTIVAS Y HIGIENE POSTURAL' },
  { nit: '900733015', razon: 'HOTELES DEL SUR S A S',            programa: '508.11.05', actividad: 'DIVULGACION PLAN EMERGENCIAS',        horas: 6,  fecha: '2026-08-31', ciudad: 'IPIALES',   direccion: 'CL 16 # 22 68 CENTRO', telefono: '7258745',    contacto: 'EDWIN ALEXANDER RUANO', obs: 'CAPACITACION EN PREVENCION DE INCENDIOS. ACOMPAÑAMIENTO EN SIMULACRO' },
];

/** Los meses del SIPAB van abreviados en inglés: `2026-08-18` → `18/aug/2026`. */
const MES_SIPAB = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function fechaTextoSipab(iso) {
  const [a, m, d] = iso.split('-');
  return `${d}/${MES_SIPAB[Number(m) - 1]}/${a}`;
}

/**
 * @param {boolean} conVencimiento  Añade la columna "Fecha Vencimiento".
 *   El SIPAB real NO la trae y la aplicación la exige para guardar, así que se
 *   generan las dos variantes: la fiel (para reproducir el problema tal cual lo
 *   vive el cliente) y una con la columna añadida, que sí entra de una pasada.
 */
async function generarExcel(conVencimiento) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('data (1)');          // la hoja real se llama así

  const cabeceras = [...CABECERAS_SIPAB];
  if (conVencimiento) cabeceras.push('Fecha Vencimiento');
  ws.addRow(cabeceras);
  ws.getRow(1).font = { bold: true };

  FILAS_SIPAB.forEach((o, i) => {
    const { nit, razon, programa, actividad, horas, fecha, ciudad, direccion, telefono, contacto, obs } = o;
    const fila = new Array(cabeceras.length).fill('');
    fila[0] = nit;
    fila[1] = razon;
    fila[2] = 'Activa';                            // estado de la EMPRESA, no de la actividad
    fila[3] = 'NO';
    fila[4] = String(1370500 + i);                 // Numero Cronograma  → codigo_cronograma
    fila[5] = String(10 + i);                      // Actividad Cronograma → secuencia
    fila[6] = programa;                            // Actividad Programa → actividad_economica
    fila[7] = actividad;                           // Descripcion → tipo_actividad
    fila[8] = o.unidad ?? 'HORAS';
    fila[9] = horas;                               // Act Programadas → horas_asignadas
    fila[10] = 0;
    fila[11] = 0;
    fila[12] = 0;
    fila[13] = 0;
    fila[15] = i % 3 === 0 ? 'T' : 'C';
    fila[16] = 15 + i;
    // La MITAD como fecha de Excel y la otra mitad como el texto `18/aug/2026`:
    // el SIPAB real mezcla los dos formatos en la misma columna.
    fila[17] = i % 2 === 0 ? new Date(`${fecha}T00:00:00Z`) : fechaTextoSipab(fecha);
    fila[20] = '08:00';
    fila[22] = 'INDIVIDUAL';
    fila[30] = '901203812';
    fila[31] = PROVEEDOR.nombre;                   // el proveedor es JD&D, no la empresa
    fila[35] = 'CLAUDIA RESTREPO';
    fila[37] = 'JORGE ENRIQUE MORA';
    fila[38] = `${obs} (ACTIVIDAD CARGADA EN PROCESO DE LOTE)`;  // Observaciones → descripcion
    fila[39] = `Nro. ${20260000000 + i}`;
    // Ubicacion Actividad: un solo texto del que salen ciudad, dirección y
    // contacto de la empresa.
    fila[40] = `Departamento: NARINO - Ciudad: ${ciudad} - Dirección: ${direccion} - Teléfono: ${telefono} - Contacto: ${contacto}`;
    if (conVencimiento) {
      const d = new Date(`${fecha}T12:00:00`);
      d.setDate(d.getDate() + 60);
      fila[41] = d.toISOString().slice(0, 10);
    }
    ws.addRow(fila);
  });

  ws.columns.forEach((c) => { c.width = 22; });
  return wb.xlsx.writeBuffer();
}

// ---------------------------------------------------------------------------

async function main() {
  await mkdir(DIR_PDF, { recursive: true });
  await mkdir(DIR_XLS, { recursive: true });

  console.log('== Órdenes de ejemplo (datos inventados) ==\n');

  for (const [i, o] of ORDENES.entries()) {
    const slug = o.empresa.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    const nombre = `ejemplo-axa-${String(i + 1).padStart(2, '0')}-${slug}.pdf`;
    await writeFile(path.join(DIR_PDF, nombre), await generarPdf(o));
    console.log(`  PDF   ${nombre.padEnd(58)} ${o.empresa} · ${cantidad(o.horas)} h · ${o.ciudad}`);
  }

  const fiel = 'ejemplo-bolivar-sipab.xlsx';
  await writeFile(path.join(DIR_XLS, fiel), await generarExcel(false));
  console.log(`\n  XLSX  ${fiel.padEnd(58)} ${FILAS_SIPAB.length} órdenes · formato SIPAB fiel (sin vencimiento)`);

  const conVenc = 'ejemplo-bolivar-sipab-con-vencimiento.xlsx';
  await writeFile(path.join(DIR_XLS, conVenc), await generarExcel(true));
  console.log(`  XLSX  ${conVenc.padEnd(58)} ${FILAS_SIPAB.length} órdenes · con columna "Fecha Vencimiento"`);

  console.log(`\nPDF  → ${DIR_PDF}`);
  console.log(`XLSX → ${DIR_XLS}`);
  console.log('\nNo se procesó ninguno: los archivos quedan listos para subirlos desde Importar.');
}

main().catch((e) => { console.error('✖', e); process.exit(1); });
