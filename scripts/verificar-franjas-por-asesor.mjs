// Verifica el cambio del 7-oct-2026 contra jdd_dev DENTRO de una transacción con
// ROLLBACK (no deja nada): varios asesores en una orden, CADA UNO CON SU HORARIO.
//   · sale un juego de formatos por asesor, con las franjas de cada uno;
//   · con un solo asesor los formatos salen exactamente como antes;
//   · con suplente (`profesional_formatos_id`) todos los juegos van a su nombre;
//   · las invitaciones de calendario de dos asesores no comparten UID.
//
// Uso: node --import tsx scripts/verificar-franjas-por-asesor.mjs   (requiere el túnel a jdd_dev)
import { readFileSync } from 'node:fs';
import { pool } from '../src/config/db.js';
import { asesoresSinEntregar, generateOrderDocuments } from '../src/modules/orders/orders.service.js';
import { construirInvitaciones } from '../src/services/calendar.service.js';

let fallos = 0;
const igual = (obtenido, esperado, texto) => {
  const ok = JSON.stringify(obtenido) === JSON.stringify(esperado);
  if (!ok) fallos++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${texto} → ${JSON.stringify(obtenido)}${ok ? '' : ` (esperado ${JSON.stringify(esperado)})`}`);
};
const sinTransaccion = (archivo) => readFileSync(new URL(`../db/migraciones/${archivo}`, import.meta.url), 'utf8')
  .replace(/^\s*BEGIN;\s*$/m, '').replace(/^\s*COMMIT;\s*$/m, '');

const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query(sinTransaccion('2026-10-07-franjas-por-profesional.sql'));
  await client.query(sinTransaccion('2026-10-07-soportes-por-asesor.sql'));

  const arl = (await client.query(`SELECT id, nombre FROM sst.arls WHERE nombre ILIKE '%bol%' LIMIT 1`)).rows[0];
  if (!arl) throw new Error('No hay ARL Bolívar en la base: la prueba necesita una ARL con formatos propios.');
  const [principal, coasesor, suplente] = (await client.query(
    `INSERT INTO sst.profesionales (nombre, correo, valor_hora) VALUES
       ('ZZ PRUEBA PRINCIPAL', 'zz-principal@prueba.invalid', 50000),
       ('ZZ PRUEBA COASESOR',  'zz-coasesor@prueba.invalid',  40000),
       ('ZZ PRUEBA SUPLENTE',  'zz-suplente@prueba.invalid',  40000)
     RETURNING id, nombre, correo`
  )).rows;
  const orden = (await client.query(
    `INSERT INTO sst.ordenes_servicio
       (codigo, empresa_nombre, horas_asignadas, estado, profesional_asignado_id, arl_id, numero_orden)
     VALUES ('OS-ZZ-FRANJAS', 'EMPRESA DE PRUEBA', 8, 'SIN PROGRAMAR', $1, $2, 'ZZ-PRUEBA-FRANJAS')
     RETURNING id`,
    [principal.id, arl.id]
  )).rows[0];
  const franja = (de, fecha, ini, fin) => client.query(
    `INSERT INTO sst.franjas_visita (orden_id, profesional_id, fecha, hora_inicio, hora_fin) VALUES ($1,$2,$3,$4,$5)`,
    [orden.id, de, fecha, ini, fin]
  );
  const docs = async () => generateOrderDocuments(orden.id, client, { guardar: false });
  const resumen = (lista) => lista.map((d) => `${d._profesionalNombre ?? '(orden)'} · ${d._filename}`).sort();

  // ---- Un solo asesor: como siempre ----
  await franja(null, '2099-01-15', '08:00', '12:00');
  await franja(null, '2099-01-16', '08:00', '12:00');
  const solo = await docs();
  igual(solo.length > 0, true, `un solo asesor: salen formatos de ${arl.nombre} (${solo.length})`);
  igual(solo.every((d) => !d._profesionalId), true, 'un solo asesor: ningún formato lleva dueño (van todos al asignado)');
  igual(solo.some((d) => /^ZZ-PRUEBA/.test(d._filename)), false, 'un solo asesor: los archivos conservan su nombre de siempre');

  // ---- Dos asesores, cada uno con su horario ----
  await client.query(`DELETE FROM sst.franjas_visita WHERE orden_id = $1`, [orden.id]);
  await client.query(
    `INSERT INTO sst.orden_coasesores (orden_id, profesional_id, horas, valor_hora_cobro, valor_hora_origen)
     VALUES ($1, $2, 4, 40000, 'profesional')`,
    [orden.id, coasesor.id]
  );
  await franja(null, '2099-01-15', '08:00', '12:00');        // principal: jueves por la mañana
  await franja(coasesor.id, '2099-01-20', '14:00', '18:00'); // coasesor: otro día, por la tarde
  const dos = await docs();
  console.log('     ' + resumen(dos).join('\n     '));
  const dePrincipal = dos.filter((d) => d._profesionalId === principal.id);
  const deCoasesor = dos.filter((d) => d._profesionalId === coasesor.id);
  igual(dos.every((d) => !!d._profesionalId), true, 'dos asesores: todo formato dice de quién es');
  igual([dePrincipal.length > 0, deCoasesor.length > 0, dePrincipal.length === deCoasesor.length], [true, true, true],
    `dos asesores: un juego para cada uno, del mismo tamaño (${dePrincipal.length} y ${deCoasesor.length})`);
  igual(new Set(dos.map((d) => d._filename)).size, dos.length, 'ningún archivo repite nombre (no se pisan en el almacenamiento)');
  igual([dePrincipal.every((d) => d._filename.startsWith('ZZ-PRUEBA-PRINCIPAL_')), deCoasesor.every((d) => d._filename.startsWith('ZZ-PRUEBA-COASESOR_'))],
    [true, true], 'cada archivo lleva delante el nombre de su asesor');
  igual(dePrincipal.some((d, i) => !d._buffer.equals(deCoasesor[i]._buffer)), true,
    'los dos juegos NO son iguales: cada uno lleva su nombre y su horario');

  // ---- El coasesor con dos franjas: sus formatos de sesión salen por cada una ----
  await client.query(`UPDATE sst.orden_coasesores SET horas = 6 WHERE orden_id = $1`, [orden.id]);
  await client.query(`UPDATE sst.franjas_visita SET hora_fin = '10:00' WHERE orden_id = $1 AND profesional_id IS NULL`, [orden.id]);
  await franja(coasesor.id, '2099-01-21', '08:00', '10:00');
  const tres = await docs();
  igual(tres.filter((d) => d._profesionalId === coasesor.id).length >= tres.filter((d) => d._profesionalId === principal.id).length, true,
    `el asesor con dos franjas no recibe menos documentos que el de una (${tres.filter((d) => d._profesionalId === coasesor.id).length} y ${tres.filter((d) => d._profesionalId === principal.id).length})`);

  // ---- Suplente: todos los juegos a nombre del registrado ----
  await client.query(`UPDATE sst.ordenes_servicio SET profesional_formatos_id = $2 WHERE id = $1`, [orden.id, suplente.id]);
  const conSuplente = await docs();
  igual(conSuplente.filter((d) => d._profesionalId === coasesor.id).length > 0, true,
    'con suplente siguen saliendo los dos juegos (uno por horario)');

  // ---- Invitaciones: UID distinto por asesor ----
  const ordenIcs = { id: orden.id, codigo: 'OS-ZZ-FRANJAS', empresa_nombre: 'EMPRESA DE PRUEBA', horas_asignadas: 8 };
  const uid = (inv) => (inv.contenido.match(/^UID:(.+)$/m) ?? [])[1]?.trim();
  const f1 = [{ fecha: '2099-01-15', hora_inicio: '08:00', hora_fin: '12:00' }];
  const delPrincipal = construirInvitaciones({ orden: ordenIcs, profesional: principal, organizador: {}, franjas: f1 });
  const delCoasesor = construirInvitaciones({
    orden: ordenIcs, profesional: coasesor, organizador: {}, franjas: f1, sufijoUid: `-${coasesor.id.slice(0, 8)}`,
  });
  igual(uid(delPrincipal[0]), `os-${orden.id}-1@jdd-iacore`, 'la invitación del principal conserva su UID de siempre');
  igual(uid(delCoasesor[0]) !== uid(delPrincipal[0]), true, 'la del asesor adicional tiene otro UID: no se pisan en el calendario de quien va en copia');

  // ---- 7-oct-2026 · Soportes por asesor: la orden espera a TODOS ----
  const falta = async () => (await asesoresSinEntregar(orden.id, client)).map((x) => x.nombre);
  igual(await falta(), ['ZZ PRUEBA PRINCIPAL', 'ZZ PRUEBA COASESOR'], 'sin enlaces entregados, faltan los dos (el principal primero)');
  const enlace = (de, entregado) => client.query(
    `INSERT INTO sst.enlaces_publicos (orden_id, token, profesional_id, entregado_en)
     VALUES ($1, $2, $3, $4)`, [orden.id, `zz-${de ?? 'principal'}`, de, entregado ? new Date() : null]
  );
  await enlace(null, true);
  await enlace(coasesor.id, false);
  igual(await falta(), ['ZZ PRUEBA COASESOR'], 'entregó el principal: sigue faltando el asesor adicional');
  await client.query(`UPDATE sst.enlaces_publicos SET entregado_en = now() WHERE orden_id = $1 AND profesional_id = $2`, [orden.id, coasesor.id]);
  igual(await falta(), [], 'entregaron los dos: no falta nadie (la orden puede pasar a EJECUTADA)');
  await client.query(`UPDATE sst.enlaces_publicos SET rechazados = '{acta}' WHERE orden_id = $1 AND profesional_id = $2`, [orden.id, coasesor.id]);
  igual(await falta(), ['ZZ PRUEBA COASESOR'], 'se le devuelve el acta al adicional: vuelve a faltar solo él');
  await client.query(`UPDATE sst.enlaces_publicos SET rechazados = NULL WHERE orden_id = $1`, [orden.id]);
  await client.query(`UPDATE sst.ordenes_servicio SET soportes_rechazados = '{asistencia}' WHERE id = $1`, [orden.id]);
  igual(await falta(), ['ZZ PRUEBA PRINCIPAL'], 'se le devuelve la asistencia al principal: vuelve a faltar solo él');
} catch (e) {
  fallos++;
  console.error('ERROR', e.message);
} finally {
  await client.query('ROLLBACK');
  client.release();
  await pool.end();
}
console.log(fallos ? `\n${fallos} fallo(s).` : '\nTodo en verde. Nada quedó escrito (ROLLBACK).');
process.exit(fallos ? 1 : 0);
