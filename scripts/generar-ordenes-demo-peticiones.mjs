/**
 * Órdenes de EJEMPLO para presentar al cliente las seis peticiones de la
 * reunión del 22-ago-2026 (`docs/plan-peticiones-22-ago-2026.md`).
 *
 *   node scripts/generar-ordenes-demo-peticiones.mjs
 *
 * A diferencia de `generar-ordenes-ejemplo.mjs` —que produce un lote genérico
 * para probar el pipeline— aquí cada orden está construida para que, al
 * importarla, se dispare UNA rama concreta de las peticiones nuevas: la letra
 * del AT-031, el presencial/virtual, los viáticos, el corte de 16 horas de AXA,
 * el puente del profesional registrado y el estado de facturación.
 *
 * Salida (carpeta IGNORADA por git, igual que las otras de ejemplo):
 *
 *   docs/OrdenesDemo/Bolivar/    demo-bolivar-sipab.xlsx   (6 órdenes en un Excel)
 *   docs/OrdenesDemo/Colpatria/  3 PDF
 *   docs/OrdenesDemo/Colmena/    2 PDF
 *   docs/OrdenesDemo/README.md   qué demuestra cada una, en orden de demo
 *
 * **Todos los datos son inventados**: empresas, NIT, personas, teléfonos y
 * correos no existen. Se puede proyectar en una reunión sin exponer a nadie.
 *
 * Los números de orden salen de bloques propios (AXA 00022003xx, Colmena 224xxxx,
 * cronogramas 13809xx) para que el dedup de IMP-08/09 no los confunda con las
 * órdenes reales ya cargadas ni con las del otro generador.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import ExcelJS from 'exceljs';
// La matriz de verdad, la misma que usa la asignación. El README no repite a
// mano qué formatos y qué soportes toca en cada caso: se los pregunta, para que
// no se quede desfasado la próxima vez que cambie una regla.
import { entregaDeLaOrden } from '../src/services/entrega-arl.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..', '..', 'jdd_consultores_app', 'docs', 'OrdenesDemo');
const DIR_BOL = path.join(RAIZ, 'Bolivar');
const DIR_AXA = path.join(RAIZ, 'Colpatria');
const DIR_COL = path.join(RAIZ, 'Colmena');

/** El proveedor somos nosotros: es fijo en todas las órdenes de las tres ARL. */
const PROVEEDOR = {
  nombre: 'JDYD CONSULTORES EN SISTEMAS DE GESTION',
  nit: '901203812',
  direccion: 'BRR CORAZON DE JESUS C 24 1',
  telefono: '3182901821',
  ciudad: 'PASTO',
};

// ---------------------------------------------------------------------------
// Utilidades de formato (las de la ARL, no las nuestras)
// ---------------------------------------------------------------------------

/** '2026-09-02' → '02/09/2026', que es como escriben las fechas AXA y Colmena. */
function fechaCO(iso) {
  const [a, m, d] = iso.split('-');
  return `${d}/${m}/${a}`;
}

/** Suma días a una fecha ISO y la devuelve en ISO. */
function sumarDias(iso, dias) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
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

// ===========================================================================
// BOLÍVAR · Excel SIPAB
// ===========================================================================

/**
 * Encabezados EXACTOS del SIPAB real. El orden y la redacción importan:
 * `SIPAB_HEADERS` de `extraction.service.js` los reconoce por nombre exacto, y
 * una columna renombrada deja de mapearse al campo canónico.
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
 * Las seis órdenes de Bolívar de la demo. `letra` es la columna "Tipo Servicio"
 * (petición 2) y `viaticos` el bloque de columnas de la petición 1; la
 * modalidad NO está en el SIPAB —la escribe quien revisa la orden (petición 4)—
 * así que va anotada en `modalidadDemo` para el guion de la presentación.
 */
const ORDENES_BOLIVAR = [
  {
    nit: '901552340', razon: 'INDUSTRIAS DEL GUAICO S A S',
    programa: '508.05.01', actividad: 'PROGRAMA DE PREVENCION CONTRA CAIDAS',
    letra: 'C', modalidadDemo: 'PRESENCIAL', horas: 8, fecha: '2026-09-02',
    ciudad: 'PASTO', direccion: 'CR 21A 17 27', telefono: '6027445512',
    contacto: 'JULLY VANESA GETIAL',
    viaticos: { autoriza: 'S', transporte: 21020, desplazamiento: 21020 },
    obs: 'CAPACITACION EN TRABAJO SEGURO EN ALTURAS / JULLY VANESA GETIAL (COORD. SST) 316 3348612 SST@GUAICO.COM.CO. LOTE FACTURACION AGO-2026',
  },
  {
    nit: '900418877', razon: 'SERVICIOS PORTUARIOS DEL PACIFICO S A S',
    programa: '508.11.05', actividad: 'DIVULGACION PLAN DE EMERGENCIAS',
    letra: 'C', modalidadDemo: 'VIRTUAL', horas: 4, fecha: '2026-09-03',
    ciudad: 'TUMACO', direccion: 'CL 5 2 18 BARRIO PANAMA', telefono: '6027220145',
    contacto: 'EDWIN ALEXANDER RUANO',
    viaticos: { autoriza: 'N' },
    obs: 'SESION VIRTUAL POR TEAMS. CAPACITACION EN PREVENCION DE INCENDIOS / EDWIN RUANO 310 4471209 SST@PORTUARIOSPACIFICO.CO',
  },
  {
    nit: '901330742', razon: 'MADERAS Y ACABADOS EL ROBLE LTDA',
    programa: '414.01.03', actividad: 'ACOMPANAMIENTO TECNICO EN RIESGO MECANICO',
    letra: 'T', modalidadDemo: 'PRESENCIAL', horas: 12, fecha: '2026-09-07',
    ciudad: 'MOCOA', direccion: 'KM 2 VIA PUERTO ASIS', telefono: '6084296611',
    contacto: 'GLORIA ESPERANZA MINA',
    viaticos: { autoriza: 'S', transporte: 46000, alojamiento: 120000, alimentacion: 54000 },
    obs: 'ASISTENCIA TECNICA FUERA DE LA CIUDAD (2 DIAS). EL PROFESIONAL DEBE ESTAR REGISTRADO Y APROBADO EN LA BASE DE BOLIVAR. LOTE FACTURACION AGO-2026',
  },
  {
    nit: '900961204', razon: 'ALIMENTOS LA COSECHA S A',
    programa: '508.12.01', actividad: 'ASESORIA EN MATRIZ DE PELIGROS',
    letra: 'A', modalidadDemo: 'PRESENCIAL', horas: 6, fecha: '2026-09-08',
    ciudad: 'PASTO', direccion: 'AV LOS ESTUDIANTES 12 55', telefono: '6027311945',
    contacto: 'LINA MARCELA JOJOA',
    viaticos: { autoriza: 'N' },
    obs: 'ASESORIA EN ACTUALIZACION DE LA MATRIZ DE PELIGROS. NO REQUIERE REGISTRO FOTOGRAFICO. LOTE FACTURACION AGO-2026',
  },
  {
    nit: '901078455', razon: 'TERMINAL DE TRANSPORTES DE IPIALES S A',
    programa: '508.27.02', actividad: 'MEDICION DE RUIDO OCUPACIONAL',
    letra: 'E', modalidadDemo: 'PRESENCIAL', horas: 3, fecha: '2026-09-09',
    ciudad: 'IPIALES', direccion: 'CL 16 22 68 CENTRO', telefono: '6027258745',
    contacto: 'CARLOS EDUARDO BENAVIDES',
    viaticos: { autoriza: 'N' },
    obs: 'SERVICIO ESPECIALIZADO: HIGIENE INDUSTRIAL CON EQUIPO CALIBRADO. CONTACTO: CARLOS BENAVIDES 310 2492927',
  },
  {
    nit: '900733015', razon: 'IPS SALUD INTEGRAL DEL SUR S A S',
    programa: '508.11.15', actividad: 'JORNADA DE PROMOCION Y PREVENCION',
    letra: 'O', modalidadDemo: 'PRESENCIAL', horas: 5, fecha: '2026-09-10',
    ciudad: 'TUQUERRES', direccion: 'AV LA PLAYA CL 5 6 15', telefono: '6027908822',
    contacto: 'RUBEN DARIO CHAVES',
    viaticos: { autoriza: 'S', desplazamiento: 32500 },
    obs: 'TIPOLOGIA OTROS - SERVICIO DE SALUD. RADICAR AT-031 + AT-028 + INFORME / RUBEN CHAVES SST@SALUDINTEGRALSUR.CO 315 8754736',
  },
];

/** Los meses del SIPAB van abreviados en inglés: `2026-09-02` → `02/sep/2026`. */
const MES_SIPAB = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function fechaTextoSipab(iso) {
  const [a, m, d] = iso.split('-');
  return `${d}/${MES_SIPAB[Number(m) - 1]}/${a}`;
}

/** El total que el extractor va a calcular con `viaticosDelSipab()`. */
function totalViaticos(v = {}) {
  if (v.autoriza !== 'S') return 0;
  const suma = (v.transporte ?? 0) + (v.alojamiento ?? 0) + (v.alimentacion ?? 0) + (v.tiempo_muerto ?? 0);
  return suma || (v.desplazamiento ?? 0);
}

/**
 * El SIPAB real NO trae "Fecha Vencimiento" y la aplicación la exige para
 * guardar. Para una demo se genera CON la columna, para que el lote entre de
 * una pasada y no haya que teclear seis fechas delante del cliente.
 */
async function generarExcelBolivar() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('data (1)');          // la hoja real se llama así

  const cabeceras = [...CABECERAS_SIPAB, 'Fecha Vencimiento'];
  ws.addRow(cabeceras);
  ws.getRow(1).font = { bold: true };

  ORDENES_BOLIVAR.forEach((o, i) => {
    const v = o.viaticos ?? {};
    const fila = new Array(cabeceras.length).fill('');
    fila[0] = o.nit;
    fila[1] = o.razon;
    fila[2] = 'Activa';                            // estado de la EMPRESA, no de la actividad
    fila[3] = 'NO';
    fila[4] = String(1380901 + i);                 // Numero Cronograma  → codigo_cronograma
    fila[5] = String(21 + i);                      // Actividad Cronograma → secuencia
    fila[6] = o.programa;                          // Actividad Programa → actividad_economica
    fila[7] = o.actividad;                         // Descripcion → tipo_actividad
    fila[8] = 'HORAS';
    fila[9] = o.horas;                             // Act Programadas → horas_asignadas
    fila[10] = 0; fila[11] = 0; fila[12] = 0; fila[13] = 0;
    fila[15] = o.letra;                            // Tipo Servicio → tipo_servicio_arl (PETICIÓN 2)
    fila[16] = 12 + i;
    // La MITAD como fecha de Excel y la otra mitad como el texto `02/sep/2026`:
    // el SIPAB real mezcla los dos formatos en la misma columna.
    fila[17] = i % 2 === 0 ? new Date(`${o.fecha}T00:00:00Z`) : fechaTextoSipab(o.fecha);
    fila[20] = '08:00';
    fila[22] = 'INDIVIDUAL';
    // Viáticos (PETICIÓN 1). Ojo: en el dato real `Valor Desplazamiento` repite
    // el importe de transporte, así que el extractor NO suma esa columna: la
    // guarda en el desglose y solo la usa cuando es lo único que hay (fila 6).
    fila[23] = v.transporte ?? 0;
    fila[24] = v.alojamiento ?? 0;
    fila[25] = v.alimentacion ?? 0;
    fila[26] = v.tiempo_muerto ?? 0;
    fila[27] = v.desplazamiento ?? 0;
    fila[28] = v.autoriza ?? 'N';
    fila[29] = 0;
    fila[30] = PROVEEDOR.nit;
    fila[31] = PROVEEDOR.nombre;                   // el proveedor es JD&D, no la empresa
    fila[35] = 'CLAUDIA RESTREPO';
    fila[37] = 'JORGE ENRIQUE MORA';
    fila[38] = `${o.obs} (ACTIVIDAD CARGADA EN PROCESO DE LOTE)`;  // Observaciones → descripcion
    fila[39] = `Nro. ${20260050000 + i}`;
    // Ubicacion Actividad: un solo texto del que salen ciudad, dirección y
    // contacto de la empresa.
    fila[40] = `Departamento: NARINO - Ciudad: ${o.ciudad} - Dirección: ${o.direccion} - Teléfono: ${o.telefono} - Contacto: ${o.contacto}`;
    fila[41] = sumarDias(o.fecha, 60);
    ws.addRow(fila);
  });

  ws.columns.forEach((c) => { c.width = 22; });
  return wb.xlsx.writeBuffer();
}

// ===========================================================================
// AXA COLPATRIA · PDF
// ===========================================================================

/**
 * El layout replica el de la orden real `Colpatria/orden_001.pdf` (carta
 * apaisada, 792×612) porque la extracción lee el TEXTO del PDF: si los rótulos
 * no dicen lo mismo —"EMPRESA:", "AFILIACIÓN No:", "FECHA VENCIMIENTO PARA
 * PROGRAMACIÓN:"— el modelo no encuentra los campos.
 *
 * El prefijo del título de la actividad ("ASE …" / "CAP …") es lo que
 * `entrega-arl.service.js` mira para elegir el juego de formatos cuando el
 * catálogo de tipos de orden no tiene una categoría equivalente, así que aquí
 * no es decorativo: es lo que parte las asesorías de las capacitaciones.
 */
const ORDENES_AXA = [
  {
    // Asesoría de 12 h → por DEBAJO del corte de 16: Ficha de Gestión técnica.
    numero: '0002200301', upr: '713', fechaOrden: '2026-09-01',
    empresa: 'PLASTICOS Y ENVASES DEL SUR S A S', afiliacion: '9014782',
    nit: '901478233', centro: 'PLANTA DE EXTRUSION',
    direccion: 'CRA 32 NO 14 88 PARQUE INDUSTRIAL', telefono: '6027445120',
    contacto: 'MAURICIO ANDRES ERASO', cargo: 'JEFE DE PRODUCCION', telContacto: '3104558921',
    codigo: 'SEI410', actividad: 'ASE IMPLEMENTACION SG SST FASE I', ciudad: 'PASTO',
    horas: 12, valorHora: 61200, modalidad: 'PRESENCIAL',
    sstNombre: 'ANDRES FELIPE OSORIO', sstTel: '3145890217',
    sstCorreo: 'sst@plasticosdelsur.com.co', sedeAct: 'CRA 32 NO 14 88, PASTO',
    obsExtra: '',
  },
  {
    // Asesoría de 24 h → por ENCIMA del corte: Informe Técnico (.docx).
    // Además se ejecuta fuera de la ciudad y la ARL autoriza viáticos, que en
    // AXA no tienen columna: van escritos en las observaciones y se teclean.
    numero: '0002200302', upr: '713', fechaOrden: '2026-09-02',
    empresa: 'AGROPECUARIA EL PORVENIR LTDA', afiliacion: '9007391',
    nit: '900739118', centro: 'FINCA LA ESPERANZA',
    direccion: 'VEREDA EL ENCANO KM 18', telefono: '6027733410',
    contacto: 'HERNAN DARIO PAZ', cargo: 'REPRESENTANTE LEGAL', telContacto: '3187740123',
    codigo: 'SEI228', actividad: 'ASE ESTANDARES MINIMOS RESOLUCION 0312', ciudad: 'MOCOA',
    horas: 24, valorHora: 61200, modalidad: 'PRESENCIAL',
    sstNombre: 'MARTHA LUCIA BURBANO', sstTel: '3122087745',
    sstCorreo: 'seguridad@elporvenir.com.co', sedeAct: 'VEREDA EL ENCANO KM 18, MOCOA',
    obsExtra: 'AUTORIZA GASTOS DE DESPLAZAMIENTO POR $ 240.000 (3 DIAS FUERA DE LA CIUDAD)',
  },
  {
    // Capacitación → solo Registro de Asistentes, sin informe.
    numero: '0002200303', upr: '713', fechaOrden: '2026-09-03',
    empresa: 'SUPERMERCADOS LA CANASTA S A S', afiliacion: '9019055',
    nit: '901905544', centro: 'BODEGA Y SURTIDO',
    direccion: 'CLL 18 NO 25 40', telefono: '6027908822',
    contacto: 'DIANA CAROLINA MELO', cargo: 'COORDINADORA ADMINISTRATIVA', telContacto: '3005512078',
    codigo: 'SEI135', actividad: 'CAP MANEJO MANUAL DE CARGAS', ciudad: 'IPIALES',
    horas: 8, valorHora: 58856, modalidad: 'PRESENCIAL',
    sstNombre: 'JAIRO ANTONIO CUARAN', sstTel: '3169943012',
    sstCorreo: 'sgsst@lacanasta.com.co', sedeAct: 'CLL 18 NO 25 40, IPIALES',
    obsExtra: '',
  },
];

async function generarPdfAxa(o) {
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
  if (o.obsExtra) texto(o.obsExtra, 40, 132, { size: 7, font: negrita });

  texto('FECHA VENCIMIENTO PARA', 40, 112, { size: 8, font: negrita });
  texto('PROGRAMACIÓN:', 40, 104, { size: 8, font: negrita });
  texto(fechaCO(sumarDias(o.fechaOrden, 90)), 160, 108, { size: 9, font: negrita });

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

// ===========================================================================
// COLMENA · PDF
// ===========================================================================

/**
 * Réplica del `INFORME DE PRESTACION DE SERVICIOS…` (SPM-F 38V2), que en
 * Colmena hace de orden de servicio: carta vertical (612×792), sin AcroForm.
 * Los rótulos son los del documento real —"No. ORDEN DE SERVICIO:",
 * "NIT/NOMBRE DE LA EMPRESA", "CIUDAD DE EJECUCION DE LA ACTIVIDAD"— y de ahí
 * salen los campos al extraer.
 *
 * El bloque "PARA AUTORIZACION DE GASTOS DE DESPLAZAMIENTO" es el que respalda
 * los viáticos de la petición 1 en esta ARL: cuando la orden los lleva, sale
 * diligenciado.
 */
const ORDENES_COLMENA = [
  {
    // Asesoría → PSP-F-007 + los DOS modelos de informe (tipo A y tipo B).
    numero: '2247118', fecha: '2026-09-04', hora: '08:00 AM',
    nit: '900874016', empresa: 'CURTIEMBRES DEL NORTE S A S', afiliacion: '1071204',
    ciudad: 'pasto',
    lineaServicio: 'Línea Prevención y Gestión del ATEL',
    programa: 'Programa Riesgo Químico',
    componente: 'Asesoría',
    actividad: 'Asesoría en control de exposición a sustancias químicas',
    horas: 6,
    obs: 'ASESORIA EN SEDE. CONTACTO: SANDRA MILENA ORTEGA (COORD. SGSST) 314 3398871 sgsst@curtiembresdelnorte.co',
    viaticos: null,
  },
  {
    // Capacitación → PSP-F-007 + registro de ejecución + evaluación + plantilla.
    // Fuera de la ciudad: el bloque de gastos de desplazamiento va diligenciado.
    numero: '2247203', fecha: '2026-09-05', hora: '02:00 PM',
    nit: '901620877', empresa: 'FRIGORIFICO DEL PACIFICO S A', afiliacion: '1088435',
    ciudad: 'tumaco',
    lineaServicio: 'Línea Prevención y Gestión del ATEL',
    programa: 'Programa Seguridad Vial',
    componente: 'Formacion',
    actividad: 'Capacitación a conductores y personal de reparto',
    horas: 4,
    obs: 'ACTIVIDAD FUERA DE LA CIUDAD. AUTORIZA GASTOS DE DESPLAZAMIENTO POR $ 165.000. CONTACTO: YENNY ALEXANDRA CAICEDO 318 1123409 sst@frigorificopacifico.com.co',
    viaticos: {
      cc: '1085302144', nombre: 'DIEGO ARMANDO NARVAEZ', origen: 'PASTO', destino: 'TUMACO',
      fechaViaje: '05/09/2026', horaViaje: '05:00 AM', horasTecnicas: '4',
      alojamiento: 'SI', traslado: 'Terrestre', observaciones: 'SALIDA VISPERA - REGRESO MISMO DIA',
    },
  },
];

async function generarPdfColmena(o) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);            // carta vertical, como la real
  const normal = await doc.embedFont(StandardFonts.Helvetica);
  const negrita = await doc.embedFont(StandardFonts.HelveticaBold);
  const negro = rgb(0.1, 0.1, 0.1);

  const texto = (t, x, y, { size = 8, font = normal, color = negro } = {}) =>
    page.drawText(String(t), { x, y, size, font, color });
  const caja = (x, y, w, h) =>
    page.drawRectangle({ x, y, width: w, height: h, borderWidth: 0.7, borderColor: rgb(0.55, 0.55, 0.55) });

  // --- Encabezado ---
  texto('COLMENA SEGUROS', 42, 752, { size: 12, font: negrita });
  texto('Fecha Impresión', 470, 752, { size: 7 });
  texto('INFORME DE PRESTACION DE SERVICIOS DE', 150, 738, { size: 10, font: negrita });
  texto('PREVENCION Y PROMOCION - PROVEEDORES', 150, 726, { size: 10, font: negrita });
  texto(`${fechaCO(o.fecha)} 09:36 AM`, 470, 738, { size: 7 });

  caja(42, 690, 528, 26);
  texto('FECHA DE VISITA Y/O PRESTACION DEL SERVICIO', 46, 704, { size: 7, font: negrita });
  texto('HORA', 250, 704, { size: 7, font: negrita });
  texto(`No. ORDEN DE SERVICIO: ${o.numero}`, 330, 704, { size: 8, font: negrita });
  texto(fechaCO(o.fecha), 46, 694, { size: 8 });
  texto(o.hora, 250, 694, { size: 8 });

  texto('NOTA: DILIGENCIAR DE FORMA CLARA Y CON LETRA LEGIBLE. NO SE ADMITEN TACHONES NI ENMENDADURAS',
    42, 678, { size: 6.5 });

  // --- Empresa ---
  caja(42, 636, 528, 34);
  texto('NIT/NOMBRE DE LA EMPRESA', 46, 660, { size: 7, font: negrita });
  texto(`${o.nit} - ${o.empresa} - ${o.afiliacion}`, 46, 644, { size: 9 });

  caja(42, 600, 528, 30);
  texto('CIUDAD DE EJECUCION DE LA ACTIVIDAD', 46, 620, { size: 7, font: negrita });
  texto(o.ciudad, 46, 606, { size: 9 });

  // --- Actividad ---
  caja(42, 520, 528, 74);
  texto('DESCRIPCION DE LA ACTIVIDAD', 46, 584, { size: 7, font: negrita });
  texto(`Línea: ${o.lineaServicio}`, 46, 572, { size: 8 });
  texto('Cantidad (Horas, exámenes, cursos, etc.)', 330, 572, { size: 6.5, font: negrita });
  texto(`Programa: ${o.programa}`, 46, 562, { size: 8 });
  texto('Solicitada', 340, 560, { size: 6.5 });
  texto('Ejecutada', 450, 560, { size: 6.5 });
  texto(`Componente: ${o.componente}`, 46, 552, { size: 8 });
  texto('(En la orden de servicios)', 320, 550, { size: 6 });
  texto('(En la sesión programada)*', 430, 550, { size: 6 });
  texto(`Actividad: ${o.actividad}`, 46, 540, { size: 8 });
  texto(cantidad(o.horas), 360, 528, { size: 10, font: negrita });

  // --- Observaciones ---
  caja(42, 452, 528, 62);
  texto('OBSERVACIONES Y RECOMENDACIONES DEL PROVEEDOR Y/O DEL CLIENTE', 46, 504, { size: 7, font: negrita });
  // El texto se parte a mano: el bloque de la orden real es de ancho fijo.
  o.obs.match(/.{1,110}(\s|$)/g).forEach((l, i) => texto(l.trim(), 46, 490 - i * 11, { size: 7 }));

  // --- Gastos de desplazamiento (la sección que respalda los viáticos) ---
  caja(42, 366, 528, 78);
  texto('PARA AUTORIZACION DE GASTOS DE DESPLAZAMIENTO', 46, 434, { size: 7, font: negrita });
  const cx = [46, 106, 196, 246, 296, 336, 376, 414, 452, 512];
  const cab1 = ['CC. PERSONA', 'NOMBRE', 'CIUDAD', 'CIUDAD', 'FECHA', 'HORA', 'No Horas', 'ALOJAM', 'TIPO TRASLADO', 'OBSERV.'];
  const cab2 = ['QUE VIAJÓ', '', 'ORIGEN', 'DESTINO', 'VIAJE', 'VIAJE', 'técnicas', 'SI/NO', 'Terrestre/Aéreo', ''];
  cab1.forEach((c, i) => texto(c, cx[i], 422, { size: 5.5, font: negrita }));
  cab2.forEach((c, i) => c && texto(c, cx[i], 414, { size: 5.5, font: negrita }));

  if (o.viaticos) {
    const v = o.viaticos;
    const val = [v.cc, v.nombre.slice(0, 24), v.origen, v.destino, v.fechaViaje,
      v.horaViaje, v.horasTecnicas, v.alojamiento, v.traslado, ''];
    val.forEach((c, i) => texto(c, cx[i], 400, { size: 5.5 }));
    texto(v.observaciones, 46, 386, { size: 5.5 });
  }

  // --- Firmas ---
  caja(42, 210, 528, 148);
  texto('CAMPOS PARA FIRMA DEL PROVEEDOR DE Colmena Seguros', 46, 348, { size: 7, font: negrita });
  texto('PERSONA NATURAL', 46, 332, { size: 7 });
  texto('cc', 160, 332, { size: 7 });
  texto('PERSONA JURIDICA', 300, 332, { size: 7 });
  texto('RAZON SOCIAL DEL PROVEEDOR', 46, 310, { size: 7, font: negrita });
  texto(`${PROVEEDOR.nit} - JD&D CONSULTORES EN ________________________`, 46, 294, { size: 8 });
  texto('NOMBRE DEL PROFESIONAL ______________________________________ FIRMA', 46, 268, { size: 7 });
  texto('PARA DILIGENCIAR POR EL CLIENTE', 46, 246, { size: 7, font: negrita });
  texto('NOMBRE RESPONSABLE EN EMPRESA CLIENTE', 46, 232, { size: 7 });
  texto('________________________________________________________________', 46, 220, { size: 7 });

  texto('CARGO _____________________________________________________', 46, 196, { size: 7 });
  texto('TELEFONO ___________________________________________________________', 46, 176, { size: 7 });
  texto('*Nota: Previo a la firma de este documento agradecemos validar que la cantidad registrada como "ejecutada" corresponda.',
    46, 150, { size: 6 });
  texto('FIRMA Y SELLO', 470, 150, { size: 6, font: negrita });
  texto('SPM-F 38V2 03/2017', 46, 120, { size: 6 });

  return doc.save();
}

// ===========================================================================

/**
 * Nombre legible de cada formato, solo para redactar el README. El registro de
 * verdad —qué archivo es y cómo se rellena— está en `formatos-arl.service.js`,
 * que no se importa aquí porque arrastra los assets.
 */
const ETIQUETA_FORMATO = {
  at031: 'AT-031',
  at028: 'AT-028',
  informeBolivar: 'informe de gestión (.docx)',
  asistentesAxa: 'Registro de asistentes',
  fichaAxa: 'Ficha de gestión',
  informeAxa: 'Informe técnico (.docx)',
  prestacionColmena: 'PSP-F-007',
  asistenciaColmena: 'PSP-F-006 asistencia',
  evaluacionColmena: 'PSP-F-010 evaluación',
  registroEjecucionColmena: 'Registro de ejecución (.xls)',
  plantillaColmena: 'Plantilla (.pptx)',
  informeColmenaA: 'Informe tipo A (.docx)',
  informeColmenaB: 'Informe tipo B (.docx)',
};

/**
 * Lo que la matriz REAL decide para esta orden. Se le pregunta al servicio en
 * vez de escribirlo a mano: si mañana cambia una regla, el README cambia con
 * ella y no se enseña en una reunión una tabla que ya no es verdad.
 */
function entrega(orden) {
  const e = entregaDeLaOrden(orden);
  return {
    formatos: e.formatos.map((f) => ETIQUETA_FORMATO[f] ?? f).join(' + '),
    soportes: e.soportes.join(', '),
    respaldo: e.porRespaldo,
  };
}

/** La orden de Bolívar tal como queda tras importar el SIPAB y marcar la modalidad. */
const ordenBolivar = (o) => ({
  arl_nombre: 'Bolívar', tipo_servicio_arl: o.letra,
  modalidad_ejecucion: o.modalidadDemo, horas_asignadas: o.horas,
  tipo_actividad: o.actividad,
});

/** La orden de AXA / Colmena: sin letra, el tipo sale del título de la actividad. */
const ordenPdf = (arl, titulo, horas) => ({
  arl_nombre: arl, horas_asignadas: horas, tipo_actividad: titulo,
});

/** El guion de la demo, para no tener que reconstruirlo delante del cliente. */
function readme(nombresAxa, nombresColmena) {
  const bol = ORDENES_BOLIVAR.map((o, i) => {
    const t = totalViaticos(o.viaticos);
    const e = entrega(ordenBolivar(o));
    return `| ${i + 1} | ${o.razon} | \`${o.letra}\` | ${o.modalidadDemo} | ${o.horas} h | ` +
           `${t ? pesos(t) : '—'} | ${e.formatos}${e.respaldo ? ' *(respaldo)*' : ''} | ${e.soportes} |`;
  }).join('\n');

  const axa = ORDENES_AXA.map((o, i) => {
    const e = entrega(ordenPdf('AXA Colpatria', o.actividad, o.horas));
    return `| \`${nombresAxa[i]}\` | ${o.actividad} | ${o.horas} h | ${e.formatos} | ${e.soportes} |`;
  }).join('\n');

  const col = ORDENES_COLMENA.map((o, i) => {
    const e = entrega(ordenPdf('Colmena', o.actividad, o.horas));
    return `| \`${nombresColmena[i]}\` | ${o.componente} · ${o.horas} h | ${e.formatos} | ${e.soportes} |`;
  }).join('\n');

  return `# Órdenes de demostración · peticiones del 22-ago-2026

Generadas por \`sst_ws/scripts/generar-ordenes-demo-peticiones.mjs\` (\`node scripts/generar-ordenes-demo-peticiones.mjs\`).
**Todos los datos son inventados** — empresas, NIT, personas, teléfonos y
correos no existen. Esta carpeta está en \`.gitignore\`.

Cada orden está construida para disparar UNA rama concreta de las peticiones
nuevas. El diseño de cada fase está en \`docs/plan-peticiones-22-ago-2026.md\`.

> Las columnas **Formatos** y **Soportes** de las tablas de abajo no están
> escritas a mano: se las pregunta el generador a \`entrega-arl.service.js\`, que
> es la misma matriz que corre al asignar. Es lo que va a pasar de verdad.

---

## 0. Antes de la demo: dos cosas que hay que dejar creadas

Sin esto se enseñan dos peticiones a medias, y no por culpa de las órdenes.

**1. El catálogo de viáticos** (Configuración → *Preferencias del sistema*).
\`sst.tipos_viatico\` **nace vacío** (D-10) y desde el ajuste del 23-ago los
viáticos **se eligen de un catálogo, no se escriben** (§10.4): si no hay
categorías, la única opción al cargar una orden es *"No aplica"* y la OS se
guarda **sin viáticos**, aunque el Excel de Bolívar traiga la cifra. Cree estas
cinco, que son las que piden estas órdenes:

| Categoría | Valor | Para qué orden |
|---|---|---|
| Transporte urbano | $ 21.020 | Bolívar 1 |
| Desplazamiento 2 días (transporte + alojamiento + alimentación) | $ 220.000 | Bolívar 3 |
| Desplazamiento intermunicipal | $ 32.500 | Bolívar 6 |
| Desplazamiento 3 días | $ 240.000 | AXA 2 |
| Desplazamiento Pasto–Tumaco | $ 165.000 | Colmena 2 |

⚠️ Con una categoría elegida **manda el catálogo**, no el documento (D-11). Lo
que trae el SIPAB sobrevive en \`viaticos_detalle\` y es lo que la vista previa
enseña como pista de dónde salió la cifra — que es justo lo que conviene
señalar en la reunión: el desglose se conserva para justificarlo ante la ARL,
pero el importe lo fija JD&D para que dos desplazamientos iguales valgan igual.

**2. Marcar profesionales como registrados ante Bolívar** (Profesionales →
*Registro ante las ARL*): deje **uno sin marcar** —será quien ejecute— y **otro
marcado**, que es a nombre de quien saldrán los formatos. La tabla nace vacía y
sin ella la suplencia no se puede enseñar. Hoy el registro es solo una marca:
ARL · ¿Registrado? · Observación (§10.8).

---

## 1. Bolívar · \`Bolivar/demo-bolivar-sipab.xlsx\`

Un solo Excel con formato SIPAB y **seis órdenes**. Se sube entero desde
*Importar* y salen los seis borradores de una pasada.

| # | Empresa | Tipo Servicio | Modalidad a marcar | Horas | Viáticos del SIPAB | Formatos que se envían | Soportes que se piden |
|---|---|---|---|---|---|---|---|
${bol}

**Qué enseña cada fila, en este orden:**

1. **Capacitación presencial con viáticos** — petición 2 (el *Tipo de actividad
   ARL* llega **ya elegido en \`C\`** desde la columna del SIPAB: nadie lo
   teclea, y de ahí sale la casilla marcada del AT-031), petición 4 (se marca
   PRESENCIAL en el análisis previo, y es obligatorio) y petición 1 (la vista
   previa enseña los $ 21.020 que traía el Excel; se elige la categoría
   *Transporte urbano*). El correo al profesional lleva **AT-031 + AT-028**.
2. **Capacitación virtual** — la misma letra \`C\`, pero al marcar VIRTUAL el
   correo sale **sin el AT-028** y el portal **deja de pedir la lista de
   asistencia**: lo prohíbe el comunicado SNPARL-40035219-2025. Es la fila que
   demuestra que el presencial/virtual no es un adorno. Compárela con la 1: son
   la misma letra y devuelven casillas distintas.
3. **Asistencia técnica fuera de la ciudad** — letra \`T\`: se adjunta el
   **informe de gestión** y en su lugar se pide la casilla *informe*, sin
   registro fotográfico. Viáticos con desglose real (transporte + alojamiento +
   alimentación = $ 220.000), que en la cuenta de cobro salen separados de los
   honorarios.
   👉 **Es la orden para demostrar la petición 3**: asígnela a un profesional
   **no registrado** ante Bolívar y marque los formatos a nombre de uno que sí
   lo esté. El correo y el enlace de soportes van al que ejecuta; el AT-031 sale
   con el nombre del registrado.
4. **Asesoría** — letra \`A\`: solo AT-031, y una sola casilla de vuelta. Los
   asistentes se firman dentro del propio AT-031.
5. **Servicio especializado** — letra \`E\`: no hay regla propia, así que cae en
   el **respaldo** de Bolívar y la asignación avisa de ello. Sirve para enseñar
   que una letra sin detallar **no** deja al profesional sin papeles… y para
   pedirle al cliente que diga qué quiere en E, M y O.
6. **Otros / servicio de salud** — letra \`O\`, y viáticos donde la ARL **solo**
   informa \`Valor Desplazamiento\` ($ 32.500). Es el caso de la decisión D-9 y
   el segundo que cae en el respaldo.

**Petición 6 (estado de facturación):** las órdenes 1, 3 y 4 llevan
\`LOTE FACTURACION AGO-2026\` en las observaciones. Llévelas a **FINALIZADA** y
márquelas desde el **icono de facturación de la fila** en \`/ordenes\` —es el
único camino, ya no hay marcado en lote (§10.1)—. Son **dos estados**,
\`NO FACTURADA\` y \`FACTURADA\` (D-7 cerrada, §10.2). Deje una sin marcar: al
abrir la pestaña **«Cobradas»** se ve que el eje de cobro va por su cuenta y no
es un estado más del ciclo de la orden.

---

## 2. AXA Colpatria · \`Colpatria/\`

Tres PDF, uno por rama del corte de 16 horas (petición 5).

| Archivo | Actividad | Horas | Formatos que se envían | Soportes que se piden |
|---|---|---|---|---|
${axa}

Las dos primeras son **la misma asesoría con distinta duración** y llegan con
juegos de formatos distintos: es la forma más corta de enseñar el corte de 16.

La segunda además se ejecuta en Mocoa y trae en las observaciones
\`AUTORIZA GASTOS DE DESPLAZAMIENTO POR $ 240.000\`. En AXA los viáticos **no
tienen columna** en el documento: se elige la categoría *Desplazamiento 3 días*
en el modal de revisión (petición 1). El correo del profesional los anuncia y la
cuenta de cobro los separa de los honorarios.

⚠️ En AXA y Colmena el **Tipo de actividad ARL** (Asesoría / Capacitación) hay
que **elegirlo en la vista previa: es obligatorio** desde el 24-ago (§10.12), y
sin él el borrador no valida. El título de estas órdenes (\`ASE …\`, \`CAP …\`)
solo actúa de respaldo. Merece la pena decirlo en la reunión junto a la otra
mitad de la decisión: el **tipo de orden** del catálogo ya **no** interviene en
los formatos — solo fija el valor de la hora que se le paga al profesional
(D-8, cerrada).

---

## 3. Colmena · \`Colmena/\`

Dos PDF con el formato SPM-F 38V2, que en esta ARL hace de orden de servicio.

| Archivo | Actividad | Formatos que se envían | Soportes que se piden |
|---|---|---|---|
${col}

La segunda trae **el bloque de gastos de desplazamiento diligenciado** (Pasto →
Tumaco, con alojamiento y traslado terrestre) y $ 165.000 en las observaciones:
es el único documento de las tres ARL que respalda los viáticos con un formato
propio (§2.5 del plan).

Aquí también hay que **elegir el Tipo de actividad ARL** en la vista previa, y
por la misma razón que en AXA.

---

## Orden sugerido de la presentación

0. Dejar creado el catálogo de viáticos y marcados los registros ante Bolívar
   (§0 de este archivo). Sin esto, los pasos 1 y 3 se quedan cortos.
1. Subir el Excel de Bolívar → seis borradores con el **tipo de actividad ya
   elegido** y la cifra de viáticos del SIPAB a la vista; marcar la modalidad y
   elegir la categoría de viático (peticiones 1, 2 y 4).
2. Asignar la fila 1 (presencial) y la 2 (virtual) → comparar los adjuntos de
   los dos correos y las casillas del portal: la virtual va sin AT-028 y no pide
   lista de asistencia (peticiones 4 y 5).
3. Asignar la fila 3 con **suplente** → el correo, el \`.ics\` y el enlace de
   soportes le llegan a quien ejecuta; el AT-031 sale con el nombre del
   registrado (petición 3).
4. Subir los dos PDF de asesoría de AXA (12 h y 24 h) → mismo tipo, distinto
   juego de formatos por las horas; categoría de viático en el de 24 h
   (peticiones 1 y 5).
5. Subir los dos de Colmena → tercera ARL, tercer juego de formatos, y el
   respaldo de viáticos del PSP-F-007 (petición 5).
6. Finalizar las órdenes del \`LOTE FACTURACION AGO-2026\`, marcar dos como
   FACTURADAS desde el icono de la fila y abrir la pestaña **Cobradas**
   (petición 6).
`;
}

async function main() {
  await mkdir(DIR_BOL, { recursive: true });
  await mkdir(DIR_AXA, { recursive: true });
  await mkdir(DIR_COL, { recursive: true });

  console.log('== Órdenes de demostración · peticiones 22-ago-2026 (datos inventados) ==\n');

  const xlsx = 'demo-bolivar-sipab.xlsx';
  await writeFile(path.join(DIR_BOL, xlsx), await generarExcelBolivar());
  console.log(`  XLSX  Bolivar/${xlsx.padEnd(46)} ${ORDENES_BOLIVAR.length} órdenes · letras ${ORDENES_BOLIVAR.map((o) => o.letra).join('/')}`);

  const nombresAxa = [];
  for (const [i, o] of ORDENES_AXA.entries()) {
    const slug = o.empresa.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 34);
    const nombre = `demo-axa-${String(i + 1).padStart(2, '0')}-${slug}.pdf`;
    await writeFile(path.join(DIR_AXA, nombre), await generarPdfAxa(o));
    nombresAxa.push(nombre);
    console.log(`  PDF   Colpatria/${nombre.padEnd(44)} ${cantidad(o.horas)} h · ${o.actividad.slice(0, 3)} · ${o.ciudad}`);
  }

  const nombresColmena = [];
  for (const [i, o] of ORDENES_COLMENA.entries()) {
    const slug = o.empresa.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 34);
    const nombre = `demo-colmena-${String(i + 1).padStart(2, '0')}-${slug}.pdf`;
    await writeFile(path.join(DIR_COL, nombre), await generarPdfColmena(o));
    nombresColmena.push(nombre);
    console.log(`  PDF   Colmena/${nombre.padEnd(46)} ${cantidad(o.horas)} h · ${o.componente} · ${o.ciudad}`);
  }

  await writeFile(path.join(RAIZ, 'README.md'), readme(nombresAxa, nombresColmena));
  console.log(`  MD    README.md${' '.repeat(50)}guion de la demo\n`);
  console.log(`Todo en → ${RAIZ}`);
  console.log('No se procesó ninguno: quedan listos para subirlos desde Importar.');
}

main().catch((e) => { console.error('✖', e); process.exit(1); });
