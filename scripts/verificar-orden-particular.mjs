// Verifica A3-01 (órdenes manuales para clientes particulares) contra jdd_dev
// DENTRO de una transacción con ROLLBACK: crea un cliente particular, da de alta
// una orden a mano, la lleva a FINALIZADA, comprueba que entra en "Por facturar"
// como pagador propio y que su borrador de factura lleva IVA 19 %. No deja nada.
//
// Si la migración 2026-09-29-ordenes-particulares.sql aún no está aplicada, la
// aplica DENTRO de la misma transacción (y se deshace con el ROLLBACK).
//
// Uso: node --import tsx scripts/verificar-orden-particular.mjs   (requiere el túnel a jdd_dev)
import { readFileSync } from 'node:fs';
import { pool } from '../src/config/db.js';
import { crearOrdenManual } from '../src/modules/imports/drafts.routes.js';
import { generateOrderDocuments } from '../src/modules/orders/orders.service.js';
import { entregaDeLaOrden } from '../src/services/entrega-arl.service.js';
import { relacionPorFacturar, resolverSeleccion } from '../src/modules/facturacion/relacion.service.js';
import { crearBorrador } from '../src/modules/facturacion/borrador.service.js';

let fallos = 0;
const igual = (obtenido, esperado, texto) => {
  const ok = JSON.stringify(obtenido) === JSON.stringify(esperado);
  if (!ok) fallos++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${texto} → ${JSON.stringify(obtenido)}${ok ? '' : ` (esperado ${JSON.stringify(esperado)})`}`);
};
const rechaza = async (client, fn, fragmento, texto) => {
  // SAVEPOINT: un error de SQL aborta la transacción entera si no se aísla.
  await client.query('SAVEPOINT intento');
  try { await fn(); fallos++; console.log(`FAIL ${texto} → no lanzó error`); }
  catch (e) {
    const ok = e.message.includes(fragmento);
    if (!ok) fallos++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${texto} → ${e.message.slice(0, 120)}`);
  }
  await client.query('ROLLBACK TO SAVEPOINT intento');
};

const client = await pool.connect();
try {
  await client.query('BEGIN');

  const aplicada = (await client.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema='sst' AND table_name='ordenes_servicio' AND column_name='pagador_tercero_id'`,
  )).rows.length > 0;
  if (!aplicada) {
    const sql = readFileSync(new URL('../db/migraciones/2026-09-29-ordenes-particulares.sql', import.meta.url), 'utf8')
      .replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');
    await client.query(sql);
    console.log('(migración aplicada dentro de la transacción de prueba)');
  }

  const usuario = (await client.query(`SELECT id FROM sst.usuarios WHERE rol = 'admin' ORDER BY creado_en LIMIT 1`)).rows[0].id;
  const nit = (await client.query(`SELECT id FROM sst.tipos_documento_identidad WHERE codigo_dian = '31'`)).rows[0].id;
  const municipio = (await client.query(`SELECT id FROM sst.municipios WHERE codigo_dian = '52001'`)).rows[0]?.id ?? null;
  const tercero = async (razon, { esArl = false, esCliente = true } = {}) => (await client.query(
    `INSERT INTO sst.terceros (tipo_persona, tipo_documento_id, numero_documento, dv, razon_social, direccion,
                               municipio_id, correo_facturacion, es_arl, es_cliente)
     VALUES ('JURIDICA', $1, $2, 7, $3, 'CALLE DE PRUEBA 1', $4, 'cliente.prueba@jddconsultores.test', $5, $6)
     RETURNING id`,
    [nit, String(800000000 + Math.floor(Math.random() * 99999)), razon, municipio, esArl, esCliente],
  )).rows[0].id;
  const cliente = await tercero('CLIENTE PARTICULAR DE PRUEBA A3-01 SAS');
  const tipoOrden = (await client.query(`SELECT id FROM sst.tipos_orden ORDER BY nombre LIMIT 1`)).rows[0].id;
  const profesional = (await client.query(`SELECT id FROM sst.profesionales WHERE estado = 'Activo' LIMIT 1`)).rows[0].id;

  const base = {
    pagador_tercero_id: cliente, tipo_orden_id: tipoOrden, horas_asignadas: '4',
    fecha_vencimiento: '2026-12-31', descripcion: 'Capacitación en trabajo seguro en alturas',
    valor_total: '800000', contacto_sst_correo: 'Contacto.Prueba@Cliente.test',
  };

  // ── Validaciones del alta ──────────────────────────────────────────────────
  const arlTercero = await tercero('ARL DE PRUEBA A3-01', { esArl: true });
  const noCliente = await tercero('PROVEEDOR DE PRUEBA A3-01', { esCliente: false });
  await rechaza(client, () => crearOrdenManual({ ...base, pagador_tercero_id: arlTercero }, usuario, client), 'se importan', 'una ARL no se da de alta a mano');
  await rechaza(client, () => crearOrdenManual({ ...base, pagador_tercero_id: noCliente }, usuario, client), 'no está marcado como cliente', 'el pagador tiene que ser cliente');
  await rechaza(client, () => crearOrdenManual({ ...base, horas_asignadas: '0' }, usuario, client), 'horas', 'sin horas no entra');
  await rechaza(client, () => crearOrdenManual({ ...base, fecha_vencimiento: '' }, usuario, client), 'vencimiento', 'sin vencimiento no entra');
  await rechaza(client, () => crearOrdenManual({ ...base, tipo_orden_id: '' }, usuario, client), 'tipo de orden', 'sin tipo de orden no entra');

  // ── Alta ───────────────────────────────────────────────────────────────────
  const { os, draftId } = await crearOrdenManual(base, usuario, client);
  igual([os.estado, os.arl_id, os.pagador_tercero_id === cliente], ['SIN PROGRAMAR', null, true], 'nace SIN PROGRAMAR, sin ARL y con su pagador');
  igual(os.numero_orden, os.codigo, 'su número de orden es el propio código OS');
  igual(os.empresa_nombre, 'CLIENTE PARTICULAR DE PRUEBA A3-01 SAS', 'la empresa por defecto es el mismo cliente');
  igual(/^\d+-7$/.test(os.nit_nic ?? ''), true, 'el NIT de la empresa por defecto lleva el DV del tercero');
  igual([Number(os.horas_asignadas), Number(os.valor_total), os.contacto_sst_correo], [4, 800000, 'contacto.prueba@cliente.test'], 'horas, valor y correo (en minúsculas)');
  const hist = (await client.query(`SELECT motivo FROM sst.historial_estados_orden WHERE orden_id = $1`, [os.id])).rows;
  igual(hist.map((h) => h.motivo), ['Alta manual — orden particular'], 'deja su primera entrada de auditoría');
  const borrador = (await client.query(
    `SELECT estado::text, orden_servicio_id, pagador_tercero_id FROM sst.borradores_extraccion WHERE id = $1`, [draftId],
  )).rows[0];
  igual([borrador.estado, borrador.orden_servicio_id === os.id, borrador.pagador_tercero_id === cliente], ['VALIDADA', true, true], 'su borrador queda VALIDADA y enlazado (la vista Órdenes lista borradores)');

  // Con otro nombre de empresa, no hereda los datos del cliente.
  const filial = await crearOrdenManual({ ...base, empresa_nombre: 'FILIAL DE PRUEBA', ciudad_ejecucion: 'Ipiales' }, usuario, client);
  igual([filial.os.empresa_nombre, filial.os.nit_nic, filial.os.ciudad_ejecucion], ['FILIAL DE PRUEBA', null, 'Ipiales'], 'la empresa donde se ejecuta puede ser otra');

  // ── El modelo: exactamente un pagador ───────────────────────────────────────
  await rechaza(client, () => client.query(
    `INSERT INTO sst.ordenes_servicio (codigo, estado) VALUES ('OS-ZZ-SIN-PAGADOR', 'SIN PROGRAMAR')`,
  ), 'chk_ordenes_un_pagador', 'una orden sin ARL ni pagador no entra');
  const axa = (await client.query(`SELECT id, tercero_id FROM sst.arls WHERE nombre = 'AXA Colpatria'`)).rows[0];
  await rechaza(client, () => client.query(
    `INSERT INTO sst.ordenes_servicio (codigo, estado, arl_id, pagador_tercero_id) VALUES ('OS-ZZ-DOS', 'SIN PROGRAMAR', $1, $2)`,
    [axa.id, cliente],
  ), 'chk_ordenes_un_pagador', 'una orden con ARL y pagador a la vez no entra');

  // ── Vistas ───────────────────────────────────────────────────────────────────
  const conteo = (await client.query(
    `SELECT (SELECT count(*) FROM sst.vw_ordenes_expandidas)::int AS vista, (SELECT count(*) FROM sst.ordenes_servicio)::int AS tabla`,
  )).rows[0];
  igual(conteo.vista, conteo.tabla, 'vw_ordenes_expandidas no pierde ninguna orden');
  const exp = (await client.query(`SELECT arl_nombre, pagador_nombre FROM sst.vw_ordenes_expandidas WHERE id = $1`, [os.id])).rows[0];
  igual([exp.arl_nombre, exp.pagador_nombre], [null, 'CLIENTE PARTICULAR DE PRUEBA A3-01 SAS'], 'la vista dice quién paga');

  // ── Formatos y soportes: ninguno de ARL, casillas por defecto ─────────────────
  igual(await generateOrderDocuments(os.id, client, { guardar: false }), [], 'no genera formatos');
  const entrega = entregaDeLaOrden(exp);
  igual([entrega.formatos, entrega.soportes], [[], ['acta', 'asistencia', 'evidencias']], 'la matriz: sin formatos y las casillas por defecto');

  // ── Ciclo hasta FINALIZADA y cuenta de cobro del profesional ──────────────────
  await client.query(
    `UPDATE sst.ordenes_servicio SET estado = 'FINALIZADA', profesional_asignado_id = $2,
            fecha_ejecucion = now(), soportes_aceptados_en = now() WHERE id = $1`,
    [os.id, profesional],
  );
  const cobro = (await client.query(`SELECT arl_nombre FROM sst.vw_horas_por_cobrar WHERE orden_id = $1`, [os.id])).rows;
  igual(cobro.map((c) => c.arl_nombre), ['PARTICULAR'], 'entra a la cuenta de cobro del profesional');

  // ── Facturación ───────────────────────────────────────────────────────────────
  const { pagadores } = await relacionPorFacturar({}, client);
  const pag = pagadores.find((p) => p.pagador_tercero_id === cliente);
  igual(!!pag, true, 'el cliente aparece como pagador en "Por facturar"');
  const linea = pag?.grupos[0]?.lineas.find((l) => l.orden_id === os.id);
  igual([linea?.facturable, linea?.valor_referencia, linea?.origen_valor], [true, 800000, 'ORDEN'], 'su orden es facturable sin estado ARL, con el valor de la orden');
  igual(pagadores.filter((p) => !p.particular).length, (await client.query(`SELECT count(*)::int AS n FROM sst.arls`)).rows[0].n, 'las ARL siguen todas en la relación');
  igual(pagadores.every((p) => p.clave), true, 'cada pagador trae su clave única');

  await rechaza(client, () => resolverSeleccion({ arlId: axa.id, ordenIds: [os.id] }, client), 'no es del pagador', 'no se factura a nombre de una ARL');
  await rechaza(client, () => resolverSeleccion({ arlId: axa.id, pagadorTerceroId: cliente, ordenIds: [os.id] }, client), 'un solo pagador', 'no se aceptan dos pagadores');
  const sel = await resolverSeleccion({ pagadorTerceroId: cliente, ordenIds: [os.id] }, client);
  igual([sel.pagador.tercero_id === cliente, sel.pagador.particular, sel.total], [true, true, 800000], 'la selección valida con el cliente como pagador');

  const doc = await crearBorrador({ pagadorTerceroId: cliente, ordenIds: [os.id], usuarioId: usuario }, client);
  igual(doc.tercero_id === cliente, true, 'el borrador de factura va a nombre del cliente');
  igual(doc.items.map((i) => i.iva_pct), [19], 'la línea lleva IVA 19 %');
  igual([doc.totales.subtotal, doc.totales.total_iva], ['800000.00', '152000.00'], 'subtotal e IVA del borrador (19 % de 800.000)');
  console.log('     totales del borrador:', JSON.stringify(doc.totales));
} finally {
  await client.query('ROLLBACK');
  client.release();
  await pool.end();
}
console.log(fallos ? `\n${fallos} comprobación(es) fallaron.` : '\nTodo en verde (y nada quedó en la base).');
process.exit(fallos ? 1 : 0);
