// Siembra en jdd_dev órdenes INVENTADAS, ya FINALIZADAS, para probar la pantalla
// de Facturación de punta a punta: cada pagador con casos facturables y con los
// motivos de bloqueo que la contadora tiene que poder ver.
//
//   node --import tsx scripts/sembrar-facturacion-demo.mjs            siembra (si ya hay, no repite)
//   node --import tsx scripts/sembrar-facturacion-demo.mjs --limpiar  borra lo sembrado
//
// Las órdenes se crean por el mismo camino que una real (lote → borrador →
// `materializarOrden`) y luego se avanzan a FINALIZADA con su historial, así que
// también aparecen en Órdenes. Todo lo sembrado cuelga de lotes cuyo nombre
// empieza por DEMO-FACTURACION; los terceros inventados usan NIT 9009991xx y
// correo de desarrollador (Factus le escribe al correo del tercero, fuera de la
// redirección de Orbita). Solo corre contra jdd_dev.
//
// Escenarios:
//  · AXA (tarifa 58.856/h): 4 facturables y 1 con la ARL aún PENDIENTE.
//  · Colmena (sin tarifa): 2 con el valor de la orden y 1 sin valor, que el
//    borrador obliga a completar.
//  · Bolívar: prefactura 990610 con 3 órdenes + 1 fila de otro proveedor; 1
//    orden con prefactura no cargada y 1 pendiente de aprobación.
//  · Particulares (A3-01, IVA 19 %): un hotel con tarifa por hora y una persona
//    natural con el valor escrito en la orden.
import { pool } from '../src/config/db.js';
import { materializarOrden } from '../src/modules/imports/drafts.routes.js';
import { calcularDv } from '../src/utils/nit.js';

const MARCA = 'DEMO-FACTURACION';
const PREFACTURA = '990610';
const CORREO_DEV = 'escalappsystem@gmail.com';

if (!/@localhost:5433\/jdd_dev\b/.test(process.env.DATABASE_URL ?? '')) {
  console.error('Este script solo corre contra jdd_dev (túnel en localhost:5433).');
  process.exit(1);
}

const limpiar = process.argv.includes('--limpiar');
const client = await pool.connect();

async function borrarSembrado() {
  const ordenes = (await client.query(
    `SELECT o.id, o.codigo, EXISTS (SELECT 1 FROM sst.documento_ordenes d WHERE d.orden_id = o.id) AS facturada
       FROM sst.ordenes_servicio o JOIN sst.lotes_importacion l ON l.id = o.lote_importacion_id
      WHERE l.nombre_archivo LIKE $1`, [`${MARCA}%`],
  )).rows;
  const conDocumento = ordenes.filter((o) => o.facturada);
  if (conDocumento.length) {
    // Una factura (aunque sea del sandbox) es un documento con su historial: no se
    // borra por debajo. Se avisa y se deja todo como está.
    throw new Error(`Hay órdenes sembradas dentro de documentos de facturación (${conDocumento.map((o) => o.codigo).join(', ')}). `
      + 'Elimine los borradores desde la app; las ya VALIDADAS no se pueden limpiar con este script.');
  }
  const ids = ordenes.map((o) => o.id);
  await client.query(`DELETE FROM sst.prefactura_filas WHERE prefactura_id IN (SELECT id FROM sst.prefacturas WHERE numero_prefactura = $1)`, [PREFACTURA]);
  await client.query(`DELETE FROM sst.prefacturas WHERE numero_prefactura = $1`, [PREFACTURA]);
  await client.query(`DELETE FROM sst.historial_estados_orden WHERE orden_id = ANY($1::uuid[])`, [ids]);
  await client.query(`DELETE FROM sst.borradores_extraccion WHERE lote_importacion_id IN (SELECT id FROM sst.lotes_importacion WHERE nombre_archivo LIKE $1)`, [`${MARCA}%`]);
  await client.query(`DELETE FROM sst.ordenes_servicio WHERE id = ANY($1::uuid[])`, [ids]);
  await client.query(`DELETE FROM sst.lotes_importacion WHERE nombre_archivo LIKE $1`, [`${MARCA}%`]);
  await client.query(`DELETE FROM sst.tarifas_venta WHERE pagador_tercero_id IN (SELECT id FROM sst.terceros WHERE numero_documento LIKE '9009991%' OR numero_documento = '1085999001')`);
  const t = await client.query(
    `DELETE FROM sst.terceros t WHERE (numero_documento LIKE '9009991%' OR numero_documento = '1085999001')
        AND NOT EXISTS (SELECT 1 FROM sst.documentos_electronicos d WHERE d.tercero_id = t.id)`,
  );
  return { ordenes: ids.length, terceros: t.rowCount };
}

try {
  await client.query('BEGIN');

  if (limpiar) {
    const r = await borrarSembrado();
    await client.query('COMMIT');
    console.log(`Limpieza hecha: ${r.ordenes} órdenes y ${r.terceros} terceros inventados borrados.`);
    process.exit(0);
  }

  const ya = (await client.query(`SELECT count(*)::int AS n FROM sst.lotes_importacion WHERE nombre_archivo LIKE $1`, [`${MARCA}%`])).rows[0].n;
  if (ya) {
    console.log('Ya hay datos sembrados. Para volver a empezar: --limpiar y luego sembrar otra vez.');
    await client.query('ROLLBACK');
    process.exit(0);
  }

  const uno = async (sql, p = []) => (await client.query(sql, p)).rows[0];
  const admin = await uno(`SELECT id FROM sst.usuarios WHERE rol::text = 'admin' ORDER BY creado_en LIMIT 1`);
  const arl = async (nombre) => uno(`SELECT id, tercero_id FROM sst.arls WHERE nombre = $1`, [nombre]);
  const axa = await arl('AXA Colpatria');
  const colmena = await arl('Colmena');
  const bolivar = await arl('Bolívar');
  const tipos = Object.fromEntries((await client.query(`SELECT id, nombre, valor_hora FROM sst.tipos_orden`)).rows.map((t) => [t.nombre, t]));
  const profesionales = (await client.query(`SELECT id FROM sst.profesionales WHERE estado = 'Activo' ORDER BY nombre`)).rows;
  const nit = (await uno(`SELECT id FROM sst.tipos_documento_identidad WHERE codigo_dian = '31'`)).id;
  const cedula = (await uno(`SELECT id FROM sst.tipos_documento_identidad WHERE codigo_dian = '13'`)).id;
  const pasto = (await uno(`SELECT id FROM sst.municipios WHERE nombre = 'Pasto' LIMIT 1`)).id;

  // Las ARL de jdd_dev sin correo de facturación: se les pone el del
  // desarrollador para que Factus no intente escribirle a nadie más.
  const conCorreo = await client.query(
    `UPDATE sst.terceros SET correo_facturacion = $1
      WHERE id = ANY($2::uuid[]) AND correo_facturacion IS NULL RETURNING razon_social`,
    [CORREO_DEV, [axa.tercero_id, colmena.tercero_id, bolivar.tercero_id]],
  );

  // ── Clientes particulares inventados ─────────────────────────────────────
  const tercero = async (t) => uno(
    `INSERT INTO sst.terceros (tipo_persona, tipo_documento_id, numero_documento, dv, razon_social, nombres, apellidos,
                               direccion, municipio_id, telefono, correo_facturacion, responsabilidades_fiscales,
                               regimen, es_cliente, activo, creado_por)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '{}', $12, true, true, $13) RETURNING id`,
    [t.persona, t.tipoDoc, t.numero, t.tipoDoc === nit ? calcularDv(t.numero) : null, t.razon ?? null, t.nombres ?? null,
     t.apellidos ?? null, t.direccion, pasto, t.telefono, CORREO_DEV, t.regimen, admin.id],
  );
  const hotel = await tercero({
    persona: 'JURIDICA', tipoDoc: nit, numero: '900999101', razon: 'HOTEL MIRADOR DE GALERAS SAS',
    direccion: 'Calle 18 # 25-40', telefono: '6027310000', regimen: 'RESPONSABLE_IVA',
  });
  const laura = await tercero({
    persona: 'NATURAL', tipoDoc: cedula, numero: '1085999001', nombres: 'Laura', apellidos: 'Martínez Rosero',
    direccion: 'Carrera 27 # 12-15', telefono: '3001234567', regimen: 'NO_RESPONSABLE',
  });
  await client.query(
    `INSERT INTO sst.tarifas_venta (pagador_tercero_id, unidad, valor, vigente_desde, activo) VALUES ($1, 'HORA', 90000, '2026-01-01', true)`,
    [hotel.id],
  );

  // ── Una orden: lote → borrador → materializar → avanzar a FINALIZADA ─────
  let n = 0;
  const hoy = new Date();
  const dias = (d) => new Date(hoy.getTime() + d * 86400000).toISOString().slice(0, 10);
  const lotes = {};
  const creadas = [];

  async function orden(c) {
    const loteNombre = `${MARCA} · ${c.grupo}`;
    lotes[loteNombre] ??= (await uno(
      `INSERT INTO sst.lotes_importacion (subido_por, nombre_archivo, estado, total_ordenes) VALUES ($1, $2, 'PROCESADO', 0) RETURNING id`,
      [admin.id, loteNombre],
    )).id;
    const campos = {
      numero_orden: c.numero_orden, codigo_cronograma: c.cronograma, secuencia: c.secuencia,
      empresa_nombre: c.empresa, nit_nic: c.nit_empresa, tipo_actividad: c.actividad,
      horas_asignadas: String(c.horas), valor_total: c.valor_total != null ? String(c.valor_total) : null,
      fecha_orden: dias(-40), fecha_vencimiento: dias(20), ciudad_ejecucion: c.ciudad ?? 'Pasto',
      direccion: c.direccion ?? 'Dirección de prueba', descripcion: c.descripcion ?? c.actividad,
      modalidad_ejecucion: c.cronograma ? 'PRESENCIAL' : null, tipo_servicio_arl: c.cronograma ? 'A' : null,
    };
    const metadatos = Object.fromEntries(
      Object.entries(campos).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, { value: v, confidence: 100 }]),
    );
    metadatos.overall_confidence = 100;
    const tipo = tipos[c.tipo];
    const draft = await uno(
      `INSERT INTO sst.borradores_extraccion (lote_importacion_id, arl_id, confianza_general, metadatos_extraccion, estado, tipo_orden_id, pagador_tercero_id)
       VALUES ($1, $2, 100, $3, 'PENDIENTE_REVISION', $4, $5) RETURNING id`,
      [lotes[loteNombre], c.arl?.id ?? null, metadatos, tipo.id, c.pagador ?? null],
    );
    const os = await materializarOrden(draft.id, admin.id, client);

    // Mismo recorrido que en la app: programar → ejecutar → aceptar soportes.
    const prof = profesionales[n++ % profesionales.length];
    const programada = new Date(`${dias(c.hace ?? -10)}T14:00:00Z`);
    await client.query(
      `UPDATE sst.ordenes_servicio
          SET profesional_asignado_id = $2, fecha_programada = $3, valor_hora_cobro = $4, valor_hora_origen = 'tipo',
              estado = 'FINALIZADA', fecha_ejecucion = $3::timestamptz + interval '3 hours',
              soportes_aceptados_en = $3::timestamptz + interval '1 day', soportes_aceptados_por = $5,
              estado_arl = $6::sst.estado_arl, estado_arl_en = CASE WHEN $6 = 'APROBADO' THEN now() END,
              estado_arl_por = CASE WHEN $6 = 'APROBADO' THEN $5::uuid END, numero_prefactura = $7
        WHERE id = $1`,
      [os.id, prof.id, programada, tipo.valor_hora, admin.id, c.estado_arl ?? 'APROBADO', c.prefactura ?? null],
    );
    for (const [antes, despues, motivo] of [
      ['SIN PROGRAMAR', 'PROGRAMADA', null],
      ['PROGRAMADA', 'EJECUTADA', 'Soportes cargados por el profesional'],
      ['EJECUTADA', 'FINALIZADA', 'Soportes revisados y aceptados'],
    ]) {
      await client.query(
        `INSERT INTO sst.historial_estados_orden (orden_id, estado_anterior, estado_nuevo, cambiado_por, motivo) VALUES ($1, $2, $3, $4, $5)`,
        [os.id, antes, despues, admin.id, motivo ? `${motivo} (datos de prueba)` : 'Datos de prueba'],
      );
    }
    creadas.push({ codigo: os.codigo, grupo: c.grupo, empresa: c.empresa, horas: c.horas, estado_arl: c.estado_arl ?? 'APROBADO', nota: c.nota ?? '' });
    return os.id;
  }

  // AXA ──────────────────────────────────────────────────────────────────────
  const A = { grupo: 'AXA', arl: axa };
  await orden({ ...A, numero_orden: 'AXD-2026-0101', empresa: 'PANADERÍA LA ESPIGA DORADA SAS', nit_empresa: '900999201-1', tipo: 'Asesoría', actividad: 'Actualización de la matriz de peligros', horas: 4 });
  await orden({ ...A, numero_orden: 'AXD-2026-0102', empresa: 'CONSTRUCCIONES ANDINAS DEL SUR SAS', nit_empresa: '900999202-8', tipo: 'Capacitación', actividad: 'Capacitación en trabajo seguro en alturas', horas: 2.5 });
  await orden({ ...A, numero_orden: 'AXD-2026-0103', empresa: 'FERRETERÍA EL TORNILLO FELIZ SAS', nit_empresa: '900999203-6', tipo: 'Inspección', actividad: 'Inspección de extintores y botiquines', horas: 6, ciudad: 'Ipiales' });
  await orden({ ...A, numero_orden: 'AXD-2026-0104', empresa: 'AGROINDUSTRIAS DEL PACÍFICO SAS', nit_empresa: '900999204-3', tipo: 'Asesoría', actividad: 'Investigación de accidente de trabajo', horas: 3 });
  await orden({ ...A, numero_orden: 'AXD-2026-0105', empresa: 'DISTRIBUIDORA MUNDO FRESCO SAS', nit_empresa: '900999205-0', tipo: 'Capacitación', actividad: 'Pausas activas y ergonomía', horas: 2, estado_arl: 'PENDIENTE', nota: 'bloqueada: ARL pendiente' });

  // Colmena (sin tarifa de venta) ────────────────────────────────────────────
  const C = { grupo: 'Colmena', arl: colmena };
  await orden({ ...C, numero_orden: 'CLD-55001', empresa: 'COLEGIO PEDAGÓGICO LOS ANDES', nit_empresa: '900999206-9', tipo: 'Capacitación', actividad: 'Plan de emergencias escolar', horas: 3, valor_total: 210000 });
  await orden({ ...C, numero_orden: 'CLD-55002', empresa: 'COOPERATIVA LÁCTEA DEL GUÁITARA', nit_empresa: '900999207-6', tipo: 'Asesoría', actividad: 'Diseño del SG-SST', horas: 2, valor_total: 150000 });
  await orden({ ...C, numero_orden: 'CLD-55003', empresa: 'CLÍNICA VETERINARIA SAN FRANCISCO', nit_empresa: '900999208-4', tipo: 'Inspección', actividad: 'Inspección de riesgo biológico', horas: 4, nota: 'sin valor: hay que escribirlo en el borrador' });

  // Bolívar ──────────────────────────────────────────────────────────────────
  const B = { grupo: 'Bolívar', arl: bolivar };
  const b1 = await orden({ ...B, cronograma: '8801', secuencia: '1', prefactura: PREFACTURA, empresa: 'TRANSPORTES RÁPIDO NARIÑO LTDA', nit_empresa: '900999209-1', tipo: 'Asesoría', actividad: 'Plan estratégico de seguridad vial', horas: 2 });
  const b2 = await orden({ ...B, cronograma: '8801', secuencia: '2', prefactura: PREFACTURA, empresa: 'HOTEL LAS AMÉRICAS DE PASTO SAS', nit_empresa: '900999210-5', tipo: 'Capacitación', actividad: 'Brigada de emergencia', horas: 3 });
  const b3 = await orden({ ...B, cronograma: '8802', secuencia: '1', prefactura: PREFACTURA, empresa: 'LABORATORIO CLÍNICO SANTA CLARA SAS', nit_empresa: '900999211-2', tipo: 'Inspección', actividad: 'Inspección de puestos de trabajo', horas: 1.5 });
  await orden({ ...B, cronograma: '8803', secuencia: '1', prefactura: '990611', empresa: 'MOLINO DE TRIGO EL SOL SAS', nit_empresa: '900999212-0', tipo: 'Asesoría', actividad: 'Programa de conservación auditiva', horas: 2, nota: 'bloqueada: su prefactura 990611 no está cargada' });
  await orden({ ...B, cronograma: '8804', secuencia: '1', empresa: 'TALLER AUTOMOTRIZ EL PISTÓN SAS', nit_empresa: '900999213-7', tipo: 'Capacitación', actividad: 'Manejo seguro de sustancias químicas', horas: 2, estado_arl: 'PENDIENTE', nota: 'bloqueada: ARL pendiente, sin prefactura' });

  const pf = await uno(
    `INSERT INTO sst.prefacturas (numero_prefactura, plan_codigo, plan_descripcion, fecha_corte, valor_total, nombre_archivo, cargada_por)
     VALUES ($1, 'PLAN-DEMO', 'Prefactura inventada para pruebas', $2, $3, 'prefactura-990610-demo.pdf', $4) RETURNING id`,
    [PREFACTURA, dias(-2), 142914 + 214371 + 107186 + 142914, admin.id],
  );
  const fila = (ordenId, cron, sec, razon, actividad, valor) => client.query(
    `INSERT INTO sst.prefactura_filas (prefactura_id, orden_id, codigo_cronograma, secuencia, razon_social, actividad_programa,
                                       valor_actividad, alimentacion, alojamiento, transporte, material, tiempo_muerto, valor_a_facturar)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, 0, 0, 0, $7)`,
    [pf.id, ordenId, cron, sec, razon, actividad, valor],
  );
  await fila(b1, '8801', '1', 'TRANSPORTES RÁPIDO NARIÑO LTDA', 'PLAN ESTRATEGICO DE SEGURIDAD VIAL', 142914);
  await fila(b2, '8801', '2', 'HOTEL LAS AMÉRICAS DE PASTO SAS', 'BRIGADA DE EMERGENCIA', 214371);
  await fila(b3, '8802', '1', 'LABORATORIO CLÍNICO SANTA CLARA SAS', 'INSPECCION DE PUESTOS DE TRABAJO', 107186);
  // Una fila que Orbita no conoce (Bolívar la pagó a otro proveedor): sale en la
  // prefactura, pero sin marcar.
  await fila(null, '8809', '1', 'EMPRESA DE OTRO PROVEEDOR SAS', 'ASESORIA', 142914);

  // Particulares (A3-01) ─────────────────────────────────────────────────────
  await orden({ grupo: 'Particulares', pagador: hotel.id, empresa: 'HOTEL MIRADOR DE GALERAS SAS', nit_empresa: `900999101-${calcularDv('900999101')}`, tipo: 'Asesoría', actividad: 'Auditoría interna del SG-SST', horas: 4 });
  await orden({ grupo: 'Particulares', pagador: hotel.id, empresa: 'HOTEL MIRADOR DE GALERAS SAS', nit_empresa: `900999101-${calcularDv('900999101')}`, tipo: 'Capacitación', actividad: 'Capacitación a brigadistas', horas: 2 });
  await orden({ grupo: 'Particulares', pagador: laura.id, empresa: 'Laura Martínez Rosero', nit_empresa: '1085999001', tipo: 'Asesoría', actividad: 'Asesoría para su emprendimiento de repostería', horas: 3, valor_total: 350000, nota: 'persona natural, valor escrito en la orden' });

  for (const [nombre, id] of Object.entries(lotes)) {
    await client.query(`UPDATE sst.lotes_importacion SET total_ordenes = (SELECT count(*) FROM sst.ordenes_servicio WHERE lote_importacion_id = $1) WHERE id = $1`, [id]);
    void nombre;
  }

  await client.query('COMMIT');
  if (conCorreo.rowCount) console.log(`Correo de facturación puesto en ${CORREO_DEV}: ${conCorreo.rows.map((r) => r.razon_social).join(', ')}`);
  console.table(creadas);
  console.log(`Prefactura ${PREFACTURA} de Bolívar cargada con 4 filas (3 con orden, 1 de otro proveedor).`);
} catch (e) {
  await client.query('ROLLBACK');
  console.error('No se sembró nada:', e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
