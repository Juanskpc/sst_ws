/**
 * Genera un «Reporte estado de las tareas» de ARL SURA con datos INVENTADOS (empresas, asesores y números de
 * orden que no existen), a partir de la estructura real de 21 columnas. Sirve para demos, videos del centro de
 * ayuda y pruebas sin mostrar clientes reales.
 *   node scripts/generar-orden-sura-demo.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

const salida = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '2-pruebas', 'ordenes', 'sura', 'demo-sura-estado-tareas.xlsx');
const ENCABEZADOS = ['ORDEN', 'FECHA APROBACION OC ', 'FECHA NTREGA INICIAL DE LA OC', 'FECHA ENTREGA FINAL DE LA OC', 'CONTRATO', 'EMPRESA', 'TAREA', 'PRODUCTO',
  'CLASIFICACION', 'PROFESIONAL', 'PRESTADOR', 'CANTIDAD PEDIDA', 'CANTIDAD SIN PROGRAMAR', 'CANTIDAD PROGRAMADA', 'CANTIDAD CUMPLIDA',
  'CANTIDAD FACTURADA DISTRIBUIDOR', 'CANTIDAD PAGADA ARL SURA', 'ESTADO DE LA TAREA', 'FACTURA PROVEEDOR', 'CENTRO DE TRABAJO', 'OBSERVACIONES DE LA ORDEN'];
const P = '170-SISTEMA DE GESTIÓN EN SST';
const filas = [
  ['10995011', 'ALMACENES LA ESPERANZA S.A.S', 'PRACTICAS SEGURAS', P, 'CAPACITACIÓN', 4, 'BODEGA CENTRAL', ''],
  ['10995012', 'CLÍNICA DEL VALLE DEMO S.A.S', 'PLAN DE PREPARACION Y RESPUESTA ANTE EMERGENCIAS', '112-PLAN DE PREVENCION, PREPARACION Y RESPUESTA ANTE EMERGENCIAS', 'ASESORÍA', 6, 'AUXILIAR DE ENFERMERIA', 'ASESORÍA Y ACOMPAÑAMIENTO PARA EL SIMULACRO.'],
  ['10995013', 'TRANSPORTES ANDINOS DEMO LTDA', 'PRACTICAS SEGURAS', P, 'CAPACITACIÓN', 2, 'CONDUCTOR', ''],
  ['10995014', 'CONSTRUCTORA MONTAÑA DEMO S.A.', 'INSPECCIONES DE SEGURIDAD', '115-INSPECCIONES DE SEGURIDAD', 'ASESORÍA', 8, 'OBRA PRINCIPAL', ''],
  ['10995015', 'COLEGIO NUEVO HORIZONTE DEMO', 'PRACTICAS SEGURAS', P, 'CAPACITACIÓN', 3, 'DOCENTES', ''],
  ['10995016', 'PANADERÍA EL TRIGAL DEMO S.A.S', 'PROGRAMA O PROCEDIMIENTO PARA LA GESTION DEL RIESGO', '120-GESTION DEL RIESGO', 'ASESORÍA', 6, 'PRODUCCION', ''],
];
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('ESTADO TAREA');
ws.addRow(['REPORTE ESTADO DE LAS TAREAS']);
ws.addRow([]);
ws.addRow(ENCABEZADOS);
for (const [orden, empresa, tarea, producto, clasif, horas, centro, obs] of filas) {
  ws.addRow([orden, '2026/10/20', '2026/11/01', '2026/11/30', '099900001', empresa, tarea, producto, clasif, 'PROFESIONAL DEMO UNO', 'PRESTADOR DEMO',
    String(horas.toFixed(1)), '0.0', String(horas.toFixed(1)), '0.0', '0.0', '0.0', 'PROGRAMADA', '', centro, obs]);
}
fs.mkdirSync(path.dirname(salida), { recursive: true });
await wb.xlsx.writeFile(salida);
console.log('escrito', salida);
