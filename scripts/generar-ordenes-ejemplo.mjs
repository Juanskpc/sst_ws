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
 * redacción importan: `HEADER_MAP` de `extraction.service.js` los reconoce por
 * texto, y una columna renombrada deja de mapearse al campo canónico.
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

const FILAS_SIPAB = [
  ['901455780', 'TRANSPORTES ANDINA DEL SUR S A S', 'CAP TRABAJO SEGURO EN ALTURAS', 8,  '2026-08-18', 'PASTO',     'ANDRES FELIPE OSORIO'],
  ['900874312', 'AGROINDUSTRIAS EL MIRADOR LTDA',   'CAP RIESGO QUIMICO',            4,  '2026-08-19', 'IPIALES',   'MARTHA LUCIA BURBANO'],
  ['901662045', 'CONFECCIONES LA PRIMAVERA S A S',  'INSPECCION DE PUESTOS DE TRABAJO', 6, '2026-08-20', 'TUQUERRES', 'JAIRO ANTONIO CUARAN'],
  ['890301774', 'LACTEOS SAN FERNANDO S A',         'CAP SEGURIDAD VIAL',           10, '2026-08-21', 'PASTO',     'FELIPE VARGAS TORRES'],
  ['901208955', 'CONSTRUCTORA VALLE VERDE S A S',   'CAP MANEJO MANUAL DE CARGAS',  12, '2026-08-24', 'TUMACO',    'GLORIA ESPERANZA MINA'],
  ['900556128', 'DISTRIBUIDORA NARIÑO EXPRESS LTDA','MEDICION DE ILUMINACION',       3, '2026-08-25', 'PASTO',     'CARLOS EDUARDO BENAVIDES'],
  ['901733460', 'CLINICA SANTA ISABEL S A S',       'CAP RIESGO BIOLOGICO',         16, '2026-08-26', 'IPIALES',   'RUBEN DARIO CHAVES'],
  ['900912337', 'METALMECANICA DEL PACIFICO S A S', 'CAP RIESGO MECANICO',           5, '2026-08-27', 'TUMACO',    'YENNY ALEXANDRA CAICEDO'],
  ['901044219', 'PANIFICADORA EL TRIGAL LTDA',      'CAP HIGIENE POSTURAL',          4, '2026-08-28', 'PASTO',     'LINA MARCELA JOJOA'],
  ['900733015', 'HOTELES DEL SUR S A S',            'CAP PREVENCION DE INCENDIOS',   6, '2026-08-31', 'IPIALES',   'EDWIN ALEXANDER RUANO'],
];

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

  FILAS_SIPAB.forEach(([nit, razon, actividad, horas, fecha, ciudad, profesional], i) => {
    const fila = new Array(cabeceras.length).fill('');
    fila[0] = nit;
    fila[1] = razon;
    fila[2] = 'Activa';
    fila[3] = 'NO';
    fila[4] = String(1370500 + i);                 // Numero Cronograma  → codigo_cronograma
    fila[5] = String(10 + i);                      // Actividad Cronograma → secuencia
    fila[6] = actividad;                           // Actividad Programa → actividad_economica
    fila[7] = 'Programada';
    fila[8] = 'HORAS';
    fila[9] = horas;                               // Act Programadas → horas_asignadas
    fila[10] = 0;
    fila[11] = 0;
    fila[12] = 0;
    fila[13] = 0;
    fila[15] = 'ASESORIA';
    fila[16] = 15 + i;
    fila[17] = fecha;                              // Fecha Programada → fecha_orden
    fila[20] = '08:00';
    fila[22] = 'EMPRESA';
    fila[30] = '901203812';
    fila[31] = PROVEEDOR.nombre;
    fila[33] = profesional;                        // Nombre Profesional → contacto_sst_nombre
    fila[35] = 'CLAUDIA RESTREPO';
    fila[37] = 'JORGE ENRIQUE MORA';
    fila[38] = `Actividad de ejemplo generada para pruebas · ${ciudad}`;
    fila[39] = `POL-${20260 + i}`;
    fila[40] = ciudad;                             // Ubicacion Actividad → ciudad_ejecucion
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
