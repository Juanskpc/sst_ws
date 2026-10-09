// 9-oct-2026 · Carga la parametrización de Finanzas de JD&D y sus terceros, de una vez.
//
// Uso (en el servidor, o en local contra jdd_dev):
//   node scripts/cargar-parametrizacion-jdd.mjs <terceros.xlsx>              → SIMULA: hace todo y lo deshace
//   node scripts/cargar-parametrizacion-jdd.mjs <terceros.xlsx> --confirmar  → lo guarda
//
// Todo corre en UNA transacción: o entra completo o no entra nada.
//
// Regla de oro: NO PISA NADA de lo que ya existe. Solo agrega lo que falta.
//   · Retenciones: se crea cada una de la tabla de impuestos del software anterior (captura que
//     mandó la contadora el 9-oct) si no hay ya una del mismo tipo, tarifa y operación. Si la
//     hay (p. ej. la retefuente 11 % que creó la contadora), solo se le llena la cuenta de
//     devolución cuando está vacía.
//   · Empresa emisora: solo si no hay ficha.
//   · Terceros: el Excel «Búsqueda de terceros» del software anterior, con el mismo cargue de la
//     pantalla (un documento que ya está no se toca). A los recién creados se les corrige el
//     orden de nombres y apellidos de las personas que en el archivo vienen al revés.
//   · Profesionales: se enlaza cada asesor con su tercero (solo si no tiene uno), por la cédula
//     revisada a mano abajo; al tercero se le suma el rol de proveedor y, si no tiene, el correo
//     y el teléfono de la ficha del asesor.
//   · Condiciones de facturación de las tres ARL: solo si el pagador no tiene.
//   · Marcas del plan de cuentas que nadie había puesto en producción: banco (11100501) y
//     cartera por cobrar/pagar (13050501 / 23352501, 23359501), las cuentas de las reglas.
//     Sin ellas los recibos, los pagos y los libros de cartera no tienen dónde mirar. Solo si
//     ninguna cuenta tiene ya esa marca.
//   · La ReteICA «13551801» que la contadora creó con 60 ‰ por error y pidió eliminar (9-oct):
//     se borra solo si sigue así (ReteICA, tarifa 6, sin usar).
import fs from 'node:fs';
import { pool } from '../src/config/db.js';
import { importarTerceros } from '../src/modules/terceros/importar.service.js';
import { validarEmisor, guardarEmisor } from '../src/modules/parametros/emisor.service.js';

const confirmar = process.argv.includes('--confirmar');
const rutaExcel = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!rutaExcel || !fs.existsSync(rutaExcel)) {
  console.error('Uso: node scripts/cargar-parametrizacion-jdd.mjs <terceros.xlsx> [--confirmar]');
  process.exit(1);
}

// ─── Datos ───────────────────────────────────────────────────────────────────────────────────

/**
 * Tabla «Impuestos» del software contable anterior (captura del 9-oct-2026), sin IVA ni
 * impoconsumo (en ORBITA el IVA va en el producto). Tarifa en % (el ReteICA viene en ‰:
 * 4,14 ‰ = 0.414). `cuenta` = la de ventas o compras; `devolucion` = la de la nota crédito.
 * El código es la cuenta, como ya las nombró la contadora en producción (13551509…).
 *
 * ⚠️ Lo raro de la tabla original se respeta tal cual y queda dicho al final del reporte:
 * la retefuente 2,5 % de ventas apunta en el software anterior a 13551519 «Autorretención 1.1%».
 * Del ReteICA de ventas solo se cargan el 5 ‰ y el 6 ‰ con las cuentas que se usan de verdad en
 * los recibos de caja (13551819 / 13551820, auxiliar de septiembre) y las tarifas de la tabla que
 * no chocan con ellas.
 */
const RETENCIONES = [
  // Ventas: las practica el cliente a JD&D.
  { tipo: 'RETEFUENTE', aplica: 'VENTA', tarifa: 1, cuenta: '13551517', devolucion: '13551518', nombre: 'Retefuente 1 %' },
  { tipo: 'RETEFUENTE', aplica: 'VENTA', tarifa: 2, cuenta: '13551515', devolucion: '13551516', nombre: 'Retefuente 2 %' },
  { tipo: 'RETEFUENTE', aplica: 'VENTA', tarifa: 2.5, cuenta: '13551519', devolucion: '13551521', nombre: 'Retefuente 2,5 %' },
  { tipo: 'RETEFUENTE', aplica: 'VENTA', tarifa: 3.5, cuenta: '13551513', devolucion: '13551514', nombre: 'Retefuente 3,5 %' },
  { tipo: 'RETEFUENTE', aplica: 'VENTA', tarifa: 4, cuenta: '13551503', devolucion: '13551504', nombre: 'Retefuente 4 %' },
  { tipo: 'RETEFUENTE', aplica: 'VENTA', tarifa: 6, cuenta: '13551505', devolucion: '13551506', nombre: 'Retefuente 6 %' },
  { tipo: 'RETEFUENTE', aplica: 'VENTA', tarifa: 7, cuenta: '13551511', devolucion: '13551512', nombre: 'Retefuente 7 %' },
  { tipo: 'RETEFUENTE', aplica: 'VENTA', tarifa: 10, cuenta: '13551507', devolucion: '13551508', nombre: 'Retefuente 10 %' },
  { tipo: 'RETEFUENTE', aplica: 'VENTA', tarifa: 11, cuenta: '13551509', devolucion: '13551510', nombre: 'Retefuente 11 %' },
  { tipo: 'RETEIVA', aplica: 'VENTA', tarifa: 15, cuenta: '13551701', devolucion: '13551702', nombre: 'ReteIVA 15 %' },
  { tipo: 'AUTORRETENCION', aplica: 'VENTA', tarifa: 1.1, cuenta: '13551816', devolucion: null, nombre: 'Autorretención 1,1 %' },
  { tipo: 'RETEICA', aplica: 'VENTA', tarifa: 0.414, cuenta: '13551813', devolucion: '13551814', nombre: 'ReteICA 4,14 por mil' },
  { tipo: 'RETEICA', aplica: 'VENTA', tarifa: 0.5, cuenta: '13551819', devolucion: null, nombre: 'ReteICA 5 por mil' },
  { tipo: 'RETEICA', aplica: 'VENTA', tarifa: 0.6, cuenta: '13551820', devolucion: null, nombre: 'ReteICA 6 por mil' },
  { tipo: 'RETEICA', aplica: 'VENTA', tarifa: 0.69, cuenta: '13551811', devolucion: '13551812', nombre: 'ReteICA 6,9 por mil' },
  { tipo: 'RETEICA', aplica: 'VENTA', tarifa: 0.8, cuenta: '13551807', devolucion: '13551808', nombre: 'ReteICA 8 por mil' },
  { tipo: 'RETEICA', aplica: 'VENTA', tarifa: 1.104, cuenta: '13551801', devolucion: '13551802', nombre: 'ReteICA 11,04 por mil' },
  { tipo: 'RETEICA', aplica: 'VENTA', tarifa: 1.38, cuenta: '13551803', devolucion: '13551804', nombre: 'ReteICA 13,8 por mil' },
  // Compras: las practica JD&D a su proveedor.
  { tipo: 'RETEFUENTE', aplica: 'COMPRA', tarifa: 1, cuenta: '23652505', devolucion: '23652506', nombre: 'Retefuente servicios 1 %' },
  { tipo: 'RETEFUENTE', aplica: 'COMPRA', tarifa: 2, cuenta: '23657001', devolucion: '23657002', nombre: 'Retefuente otras retenciones 2 %' },
  { tipo: 'RETEFUENTE', aplica: 'COMPRA', tarifa: 2.5, cuenta: '23654001', devolucion: '23654002', nombre: 'Retefuente compras 2,5 %' },
  { tipo: 'RETEFUENTE', aplica: 'COMPRA', tarifa: 3.5, cuenta: '23654004', devolucion: '23654005', nombre: 'Retefuente compras 3,5 %' },
  { tipo: 'RETEFUENTE', aplica: 'COMPRA', tarifa: 4, cuenta: '23652503', devolucion: '23652504', nombre: 'Retefuente servicios 4 %' },
  { tipo: 'RETEFUENTE', aplica: 'COMPRA', tarifa: 6, cuenta: '23652501', devolucion: '23652502', nombre: 'Retefuente servicios 6 %' },
  { tipo: 'RETEFUENTE', aplica: 'COMPRA', tarifa: 7, cuenta: '23653502', devolucion: '23653503', nombre: 'Retefuente rendimientos financieros 7 %' },
  { tipo: 'RETEFUENTE', aplica: 'COMPRA', tarifa: 10, cuenta: '23652001', devolucion: '23652002', nombre: 'Retefuente comisiones 10 %' },
  { tipo: 'RETEFUENTE', aplica: 'COMPRA', tarifa: 11, cuenta: '23651501', devolucion: '23651502', nombre: 'Retefuente honorarios 11 %' },
  { tipo: 'RETEIVA', aplica: 'COMPRA', tarifa: 15, cuenta: '23670101', devolucion: '23670102', nombre: 'ReteIVA 15 % (compras)' },
  { tipo: 'RETEICA', aplica: 'COMPRA', tarifa: 0.414, cuenta: '23680513', devolucion: '23680515', nombre: 'ReteICA 4,14 por mil (compras)' },
  { tipo: 'RETEICA', aplica: 'COMPRA', tarifa: 0.5, cuenta: '23680509', devolucion: '23680510', nombre: 'ReteICA 5 por mil (compras)' },
  { tipo: 'RETEICA', aplica: 'COMPRA', tarifa: 0.6, cuenta: '23680505', devolucion: '23680506', nombre: 'ReteICA 6 por mil (compras)' },
  { tipo: 'RETEICA', aplica: 'COMPRA', tarifa: 0.69, cuenta: '23680511', devolucion: '23680512', nombre: 'ReteICA 6,9 por mil (compras)' },
  { tipo: 'RETEICA', aplica: 'COMPRA', tarifa: 0.8, cuenta: '23680507', devolucion: '23680508', nombre: 'ReteICA 8 por mil (compras)' },
  { tipo: 'RETEICA', aplica: 'COMPRA', tarifa: 1.104, cuenta: '23680501', devolucion: '23680502', nombre: 'ReteICA 11,04 por mil (compras)' },
  { tipo: 'RETEICA', aplica: 'COMPRA', tarifa: 1.38, cuenta: '23680503', devolucion: '23680504', nombre: 'ReteICA 13,8 por mil (compras)' },
];
const CODIGO_PROVEEDOR = { RETEFUENTE: '06', AUTORRETENCION: '06', RETEIVA: '05', RETEICA: null };

/** RUT (generado el 26-sep-2026) + dirección de la cámara de comercio (decidido el 6-oct). */
const EMISOR = {
  tipo_persona: 'JURIDICA',
  nit: '901203812-4',
  razon_social: 'JD Y D CONSULTORES EN SISTEMAS DE GESTION SAS',
  direccion: 'CARRERA 24 N. 17-15 CASONA SAN AGUSTIN',
  municipio_dane: '52001',
  correo: 'gerencia.djdconsultores@gmail.com',
  telefono: '3144768516',
  ciiu_principal: '7020',
  ciiu_secundarias: ['8551', '6201', '7490'],
  responsabilidades_rut: ['05', '07', '14', '42', '48', '52', '55'],
  ambiente: 'PRODUCCION',
};

/**
 * Personas que en el Excel vienen con el apellido primero (o con dos nombres y un apellido):
 * el cargue las partiría mal. Revisadas a mano el 9-oct-2026 sobre las 157 cédulas.
 */
const NOMBRES_A_MANO = {
  1085303935: ['ANYELA YURANI', 'ACHICANOY ZAMBRANO'],
  1085291863: ['ANGELA MARIA', 'CORDOBA CERON'],
  1085279030: ['JAIME ALEXANDER', 'ESTRADA MERA'],
  98396065: ['EVERTH ALGEMIRO', 'TREJO'],
  27105646: ['SILVIA ADRIANA', 'RUANO CORTES'],
  5203800: ['RODRIGO ANDRES', 'VILLACRES ORDOÑEZ'],
};

/**
 * Profesional de ORBITA (nombre como está en su ficha) → cédula de su tercero en el Excel.
 * Cruzado a mano el 9-oct-2026; donde la ficha tiene cédula (DIMELSA, JOSE LUIS) coincide.
 * NO se enlazan (quedan para confirmar): ANA CRISTINA CUASPUD (no está en el Excel), JOHANA
 * ROSERO (¿LEIDY JOHANA ROSERO MUÑOZ?), MARIA CAMILA TELLO (¿CAMILA ALEXANDRA TELLO ROSERO?) y
 * LORENA ORTEGA (su ficha dice 1097673821 y el Excel trae 1087673821 y 108767321).
 */
const PROFESIONALES = {
  'ANDRES CHECA H': '76323620',
  'ANGELICA MARIA HORMAZA CADENA': '27382004',
  'CRISTIAN FELIPE BASTO': '93238815',
  'DANIELA PAZ SUAREZ': '1085317929',
  'DANNY ALEXANDER ROSERO NARVAEZ': '1085298973',
  'DIANA MARCELA RINCON': '1085296233',
  'DIMELSA ESTEFANY CANCHALA': '1085277689',
  'DORALINE MARIBEL BRAVO CHAVES': '36751335',
  'EMMA EVETH TOVAR': '1085266660',
  'GERMAN ANDRES MORENO NARVAEZ': '1085298332',
  'JAIME ÑAÑEZ PASAJE': '1086550002',
  'JENNY CAROLINA HERNANDEZ GUERRERO': '1087422087',
  'JOSE LUIS GUACAS ZAMBRANO': '1085290060',
  'JUAN JOSE JURADO ALVAREZ': '1085299379',
  'LEONARDO FABIO PEREZ CORAL': '87712858',
  'MARIA FERNANDA YAMA': '1085303192',
  'OSCAR JULIAN VASQUEZ SOLARTE': '98395330',
  'SILVIA ADRIANA RUANO': '27105646',
};

/**
 * Lo que retiene cada ARL (facturas y auxiliar del software anterior, plan §3.4-3.5): retefuente
 * 11 % en la factura, ReteICA al pagar (Bolívar 5 ‰, AXA y Colmena 6 ‰) y el 2 % de descuento
 * comercial de AXA. La autorretención va también en la lista para que se vea en el borrador,
 * como la puso la contadora en el suyo; nunca sale en el PDF.
 */
const CONDICIONES = [
  { patron: /bol[ií]var/i, reteica: 0.5, descuento: 0 },
  { patron: /axa|colpatria/i, reteica: 0.6, descuento: 2 },
  { patron: /colmena/i, reteica: 0.6, descuento: 0 },
];

// ─── Carga ───────────────────────────────────────────────────────────────────────────────────

const sinTildes = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const reporte = { retenciones: [], emisor: null, terceros: null, nombres: [], profesionales: [], condiciones: [], avisos: [] };

const client = await pool.connect();
try {
  await client.query('BEGIN');
  const cuentas = new Map((await client.query(
    `SELECT codigo, id FROM sst.cuentas_contables WHERE acepta_movimiento AND activa`,
  )).rows.map((c) => [c.codigo, c.id]));

  // 0 · La ReteICA mal creada que la contadora pidió eliminar (y deja libre su código).
  const mal = (await client.query(
    `SELECT r.id FROM sst.retenciones r WHERE r.codigo = '13551801' AND r.tipo = 'RETEICA' AND r.tarifa = 6
        AND NOT EXISTS (SELECT 1 FROM sst.documento_item_tributos t WHERE t.retencion_id = r.id)
        AND NOT EXISTS (SELECT 1 FROM sst.compra_retenciones c WHERE c.retencion_id = r.id)
        AND NOT EXISTS (SELECT 1 FROM sst.cartera_aplicacion_retenciones a WHERE a.retencion_id = r.id)`,
  )).rows[0];
  if (mal) {
    await client.query(
      `UPDATE sst.condiciones_pagador SET retenciones_ids = array_remove(retenciones_ids, $1::uuid),
              reteica_pago_id = CASE WHEN reteica_pago_id = $1 THEN NULL ELSE reteica_pago_id END
        WHERE $1 = ANY(retenciones_ids) OR reteica_pago_id = $1`, [mal.id],
    );
    await client.query(`DELETE FROM sst.retenciones WHERE id = $1`, [mal.id]);
    reporte.retenciones.push('- 13551801 «RETE ICA 6*1000» (60 ‰ por error, sin usar): eliminada, como pidió la contadora');
  }

  // 1 · Retenciones
  for (const r of RETENCIONES) {
    const cuentaId = cuentas.get(r.cuenta) ?? null;
    const devolucionId = r.devolucion ? (cuentas.get(r.devolucion) ?? null) : null;
    if (!cuentaId) reporte.avisos.push(`La cuenta ${r.cuenta} de «${r.nombre}» no está en el plan de cuentas: queda sin cuenta.`);
    if (r.devolucion && !devolucionId) reporte.avisos.push(`La cuenta de devolución ${r.devolucion} de «${r.nombre}» no está en el plan.`);
    const existente = (await client.query(
      `SELECT id, codigo, cuenta_devolucion_id FROM sst.retenciones WHERE tipo = $1 AND aplica_a = $2 AND tarifa = $3 ORDER BY activa DESC, creado_en LIMIT 1`,
      [r.tipo, r.aplica, r.tarifa],
    )).rows[0];
    if (existente) {
      if (!existente.cuenta_devolucion_id && devolucionId) {
        await client.query(`UPDATE sst.retenciones SET cuenta_devolucion_id = $2 WHERE id = $1`, [existente.id, devolucionId]);
        reporte.retenciones.push(`= ${existente.codigo} ya existía: se le puso la cuenta de devolución ${r.devolucion}`);
      } else {
        reporte.retenciones.push(`= ${existente.codigo} ya existía (${r.nombre}): no se toca`);
      }
      continue;
    }
    if (r.tipo === 'AUTORRETENCION') {
      const otra = (await client.query(`SELECT codigo FROM sst.retenciones WHERE tipo = 'AUTORRETENCION' AND aplica_a = $1 AND activa`, [r.aplica])).rows[0];
      if (otra) { reporte.retenciones.push(`= ya hay una autorretención activa (${otra.codigo}): no se crea otra`); continue; }
    }
    let codigo = r.cuenta;
    if ((await client.query(`SELECT 1 FROM sst.retenciones WHERE codigo = $1`, [codigo])).rows[0]) codigo = `${r.cuenta}-${r.aplica[0]}`;
    await client.query(
      `INSERT INTO sst.retenciones (codigo, nombre, tipo, tarifa, base_minima_uvt, aplica_a, factus_tributo_id, cuenta_id, cuenta_devolucion_id)
       VALUES ($1, $2, $3, $4, 0, $5, $6, $7, $8)`,
      [codigo, r.nombre.toUpperCase(), r.tipo, r.tarifa, r.aplica, CODIGO_PROVEEDOR[r.tipo], cuentaId, devolucionId],
    );
    reporte.retenciones.push(`+ ${codigo} ${r.nombre} (${r.aplica.toLowerCase()})`);
  }

  // 2 · Empresa emisora
  const yaEmisor = (await client.query(`SELECT razon_social FROM sst.emisor WHERE id = 1`)).rows[0];
  if (yaEmisor) {
    reporte.emisor = `ya existía (${yaEmisor.razon_social}): no se toca`;
  } else {
    const mun = (await client.query(`SELECT id FROM sst.municipios WHERE codigo_dian = $1`, [EMISOR.municipio_dane])).rows[0];
    if (!mun) throw new Error(`No está el municipio ${EMISOR.municipio_dane} (Pasto).`);
    const campos = await validarEmisor({ ...EMISOR, municipio_id: mun.id }, client);
    const e = await guardarEmisor(campos, null, client);
    reporte.emisor = `+ ${e.razon_social} · NIT ${e.nit}-${e.dv} · ${e.direccion} · ${e.municipio_nombre}`;
  }

  // 3 · Terceros desde el Excel
  const imp = await importarTerceros(fs.readFileSync(rutaExcel), { client, simular: false });
  reporte.terceros = { filas: imp.filas, nuevos: imp.nuevos, ya_existen: imp.ya_existen, errores: imp.errores, con_avisos: imp.con_avisos };
  reporte.errores_terceros = imp.resultados.filter((x) => x.estado === 'ERROR').map((x) => `fila ${x.fila} · ${x.nombre} · ${x.error}`);
  for (const x of imp.resultados.filter((y) => y.estado === 'NUEVO' && y.id)) {
    const doc = String(x.documento ?? '').split('-')[0];
    const amano = NOMBRES_A_MANO[doc];
    if (!amano) continue;
    await client.query(`UPDATE sst.terceros SET nombres = $2, apellidos = $3 WHERE id = $1`, [x.id, amano[0], amano[1]]);
    reporte.nombres.push(`${doc}: ${amano[0]} | ${amano[1]}`);
  }
  // Clientes (NIT) sin correo de facturación: no se les puede facturar hasta completarlo.
  reporte.clientes_sin_correo = (await client.query(
    `SELECT COALESCE(razon_social, btrim(concat_ws(' ', nombres, apellidos))) AS n FROM sst.terceros
      WHERE es_cliente AND activo AND COALESCE(correo_facturacion, '') = '' ORDER BY 1`,
  )).rows.map((r) => r.n);

  // 4 · Profesionales → su tercero
  const profesionales = (await client.query(`SELECT id, nombre, correo, telefono, tercero_id FROM sst.profesionales`)).rows;
  for (const [nombre, cedula] of Object.entries(PROFESIONALES)) {
    const p = profesionales.find((x) => sinTildes(x.nombre) === sinTildes(nombre));
    if (!p) { reporte.profesionales.push(`? no hay profesional «${nombre}» en esta base`); continue; }
    if (p.tercero_id) { reporte.profesionales.push(`= ${p.nombre} ya tenía tercero: no se toca`); continue; }
    const t = (await client.query(
      `SELECT t.id, t.correo_facturacion, t.telefono FROM sst.terceros t JOIN sst.tipos_documento_identidad td ON td.id = t.tipo_documento_id
        WHERE td.codigo_dian = '13' AND t.numero_documento = $1`, [cedula],
    )).rows[0];
    if (!t) { reporte.profesionales.push(`? no está el tercero con cédula ${cedula} para ${p.nombre}`); continue; }
    await client.query(
      `UPDATE sst.terceros SET es_proveedor = true,
              correo_facturacion = COALESCE(NULLIF(correo_facturacion, ''), $2),
              telefono = COALESCE(NULLIF(telefono, ''), $3)
        WHERE id = $1`,
      [t.id, String(p.correo ?? '').trim().toLowerCase() || null, String(p.telefono ?? '').replace(/\D/g, '') || null],
    );
    await client.query(`UPDATE sst.profesionales SET tercero_id = $2 WHERE id = $1`, [p.id, t.id]);
    reporte.profesionales.push(`+ ${p.nombre} → ${cedula}`);
  }
  reporte.profesionales_sin_tercero = (await client.query(
    `SELECT nombre FROM sst.profesionales WHERE tercero_id IS NULL ORDER BY nombre`,
  )).rows.map((r) => r.nombre);

  // 5 · Condiciones de facturación de las ARL
  const rf11 = (await client.query(
    `SELECT id FROM sst.retenciones WHERE tipo = 'RETEFUENTE' AND aplica_a = 'VENTA' AND tarifa = 11 AND activa ORDER BY creado_en LIMIT 1`,
  )).rows[0];
  const auto = (await client.query(
    `SELECT id FROM sst.retenciones WHERE tipo = 'AUTORRETENCION' AND aplica_a = 'VENTA' AND activa ORDER BY codigo LIMIT 1`,
  )).rows[0];
  const arls = (await client.query(`SELECT nombre, tercero_id FROM sst.arls WHERE tercero_id IS NOT NULL`)).rows;
  for (const c of CONDICIONES) {
    const arl = arls.find((a) => c.patron.test(a.nombre));
    if (!arl) { reporte.condiciones.push(`? no hay ARL que coincida con ${c.patron}`); continue; }
    const ya = (await client.query(`SELECT 1 FROM sst.condiciones_pagador WHERE tercero_id = $1`, [arl.tercero_id])).rows[0];
    if (ya) { reporte.condiciones.push(`= ${arl.nombre} ya tenía condiciones: no se tocan`); continue; }
    const ica = (await client.query(
      `SELECT id FROM sst.retenciones WHERE tipo = 'RETEICA' AND aplica_a = 'VENTA' AND tarifa = $1 AND activa ORDER BY creado_en LIMIT 1`, [c.reteica],
    )).rows[0];
    await client.query(
      `INSERT INTO sst.condiciones_pagador (tercero_id, retenciones_ids, reteica_pago_id, descuento_comercial_pct, plazo_dias)
       VALUES ($1, $2, $3, $4, 0)`,
      [arl.tercero_id, [rf11?.id, auto?.id].filter(Boolean), ica?.id ?? null, c.descuento],
    );
    reporte.condiciones.push(`+ ${arl.nombre}: retefuente 11 %${auto ? ' + autorretención' : ''}, ReteICA ${c.reteica * 10} ‰ al pagar${c.descuento ? `, descuento ${c.descuento} %` : ''}`);
  }

  // 6 · Marcas del plan de cuentas (banco y cartera), solo si no hay ninguna de ese tipo.
  reporte.marcas = [];
  const marcar = async (codigo, set, donde, etiqueta) => {
    const ya = (await client.query(`SELECT 1 FROM sst.cuentas_contables WHERE ${donde} LIMIT 1`)).rows[0];
    if (ya) { reporte.marcas.push(`= ya hay cuentas ${etiqueta}: no se toca ${codigo}`); return; }
    const r = await client.query(`UPDATE sst.cuentas_contables SET ${set} WHERE codigo = $1 AND acepta_movimiento AND activa RETURNING codigo`, [codigo]);
    reporte.marcas.push(r.rows[0] ? `+ ${codigo} marcada ${etiqueta}` : `? no está la cuenta ${codigo}`);
  };
  await marcar('11100501', 'es_banco = true', 'es_banco', 'de banco');
  await marcar('13050501', "es_cartera = 'CXC'", "es_cartera = 'CXC'", 'de cartera por cobrar');
  const yaCxp = (await client.query(`SELECT 1 FROM sst.cuentas_contables WHERE es_cartera = 'CXP' LIMIT 1`)).rows[0];
  if (yaCxp) {
    reporte.marcas.push('= ya hay cuentas de cartera por pagar: no se tocan');
  } else {
    for (const c of ['23352501', '23359501']) {
      const r = await client.query(`UPDATE sst.cuentas_contables SET es_cartera = 'CXP' WHERE codigo = $1 AND acepta_movimiento AND activa RETURNING codigo`, [c]);
      reporte.marcas.push(r.rows[0] ? `+ ${c} marcada de cartera por pagar` : `? no está la cuenta ${c}`);
    }
  }

  // Lo que hay que mirar con la contadora (no bloquea).
  const autos = (await client.query(`SELECT codigo FROM sst.retenciones WHERE tipo = 'AUTORRETENCION' AND aplica_a = 'VENTA' AND activa ORDER BY codigo`)).rows;
  if (autos.length > 1) reporte.avisos.push(`Hay ${autos.length} autorretenciones activas (${autos.map((a) => a.codigo).join(', ')}): la contabilización usa solo ${autos[0].codigo}. Conviene inactivar las demás.`);
  reporte.avisos.push('La retefuente 2,5 % de ventas usa 13551519 «Autorretención 1.1%», como en el software anterior: confirmarlo con la contadora.');

  await client.query(confirmar ? 'COMMIT' : 'ROLLBACK');
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('✗ No se cargó nada:', e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}

console.log(JSON.stringify(reporte, null, 2));
console.log(confirmar ? '\n✓ GUARDADO.' : '\nSIMULACIÓN: no se guardó nada. Para guardar: --confirmar');
