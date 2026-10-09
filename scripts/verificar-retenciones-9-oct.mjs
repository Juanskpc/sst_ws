// 9-oct-2026 · Verifica los cambios de retenciones y terceros de este lote:
//   · cada retención se contabiliza en SU cuenta (factura) y en su cuenta de devolución (nota);
//   · la ReteIVA va sobre el IVA, no sobre el subtotal;
//   · la autorretención: se ve en el borrador, NO sale en el PDF de la factura y se
//     contabiliza una sola vez aunque el borrador traiga dos;
//   · el PDF lleva los totales en el orden Subtotal → IVA → Total bruto;
//   · retenciones: una sola autorretención activa, editar y eliminar (con sus límites);
//   · cargue de terceros: nombres «NOMBRES APELLIDOS».
//
//   node --import tsx scripts/verificar-retenciones-9-oct.mjs
//
// La parte 1 corre en una transacción con ROLLBACK. La parte 2 usa los servicios tal cual
// (abren su propia transacción): crea registros de prueba con el prefijo PRUEBA-9OCT y los borra.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pool } from '../src/config/db.js';
import { crearBorradorManual, eliminarBorrador, obtenerBorrador } from '../src/modules/facturacion/borrador.service.js';
import { construirAsiento } from '../src/modules/contabilidad/contabilizacion.service.js';
import { pdfPropioFactura } from '../src/modules/facturacion/representacion.service.js';
import { crearRetencion, actualizarRetencion, eliminarRetencion, setRetencionActiva } from '../src/modules/parametros/retenciones.service.js';
import { partirNombre } from '../src/modules/terceros/importar.service.js';

let fallos = 0;
const comprobar = (ok, texto) => { console.log(`${ok ? '✓' : '✗'} ${texto}`); if (!ok) fallos += 1; };
const centavos = (v) => Math.round(Number(v) * 100);
const pct = (base, t) => Math.round(centavos(base) * t / 100) / 100;

// ─── Parte 1 · con ROLLBACK ────────────────────────────────────────────────────────────────
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const usuario = (await client.query(`SELECT id FROM sst.usuarios ORDER BY creado_en LIMIT 1`)).rows[0].id;
  const cuenta = async (codigo) => (await client.query(`SELECT id FROM sst.cuentas_contables WHERE codigo = $1`, [codigo])).rows[0]?.id;
  // El asiento trae el id de cada cuenta: se le pone el código para comparar.
  const asiento = async (id) => {
    const x = await construirAsiento(id, client);
    const cods = new Map((await client.query(`SELECT id, codigo FROM sst.cuentas_contables WHERE id = ANY($1)`, [x.lineas.map((l) => l.cuenta_id)])).rows.map((c) => [c.id, c.codigo]));
    return { ...x, lineas: x.lineas.map((l) => ({ ...l, cuenta_codigo: cods.get(l.cuenta_id) })) };
  };
  const cliente = (await client.query(
    `SELECT t.id FROM sst.terceros t WHERE t.activo AND t.es_cliente AND NOT t.es_arl ORDER BY t.creado_en LIMIT 1`,
  )).rows[0];
  if (!cliente) throw new Error('No hay un tercero cliente (no ARL) para probar.');

  // Lo que había en producción el 9-oct: DOS autorretenciones activas (débito y crédito por separado).
  await client.query(`UPDATE sst.retenciones SET activa = false WHERE tipo = 'AUTORRETENCION'`);
  const ins = async (codigo, tipo, tarifa, c, d) => (await client.query(
    `INSERT INTO sst.retenciones (codigo, nombre, tipo, tarifa, aplica_a, factus_tributo_id, cuenta_id, cuenta_devolucion_id)
     VALUES ($1, $1, $2, $3, 'VENTA', $4, $5, $6) RETURNING id`,
    [codigo, tipo, tarifa, tipo === 'RETEIVA' ? '05' : '06', c, d],
  )).rows[0].id;
  const rf4 = await ins('PRUEBA-RF4', 'RETEFUENTE', 4, await cuenta('13551503'), await cuenta('13551504'));
  const riva = await ins('PRUEBA-RIVA', 'RETEIVA', 15, await cuenta('13551701'), await cuenta('13551702'));
  const autA = await ins('PRUEBA-AUT-A', 'AUTORRETENCION', 1.1, await cuenta('13551816'), null);
  const autB = await ins('PRUEBA-AUT-B', 'AUTORRETENCION', 1.1, await cuenta('23657502'), null);

  const f = await crearBorradorManual({
    tercero_id: cliente.id,
    items: [{ descripcion: 'Asesoría SG-SST (prueba de retenciones)', cantidad: 1, valor_unitario: 1744386.56 }],
    retenciones_ids: [rf4, riva, autA, autB], descuento_comercial_pct: 0,
  }, usuario, client);
  const sub = Number(f.totales.subtotal);
  const iva = Number(f.totales.total_iva);
  const r = (codigo) => f.retenciones.find((x) => x.codigo === codigo);
  comprobar(iva > 0, `la línea lleva IVA (${iva}) para poder probar la ReteIVA`);
  comprobar(Number(r('PRUEBA-RIVA')?.valor) === pct(iva, 15), `ReteIVA = 15 % del IVA: ${r('PRUEBA-RIVA')?.valor} (antes salía ${pct(sub, 15)})`);
  comprobar(Number(r('PRUEBA-RF4')?.valor) === pct(sub, 4), `retefuente 4 % del subtotal: ${r('PRUEBA-RF4')?.valor}`);
  comprobar(f.retenciones.filter((x) => x.tipo === 'AUTORRETENCION').length === 2, 'en la pantalla del borrador SÍ se ven las autorretenciones');
  comprobar(f.retenciones.every((x) => x.nombre), 'cada retención trae su nombre');
  const esperado = Math.round((sub + iva - pct(iva, 15) - pct(sub, 4)) * 100) / 100;
  comprobar(Number(f.totales.total_a_pagar) === esperado, `total a pagar = subtotal + IVA − retefuente − ReteIVA (${f.totales.total_a_pagar}); la autorretención no resta`);

  // Asiento de la factura
  const a = await asiento(f.id);
  const lineasDe = (codigo) => a.lineas.filter((l) => l.cuenta_codigo === codigo);
  comprobar(lineasDe('13551503').length === 1 && Number(lineasDe('13551503')[0].debito) === pct(sub, 4), 'la retefuente 4 % va a SU cuenta 13551503 (antes iba a la del 11 %)');
  comprobar(lineasDe('13551509').length === 0, 'nada cae en 13551509 (11 %)');
  comprobar(Number(lineasDe('13551701')[0]?.debito) === pct(iva, 15), 'la ReteIVA va a 13551701 por el 15 % del IVA');
  comprobar(lineasDe('13551816').length === 1 && lineasDe('23657502').length === 1, 'la autorretención aparece UNA vez (una línea débito y una crédito), aunque el borrador traiga dos');
  comprobar(Number(lineasDe('13551816')[0]?.debito) === pct(sub, 1.1), `autorretención = 1,1 % del subtotal (${lineasDe('13551816')[0]?.debito})`);
  const deb = a.lineas.reduce((s, l) => s + centavos(l.debito ?? 0), 0);
  const cre = a.lineas.reduce((s, l) => s + centavos(l.credito ?? 0), 0);
  comprobar(deb === cre, `el asiento cuadra (${deb / 100} = ${cre / 100})`);

  // Sin cuenta propia: cae en la regla general, como antes.
  await client.query(`UPDATE sst.retenciones SET cuenta_id = NULL WHERE id = $1`, [rf4]);
  const a2 = await asiento(f.id);
  comprobar(a2.lineas.some((l) => l.cuenta_codigo === '13551509' && Number(l.debito) === pct(sub, 4)), 'retención sin cuenta propia → regla general FV_RETEFUENTE');
  await client.query(`UPDATE sst.retenciones SET cuenta_id = $2 WHERE id = $1`, [rf4, await cuenta('13551503')]);

  // Nota crédito: la misma factura leída como nota usa las cuentas de devolución.
  await client.query(`UPDATE sst.documentos_electronicos SET estado = 'VALIDADO', prefijo = 'FE', numero = 999901, cufe = 'prueba' WHERE id = $1`, [f.id]);
  const nota = (await client.query(
    `INSERT INTO sst.documentos_electronicos (tipo, reference_code, estado, tercero_id, documento_referencia_id, causal, fecha_emision, fecha_vencimiento,
            total_bruto, total_descuento, subtotal, total_iva, total_retenciones, total_a_pagar, creado_por, actualizado_por)
     SELECT 'NOTA_CREDITO', 'PRUEBA-NC-9OCT', 'BORRADOR', tercero_id, id, '2', fecha_emision, fecha_emision,
            total_bruto, total_descuento, subtotal, total_iva, total_retenciones, total_a_pagar, creado_por, creado_por
       FROM sst.documentos_electronicos WHERE id = $1 RETURNING id`, [f.id],
  )).rows[0].id;
  const itemsF = (await client.query(`SELECT * FROM sst.documento_items WHERE documento_id = $1`, [f.id])).rows;
  for (const it of itemsF) {
    const nuevo = (await client.query(
      `INSERT INTO sst.documento_items (documento_id, producto_id, codigo, descripcion, cantidad, valor_unitario, descuento, base, total_linea, orden)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [nota, it.producto_id, it.codigo, it.descripcion, it.cantidad, it.valor_unitario, it.descuento, it.base, it.total_linea, it.orden],
    )).rows[0].id;
    await client.query(
      `INSERT INTO sst.documento_item_tributos (item_id, retencion_id, tributo_codigo, base, tarifa, valor)
       SELECT $2, retencion_id, tributo_codigo, base, tarifa, valor FROM sst.documento_item_tributos WHERE item_id = $1`, [it.id, nuevo],
    );
  }
  const an = await asiento(nota);
  const ln = (codigo) => an.lineas.filter((l) => l.cuenta_codigo === codigo);
  comprobar(Number(ln('13551504')[0]?.credito) === pct(sub, 4), 'en la nota crédito la retefuente 4 % se reversa en SU cuenta de devolución 13551504');
  comprobar(Number(ln('13551702')[0]?.credito) === pct(iva, 15), 'y la ReteIVA en 13551702');
  comprobar(ln('13551816').length === 1, 'la reversa de la autorretención va una sola vez');

  // PDF de la factura: sin autorretención y con el orden nuevo.
  if (!(await client.query(`SELECT 1 FROM sst.emisor WHERE id = 1`)).rows[0]) {
    const pasto = (await client.query(`SELECT id FROM sst.municipios WHERE codigo_dian = '52001'`)).rows[0].id;
    await client.query(
      `INSERT INTO sst.emisor (id, tipo_persona, nit, dv, razon_social, direccion, municipio_id, correo, telefono, ambiente, responsabilidades_rut)
       VALUES (1, 'JURIDICA', '901203812', 4, 'EMISOR DE PRUEBA', 'CARRERA 24 N. 17-15', $1, 'prueba@example.com', '3144768516', 'PRUEBAS', '{48}')`, [pasto],
    );
  }
  const bytes = await pdfPropioFactura(f.id, client);
  comprobar(Boolean(bytes), 'el PDF propio se arma');
  if (bytes) {
    const archivo = path.join(os.tmpdir(), `prueba-9oct-${Date.now()}.pdf`);
    fs.writeFileSync(archivo, bytes);
    let texto = '';
    try { texto = execFileSync('pdftotext', ['-layout', archivo, '-'], { encoding: 'utf8' }); } catch { texto = ''; }
    fs.unlinkSync(archivo);
    if (!texto) {
      console.log('· (sin pdftotext: no se revisa el texto del PDF)');
    } else {
      comprobar(!/PRUEBA-AUT|Autorret/i.test(texto), 'el PDF NO trae la autorretención');
      comprobar(/Retefuente 4%/.test(texto) && /ReteIVA 15%/.test(texto), 'el PDF sí trae la retefuente y la ReteIVA');
      const orden = ['Subtotal', 'IVA', 'Total Bruto', 'Retefuente 4%', 'Total a Pagar'].map((k) => texto.indexOf(k));
      comprobar(orden.every((x, i) => x >= 0 && (i === 0 || x > orden[i - 1])), `totales en orden Subtotal → IVA → Total Bruto → retención → Total a Pagar (${orden.join(' < ')})`);
      const bruto = (sub + iva).toLocaleString('en-US', { minimumFractionDigits: 2 });
      comprobar(texto.includes(bruto), `«Total Bruto» = subtotal + IVA (${bruto})`);
    }
  }
} catch (e) {
  comprobar(false, `parte 1 se cayó: ${e.stack}`);
} finally {
  await client.query('ROLLBACK').catch(() => {});
  client.release();
}

// ─── Parte 2 · servicios reales, con limpieza ──────────────────────────────────────────────
const creadas = [];
try {
  const hayAuto = (await pool.query(`SELECT 1 FROM sst.retenciones WHERE tipo = 'AUTORRETENCION' AND aplica_a = 'VENTA' AND activa`)).rows[0];
  const base = { nombre: 'Prueba 9 oct', tarifa: 0.6, aplica_a: 'VENTA' };
  if (hayAuto) {
    try {
      const x = await crearRetencion({ ...base, codigo: 'PRUEBA-9OCT-AUT', tipo: 'AUTORRETENCION', tarifa: 1.1 });
      creadas.push(x.id);
      comprobar(false, 'una segunda autorretención activa debía rechazarse');
    } catch (e) { comprobar(e.statusCode === 409 && /Ya hay una autorretención/.test(e.message), `segunda autorretención → «${e.message}»`); }
  }
  const ica = await crearRetencion({ ...base, codigo: 'PRUEBA-9OCT-ICA', tipo: 'RETEICA' });
  creadas.push(ica.id);
  comprobar(Number(ica.tarifa) === 0.6, 'ReteICA de prueba creada (6 ‰ guardado como 0,6 %)');
  const ed = await actualizarRetencion(ica.id, { ...base, codigo: 'PRUEBA-9OCT-ICA', tipo: 'RETEICA', tarifa: 0.5, nombre: 'Prueba editada' });
  comprobar(Number(ed.tarifa) === 0.5 && /EDITADA/i.test(ed.nombre), 'se edita (tarifa y nombre)');
  try { await crearRetencion({ ...base, codigo: 'PRUEBA-9OCT-ICA', tipo: 'RETEICA' }); comprobar(false, 'código repetido debía rechazarse'); } catch (e) {
    comprobar(/Ya existe una retención con el código/.test(e.message), `código repetido → «${e.message}»`);
  }
  try { await crearRetencion({ ...base, codigo: 'X', tipo: 'RETEICA', aplica_a: '' }); comprobar(false, 'sin «aplica a» debía rechazarse'); } catch (e) {
    comprobar(/ventas .* compras/.test(e.message), `sin «aplica a» → «${e.message}»`);
  }

  // Eliminar una que está en un borrador: se quita de él y el total se recalcula.
  const rf = await crearRetencion({ ...base, codigo: 'PRUEBA-9OCT-RF', tipo: 'RETEFUENTE', tarifa: 10 });
  creadas.push(rf.id);
  const usuario = (await pool.query(`SELECT id FROM sst.usuarios ORDER BY creado_en LIMIT 1`)).rows[0].id;
  const cliente = (await pool.query(`SELECT id FROM sst.terceros WHERE activo AND es_cliente AND NOT es_arl ORDER BY creado_en LIMIT 1`)).rows[0];
  const b = await crearBorradorManual({
    tercero_id: cliente.id, items: [{ descripcion: 'Prueba 9 oct', cantidad: 1, valor_unitario: 1000000 }], retenciones_ids: [rf.id],
  }, usuario);
  try {
    const conRet = Number(b.totales.total_a_pagar);
    const del = await eliminarRetencion(rf.id);
    creadas.splice(creadas.indexOf(rf.id), 1);
    const b2 = await obtenerBorrador(b.id);
    comprobar(del.borradores === 1 && b2.retenciones.length === 0, 'eliminar una retención la quita del borrador que la tenía');
    comprobar(Number(b2.total_a_pagar) === conRet + 100000, `y el total guardado del borrador sube lo que restaba (${conRet} → ${b2.total_a_pagar})`);
  } finally {
    await eliminarBorrador(b.id);
  }

  // Una ya usada en algo emitido no se elimina.
  const rf2 = await crearRetencion({ ...base, codigo: 'PRUEBA-9OCT-RF2', tipo: 'RETEFUENTE', tarifa: 10 });
  creadas.push(rf2.id);
  const b3 = await crearBorradorManual({
    tercero_id: cliente.id, items: [{ descripcion: 'Prueba 9 oct (emitida)', cantidad: 1, valor_unitario: 1000000 }], retenciones_ids: [rf2.id],
  }, usuario);
  await pool.query(`UPDATE sst.documentos_electronicos SET estado = 'RECHAZADO' WHERE id = $1`, [b3.id]);
  try {
    await eliminarRetencion(rf2.id);
    creadas.splice(creadas.indexOf(rf2.id), 1);
    comprobar(false, 'una retención ya usada en un documento enviado debía rechazarse');
  } catch (e) {
    comprobar(e.statusCode === 409 && /Inactívela/.test(e.message), `usada en algo enviado → «${e.message}»`);
  } finally {
    await pool.query(`DELETE FROM sst.documento_eventos WHERE documento_id = $1`, [b3.id]).catch(() => {});
    await pool.query(`DELETE FROM sst.documentos_electronicos WHERE id = $1`, [b3.id]);
  }
  // Inactivar y reactivar sigue funcionando.
  const off = await setRetencionActiva(ica.id, false);
  comprobar(off.activa === false, 'se inactiva');
} catch (e) {
  comprobar(false, `parte 2 se cayó: ${e.stack}`);
} finally {
  for (const id of creadas) await eliminarRetencion(id).catch((e) => console.log(`· no se pudo limpiar ${id}: ${e.message}`));
}

// ─── Parte 3 · nombres del cargue de terceros ─────────────────────────────────────────────
const casos = [
  ['ALEJANDRO BOLAÑOS BELTRAN', 'ALEJANDRO', 'BOLAÑOS BELTRAN'],
  ['JUAN CAMILO CERON BOLAÑOS', 'JUAN CAMILO', 'CERON BOLAÑOS'],
  ['KAREN ALEJANDRA DE LA CRUZ RAMIREZ', 'KAREN ALEJANDRA', 'DE LA CRUZ RAMIREZ'],
  ['NANCY DEL CARMEN CERVANTES DELGADO', 'NANCY DEL CARMEN', 'CERVANTES DELGADO'],
  ['LYDIA ROSAS DE NOGUERA', 'LYDIA', 'ROSAS DE NOGUERA'],
  ['DANIELA PAZ SUAREZ', 'DANIELA', 'PAZ SUAREZ'],
];
for (const [n, nom, ape] of casos) {
  const p = partirNombre(n);
  comprobar(p.nombres === nom && p.apellidos === ape, `«${n}» → ${p.nombres} | ${p.apellidos}`);
}

const residuos = (await pool.query(`SELECT count(*)::int AS n FROM sst.retenciones WHERE codigo LIKE 'PRUEBA-%'`)).rows[0].n;
comprobar(residuos === 0, `sin residuos de prueba (${residuos})`);
await pool.end();
console.log(fallos ? `\n${fallos} FALLO(S)` : '\nTodo OK');
process.exit(fallos ? 1 : 0);
