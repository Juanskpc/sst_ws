// 8-oct-2026 · Verifica el módulo de nómina de punta a punta SIN hablar con el proveedor:
// ficha del empleado, borrador, y sobre todo la EMISIÓN y la ANULACIÓN con un proveedor
// simulado que reproduce lo que se vio en el ambiente de pruebas (validada a la primera,
// 500 y luego validada, rechazo de la DIAN, sin respuesta, negativa 403).
//
//   node --import tsx scripts/verificar-nomina.mjs
//
// Crea un tercero, un empleado y sus liquidaciones de prueba y los BORRA al terminar.
// No envía nada a ningún sitio.
import { pool } from '../src/config/db.js';
import { proveedorFE } from '../src/modules/facturacion/index.js';
import { FactusError } from '../src/modules/facturacion/adaptadores/factus.cliente.js';
import fs from 'node:fs';
import { pdfDesprendible } from '../src/modules/nomina/desprendible.service.js';
import { actualizarEmpleado, crearEmpleado, listarEmpleados } from '../src/modules/nomina/empleados.service.js';
import {
  actualizarLiquidacion, anularLiquidacion, crearLiquidacion, eliminarLiquidacion, emitirLiquidacion, obtenerLiquidacion, previaLiquidacion,
} from '../src/modules/nomina/liquidaciones.service.js';

let fallos = 0;
const comprobar = (ok, texto) => { console.log(`${ok ? '✓' : '✗'} ${texto}`); if (!ok) fallos += 1; };
const debeFallar = async (fn, texto) => {
  try { await fn(); comprobar(false, `${texto} (no falló)`); } catch (e) { comprobar((e.statusCode ?? 500) < 500, `${texto} → «${e.message.slice(0, 110)}»`); }
};

// ── Proveedor simulado: se sustituyen los tres métodos que usa la nómina.
const fe = proveedorFE();
const llamadas = { emitir: [], eliminar: [], nota: [] };
let guion = [];
const validada = (d, n) => ({ referenceCode: d.referenceCode, numeroDocumento: n, validado: true, cufe: `${n}-${CUNE}`.slice(0, 96), urlPublica: 'https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=prueba', eventos: { rechazos: [], avisos: [] }, respuestaCruda: {} });
const CUNE = '49ec491f4242f1582a06d0999f907ab753c270c56acd421d7f8849b75b3d4ba9fd3bfa50e448a772e67821882a354b34';
fe.emitirNominaElectronica = async (datos) => {
  llamadas.emitir.push(datos.referenceCode);
  fe.cuerpoNomina(datos); // el cuerpo real tiene que poder armarse con lo que manda el servicio
  const paso = guion.shift();
  if (!paso) throw new Error('guion agotado');
  return paso(datos);
};
fe.eliminarNominaNoValidada = async (ref) => { llamadas.eliminar.push(ref); };
fe.emitirNotaAjusteNomina = async (datos) => { llamadas.nota.push(datos); return { ...validada(datos, 'NAN9'), numeroDocumento: 'NAN9' }; };
const error500 = () => { throw new FactusError({ status: 500, mensaje: 'Ha ocurrido un error inesperado, vuelve a intentarlo' }); };
const rechazoDian = () => { throw new FactusError({ status: 422, mensaje: 'El documento contiene errores de validación', detalle: ['Regla: NIE045, Rechazo: Debe ir el Numero de documento del trabajador'] }); };
const negativa403 = () => { throw new FactusError({ status: 403, mensaje: 'La empresa no tiene habilitada la creación de este documento', detalle: { status: 'Forbidden', message: 'x' } }); };

const DOC = '1099887766';
let terceroId = null;
let empleadoId = null;
try {
  const usuario = (await pool.query(`SELECT id FROM sst.usuarios ORDER BY creado_en LIMIT 1`)).rows[0].id;
  const td = (await pool.query(`SELECT id FROM sst.tipos_documento_identidad WHERE codigo_dian = '13'`)).rows[0].id;
  const mun = (await pool.query(`SELECT id FROM sst.municipios WHERE codigo_dian = '52001'`)).rows[0].id;
  await pool.query(`DELETE FROM sst.terceros WHERE numero_documento = $1 AND NOT EXISTS (SELECT 1 FROM sst.empleados e WHERE e.tercero_id = sst.terceros.id)`, [DOC]);
  terceroId = (await pool.query(
    `INSERT INTO sst.terceros (tipo_persona, tipo_documento_id, numero_documento, nombres, apellidos, direccion, municipio_id, es_proveedor)
     VALUES ('NATURAL', $1, $2, 'ANA MARIA', 'PRUEBA NOMINA', 'CALLE 1 2-3', $3, true) RETURNING id`, [td, DOC, mun],
  )).rows[0].id;

  // ── Empleado
  await debeFallar(() => crearEmpleado({ tercero_id: terceroId, salario: 2_400_000, fecha_ingreso: '2024-02-01', metodo_pago: '47' }, usuario), 'transferencia sin banco ni cuenta');
  const emp = await crearEmpleado({ tercero_id: terceroId, cargo: 'Auxiliar', salario: 2_400_000, fecha_ingreso: '2024-02-01', metodo_pago: '47', banco: 'Bancolombia', tipo_cuenta: '2', numero_cuenta: '852-000 123' }, usuario);
  empleadoId = emp.id;
  comprobar(emp.numero_cuenta === '852000123' && emp.faltantes.length === 0, 'empleado creado; la cuenta queda solo con dígitos y no le falta nada');
  comprobar((await pool.query(`SELECT es_empleado FROM sst.terceros WHERE id = $1`, [terceroId])).rows[0].es_empleado, 'el tercero queda marcado como empleado');
  await debeFallar(() => crearEmpleado({ tercero_id: terceroId, salario: 1, fecha_ingreso: '2024-02-01', metodo_pago: '10' }, usuario), 'segunda ficha para la misma persona');
  comprobar((await listarEmpleados()).some((e) => e.id === emp.id), 'aparece en la lista');

  // ── Borrador y validaciones propias
  const base = { empleado_id: emp.id, anio: 2026, fecha_pago: '2026-09-30' };
  const nov = { horas: [{ tipo: 'HED', cantidad: 6, inicio: '2026-09-03T17:00', fin: '2026-09-03T23:00' }], vacaciones: [{ dias: 5, inicio: '2026-09-14', fin: '2026-09-18' }], comisiones: 300000 };
  const previa = await previaLiquidacion({ ...base, mes: 9, novedades: nov });
  comprobar(previa.liquidacion.totales.neto === 2770436.32 && previa.novedades.horas[0].inicio === '2026-09-03 17:00:00', `vista previa: neto ${previa.liquidacion.totales.neto}; la hora se guarda con espacio`);
  await debeFallar(() => previaLiquidacion({ ...base, mes: 12, novedades: {} }), 'mes que todavía no empieza');
  await debeFallar(() => previaLiquidacion({ ...base, anio: 2024, mes: 1, novedades: {} }), 'año sin parámetros cargados');
  await debeFallar(() => crearLiquidacion({ ...base, mes: 9, novedades: { vacaciones: [{ dias: 30 }] } }, usuario), 'mes completo de vacaciones');
  await debeFallar(() => crearLiquidacion({ ...base, mes: 9, novedades: { horas: [{ tipo: 'HED', cantidad: 2.5 }] } }, usuario), 'horas con fracción');
  const l1 = await crearLiquidacion({ ...base, mes: 9, novedades: nov }, usuario);
  comprobar(l1.estado === 'BORRADOR' && Number(l1.neto) === 2770436.32, 'borrador de septiembre guardado');
  await debeFallar(() => crearLiquidacion({ ...base, mes: 9, novedades: {} }, usuario), 'segunda nómina del mismo mes');
  const l1b = await actualizarLiquidacion(l1.id, { fecha_pago: '2026-09-30', novedades: { ...nov, comisiones: 0 } }, usuario);
  comprobar(Number(l1b.neto) < Number(l1.neto), 'cambiar las novedades vuelve a liquidar');

  // ── Emisión 1: el proveedor responde 500 y, al repetir con la MISMA referencia, valida.
  guion = [error500, (d) => validada(d, 'NEF901')];
  const v1 = await emitirLiquidacion(l1.id, usuario);
  comprobar(v1.estado === 'VALIDADO' && v1.numero === 'NEF901' && v1.cune.startsWith('NEF901-'), 'emisión: 500 y luego validada → VALIDADO con número y CUNE');
  comprobar(llamadas.emitir.length === 2 && llamadas.emitir[0] === llamadas.emitir[1], 'el reintento usó la misma referencia');
  await debeFallar(() => emitirLiquidacion(l1.id, usuario), 'emitir una ya validada');
  await debeFallar(() => actualizarLiquidacion(l1.id, { fecha_pago: '2026-09-30', novedades: {} }, usuario), 'cambiar una validada');
  await debeFallar(() => eliminarLiquidacion(l1.id), 'eliminar una validada');

  // ── Emisión 2: la DIAN rechaza → se elimina en el proveedor y queda RECHAZADO; se corrige y se reemite con otra referencia.
  const l2 = await crearLiquidacion({ ...base, mes: 8, fecha_pago: '2026-08-31', novedades: {} }, usuario);
  llamadas.emitir.length = 0;
  guion = [rechazoDian];
  const r2 = await emitirLiquidacion(l2.id, usuario);
  comprobar(r2.estado === 'RECHAZADO' && /NIE045/.test(JSON.stringify(r2.errores)) && r2.reference_code === null, 'rechazo de la DIAN → RECHAZADO con el motivo y sin referencia');
  comprobar(llamadas.eliminar.length === 1 && llamadas.eliminar[0] === llamadas.emitir[0], 'la nómina rechazada se eliminó en el proveedor (no bloquea a las demás)');
  await debeFallar(() => emitirLiquidacion(l2.id, usuario), 'emitir una rechazada sin corregirla');
  const l2b = await actualizarLiquidacion(l2.id, { fecha_pago: '2026-08-31', novedades: { comisiones: 100000 } }, usuario);
  comprobar(l2b.estado === 'BORRADOR' && l2b.errores === null, 'al corregirla vuelve a borrador');
  guion = [(d) => validada(d, 'NEF902')];
  const v2 = await emitirLiquidacion(l2.id, usuario);
  comprobar(v2.estado === 'VALIDADO' && llamadas.emitir[1] !== llamadas.emitir[0], 'reemitida con OTRA referencia → VALIDADO');

  // ── Emisión 3: el proveedor no responde (500 tres veces) → ENVIANDO; al reintentar, misma referencia y valida.
  const l3 = await crearLiquidacion({ ...base, mes: 7, fecha_pago: '2026-07-31', novedades: {} }, usuario);
  llamadas.emitir.length = 0;
  guion = [error500, error500, error500];
  const p3 = await emitirLiquidacion(l3.id, usuario);
  comprobar(p3.estado === 'ENVIANDO' && p3.pendiente === true && Boolean(p3.reference_code), 'sin respuesta tras tres intentos → ENVIANDO, conserva la referencia');
  guion = [(d) => validada(d, 'NEF903')];
  const v3 = await emitirLiquidacion(l3.id, usuario);
  comprobar(v3.estado === 'VALIDADO' && new Set(llamadas.emitir).size === 1, '«Reintentar el envío» usa la misma referencia → VALIDADO');

  // ── Emisión 4: el proveedor se niega (403) → vuelve a borrador con el mensaje.
  const l4 = await crearLiquidacion({ ...base, mes: 6, fecha_pago: '2026-06-30', novedades: { prima: { dias: 180 } } }, usuario);
  guion = [negativa403];
  await debeFallar(() => emitirLiquidacion(l4.id, usuario), 'negativa del proveedor (403)');
  const l4b = await obtenerLiquidacion(l4.id);
  comprobar(l4b.estado === 'BORRADOR' && l4b.reference_code === null, 'tras la negativa queda en borrador, sin referencia');
  await eliminarLiquidacion(l4.id);
  comprobar(true, 'un borrador se elimina');

  // ── Empleado al que le falta algo en Terceros: no se envía nada.
  await pool.query(`UPDATE sst.terceros SET direccion = NULL WHERE id = $1`, [terceroId]);
  const l5 = await crearLiquidacion({ ...base, mes: 5, fecha_pago: '2026-05-29', novedades: {} }, usuario);
  llamadas.emitir.length = 0;
  await debeFallar(() => emitirLiquidacion(l5.id, usuario), 'emitir sin dirección en Terceros');
  comprobar(llamadas.emitir.length === 0 && (await obtenerLiquidacion(l5.id)).estado === 'BORRADOR', 'no se llamó al proveedor y sigue en borrador');
  await pool.query(`UPDATE sst.terceros SET direccion = 'CALLE 1 2-3' WHERE id = $1`, [terceroId]);

  // ── Desprendible en PDF (validada y borrador). Con una carpeta como argumento, los deja ahí.
  for (const [id, sufijo] of [[v2.id, 'validada'], [l5.id, 'borrador']]) {
    const { nombre, buffer } = await pdfDesprendible(id);
    comprobar(buffer.subarray(0, 4).toString() === '%PDF' && /^nomina-2026-\d\d-\d+\.pdf$/.test(nombre), `desprendible de la ${sufijo}: ${nombre} (${buffer.length} bytes)`);
    if (process.argv[2]) { fs.mkdirSync(process.argv[2], { recursive: true }); fs.writeFileSync(`${process.argv[2]}/desprendible-${sufijo}.pdf`, buffer); }
  }

  // ── Anulación
  const a1 = await anularLiquidacion(v1.id, usuario);
  comprobar(a1.estado === 'ANULADO' && a1.nota_numero === 'NAN9' && llamadas.nota[0].numeroNomina === 'NEF901', 'anulación → ANULADO con su nota de ajuste sobre NEF901');
  await debeFallar(() => anularLiquidacion(l5.id, usuario), 'anular un borrador');
  const otra = await crearLiquidacion({ ...base, mes: 9, novedades: {} }, usuario);
  comprobar(otra.estado === 'BORRADOR', 'con la de septiembre anulada, se puede volver a liquidar septiembre');

  // ── La ficha se puede editar sin tocar las nóminas ya guardadas.
  await actualizarEmpleado(emp.id, { salario: 2_600_000, fecha_ingreso: '2024-02-01', metodo_pago: '10' }, usuario);
  comprobar(Number((await obtenerLiquidacion(v2.id)).salario) === 2_400_000, 'subir el salario no cambia una nómina ya emitida');
} catch (err) {
  console.error(`✗ ${err.stack ?? err.message}`);
  fallos += 1;
} finally {
  if (empleadoId) {
    await pool.query(`DELETE FROM sst.nomina_liquidaciones WHERE empleado_id = $1`, [empleadoId]);
    await pool.query(`DELETE FROM sst.empleados WHERE id = $1`, [empleadoId]);
  }
  if (terceroId) await pool.query(`DELETE FROM sst.terceros WHERE id = $1`, [terceroId]);
  await pool.end();
}
console.log(fallos ? `\n${fallos} fallo(s)` : '\nTodo bien (los datos de prueba se borraron).');
process.exit(fallos ? 1 : 0);
