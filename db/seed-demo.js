/**
 * Seed de DEMO: llena todas las categorías con datos realistas de SST colombiano
 * para una visualización rica del sistema. Idempotente (limpia y recarga los datos
 * transaccionales; conserva y complementa catálogos, usuarios y profesionales).
 *
 *   npm run seed:demo
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { pool, withTransaction } from '../src/config/db.js';

const token = () => crypto.randomBytes(18).toString('base64url');
const iso = (daysAgo, hour = 9) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

// Campos canónicos → construye metadatos_extraccion con {value, confidence}.
function meta(o, base, engine) {
  const c = (delta = 0) => Math.max(30, Math.min(100, base + delta));
  return {
    codigo_cronograma: { value: o.cron, confidence: c(4) },
    secuencia: { value: o.sec, confidence: c(5) },
    nit_nic: { value: o.nit, confidence: c(o.lowNit ? -18 : 2) },
    empresa_nombre: { value: o.empresa, confidence: c(6) },
    actividad_economica: { value: o.actividad, confidence: c(-2) },
    horas_asignadas: { value: String(o.horas), confidence: c(o.lowHoras ? -20 : 3) },
    contacto_sst_nombre: { value: o.contacto, confidence: c(1) },
    contacto_sst_telefono: { value: o.tel, confidence: c(-4) },
    contacto_sst_correo: { value: o.correo, confidence: c(0) },
    descripcion: { value: o.desc, confidence: c(o.lowDesc ? -16 : -1) },
    overall_confidence: base,
    engine,
  };
}

// ------- Catálogo base de empresas / actividades (contexto real CO) -------
const EMPRESAS = [
  { empresa: 'Inversiones Andinas S.A.S', nit: '900.184.552-1', actividad: 'Construcción de edificios residenciales (CIIU 4111)', contacto: 'Laura Gómez Restrepo', tel: '+57 310 555 2210', correo: 'lgomez@inversionesandinas.co', desc: 'Capacitación en trabajo seguro en alturas para cuadrilla de obra; verificación de EPP y permisos.' },
  { empresa: 'Construcciones del Valle Ltda.', nit: '901.225.480-3', actividad: 'Obras de ingeniería civil (CIIU 4290)', contacto: 'Andrés Caicedo Mora', tel: '+57 313 402 8890', correo: 'a.caicedo@cvalle.com.co', desc: 'Inspección de condiciones de seguridad en obra civil; excavaciones y andamios certificados.' },
  { empresa: 'Logística Express Colombia', nit: '830.090.112-8', actividad: 'Almacenamiento y depósito (CIIU 5210)', contacto: 'María Fernanda Ruiz', tel: '+57 300 771 6642', correo: 'mfruiz@logexcol.com', desc: 'Evaluación de riesgo biomecánico en centro de distribución; pausas activas y ajuste de estaciones.' },
  { empresa: 'Agroindustrias del Caribe S.A.', nit: '900.770.331-5', actividad: 'Cultivo de palma de aceite (CIIU 0126)', contacto: 'Jorge Vélez Ariza', tel: '+57 315 220 1180', correo: 'jvelez@agrocaribe.co', desc: 'Programa de manejo de sustancias químicas y fumigación; capacitación en primeros auxilios.' },
  { empresa: 'Metalúrgica Nacional S.A.S', nit: '860.512.223-9', actividad: 'Fabricación de productos metálicos (CIIU 2599)', contacto: 'Sandra Milena Portilla', tel: '+57 320 118 4477', correo: 'sportilla@metalnal.co', desc: 'Medición de ruido y material particulado en planta; trabajo seguro con soldadura.' },
  { empresa: 'Textiles del Norte Ltda.', nit: '891.300.441-2', actividad: 'Fabricación de tejidos de punto (CIIU 1391)', contacto: 'Camilo Ortega Rincón', tel: '+57 301 664 9021', correo: 'cortega@textnorte.co', desc: 'Inspección ergonómica de puestos de costura y programa de higiene postural.' },
  { empresa: 'Alimentos La Sabana S.A.', nit: '900.334.128-7', actividad: 'Elaboración de productos alimenticios (CIIU 1084)', contacto: 'Paola Andrea Nieto', tel: '+57 312 887 3355', correo: 'pnieto@lasabana.com.co', desc: 'Verificación de protocolos de bioseguridad y manejo de cuartos fríos.' },
  { empresa: 'Transportes Rápido Andino', nit: '805.221.664-1', actividad: 'Transporte de carga por carretera (CIIU 4923)', contacto: 'Héctor Julio Mena', tel: '+57 318 442 7789', correo: 'hmena@rapidoandino.co', desc: 'Plan estratégico de seguridad vial (PESV) y evaluación de fatiga en conductores.' },
  { empresa: 'Petroquímica del Sur S.A.S', nit: '901.556.740-2', actividad: 'Fabricación de sustancias químicas básicas (CIIU 2011)', contacto: 'Diego Fernando Lara', tel: '+57 314 990 1122', correo: 'dlara@petrosur.co', desc: 'Trabajo seguro en espacios confinados y atención de emergencias químicas.' },
  { empresa: 'Minería El Dorado Ltda.', nit: '830.114.559-4', actividad: 'Extracción de oro y otros metales (CIIU 0729)', contacto: 'Yolanda Cortés Bravo', tel: '+57 316 550 8834', correo: 'ycortes@eldorado.co', desc: 'Trabajo en alturas y espacios confinados en socavón; ventilación y gases.' },
  { empresa: 'Hospital San Rafael', nit: '890.203.774-6', actividad: 'Actividades de hospitales (CIIU 8610)', contacto: 'Ruth Salinas Ávila', tel: '+57 317 220 6690', correo: 'rsalinas@hsanrafael.org', desc: 'Riesgo biológico y manejo de residuos hospitalarios; capacitación bioseguridad.' },
  { empresa: 'Universidad Central del Valle', nit: '891.900.121-3', actividad: 'Educación superior (CIIU 8543)', contacto: 'Mauricio Peña Gómez', tel: '+57 302 771 4408', correo: 'sst@ucvalle.edu.co', desc: 'Inspección de laboratorios y plan de emergencias de sedes.' },
];

const ARL_ROT = ['Bolívar', 'AXA Colpatria', 'Colmena'];

async function main() {
  console.log('== Seed de DEMO JD&D IA-Core ==');
  const hash = await bcrypt.hash('Demo123*', 10);

  await withTransaction(async (client) => {
    // 0 · Limpia datos transaccionales (conserva catálogos/usuarios/profesionales base)
    await client.query(`TRUNCATE
      sst.ordenes_servicio, sst.borradores_extraccion, sst.lotes_importacion,
      sst.notificaciones, sst.precuentas, sst.precuenta_items,
      sst.respuestas_encuesta, sst.tarifas_actividad_profesional
      RESTART IDENTITY CASCADE`);

    // 1 · Usuarios adicionales (varios roles) — login por documento
    const usuarios = [
      ['1010101010', 'Marcela Rueda (Asistente)', 'asistente@jdd.com', 'admin', '+57 301 111 0000', null],
      ['2020202020', 'Contadora Gloria Some', 'contadora@jdd.com', 'contador', '+57 302 222 0000', null],
      ['3030303030', 'Auditor Germán Ospina', 'auditor@jdd.com', 'auditor', '+57 303 333 0000', null],
    ];
    for (const [doc, nombre, correo, rol, tel, esp] of usuarios) {
      await client.query(
        `INSERT INTO sst.usuarios (documento_identidad, nombre, correo, contrasena_hash, rol, telefono, especialidad)
         SELECT $1,$2,$3,$4,$5,$6,$7 WHERE NOT EXISTS (SELECT 1 FROM sst.usuarios WHERE correo=$3)`,
        [doc, nombre, correo, hash, rol, tel, esp]
      );
    }

    // 2 · Profesionales (asesores de campo) — amplía a 8
    const profs = [
      ['Carlos Mendoza', 'cmendoza@jdd.com', '+57 300 111 2233', 'Tareas de Alto Riesgo', 55000, 'Activo'],
      ['Diana Patiño', 'dpatino@jdd.com', '+57 301 222 3344', 'Higiene Industrial', 50000, 'Activo'],
      ['Jorge Salazar', 'jsalazar@jdd.com', '+57 302 333 4455', 'Ergonomía', 48000, 'Activo'],
      ['Laura Gómez Restrepo', 'lgomezr@jdd.com', '+57 310 555 2210', 'Seguridad en el Trabajo', 52000, 'Activo'],
      ['Andrés Caicedo Mora', 'acaicedo@jdd.com', '+57 313 402 8890', 'Tareas de Alto Riesgo', 58000, 'Activo'],
      ['María Fernanda Ruiz', 'mfruiz@jdd.com', '+57 300 771 6642', 'Ergonomía', 47000, 'Inactivo'],
      ['Sebastián Ortiz', 'sortiz@jdd.com', '+57 318 660 9911', 'Medicina Preventiva', 60000, 'Activo'],
      ['Claudia Zapata', 'czapata@jdd.com', '+57 319 224 7788', 'Psicología Organizacional', 51000, 'Activo'],
    ];
    for (const [nombre, correo, tel, esp, vh, estado] of profs) {
      await client.query(
        `INSERT INTO sst.profesionales (nombre, correo, telefono, especialidad, valor_hora, estado)
         SELECT $1,$2,$3,$4,$5,$6 WHERE NOT EXISTS (SELECT 1 FROM sst.profesionales WHERE correo=$2)`,
        [nombre, correo, tel, esp, vh, estado]
      );
    }

    // Referencias
    const arlMap = Object.fromEntries((await client.query(`SELECT id,nombre FROM sst.arls`)).rows.map((r) => [r.nombre, r.id]));
    const arlFmt = { 'Bolívar': 'excel', 'AXA Colpatria': 'pdf', 'Colmena': 'pdf' };
    const activos = (await client.query(`SELECT id,nombre FROM sst.profesionales WHERE estado='Activo' ORDER BY nombre`)).rows;
    const admin = (await client.query(`SELECT id FROM sst.usuarios WHERE rol='admin' ORDER BY creado_en LIMIT 1`)).rows[0].id;
    const plantillas = (await client.query(`SELECT id,arl_id,tipo FROM sst.plantillas`)).rows;

    // 3 · Lotes de importación (mezcla de estados)
    const lotes = [];
    const loteDefs = [
      ['SIPAB_bolivar_semana27.xlsx', 'Bolívar', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'PROCESADO', 4, 2],
      ['axa_colpatria_lote_112.pdf', 'AXA Colpatria', 'application/pdf', 'PROCESADO', 3, 5],
      ['colmena_ordenes_08.pdf', 'Colmena', 'application/pdf', 'PROCESADO', 3, 8],
      ['SIPAB_bolivar_semana26.xlsx', 'Bolívar', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'PROCESADO', 5, 14],
      ['axa_escaneado_daniado.pdf', 'AXA Colpatria', 'application/pdf', 'ERROR', 0, 1],
      ['colmena_nuevo_lote.pdf', 'Colmena', 'application/pdf', 'PROCESANDO', 0, 0],
    ];
    for (const [fn, arl, mime, estado, total, dAgo] of loteDefs) {
      const r = await client.query(
        `INSERT INTO sst.lotes_importacion (subido_por, nombre_archivo, arl_detectada, url_archivo, tipo_mime, estado, mensaje_error, total_ordenes, creado_en)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [admin, fn, arlMap[arl] || null, `imports/2026/${fn}`, mime, estado,
         estado === 'ERROR' ? 'Documento ilegible: escaneo de baja calidad, se requiere reintento.' : null, total, iso(dAgo)]
      );
      lotes.push({ id: r.rows[0].id, arl });
    }

    // 4 · Borradores PENDIENTES de validación (para /drafts) + duplicados
    let bi = 0;
    const drafts = [];
    for (let k = 0; k < 8; k++) {
      const arl = ARL_ROT[k % 3];
      const emp = EMPRESAS[k % EMPRESAS.length];
      const isPdf = arlFmt[arl] === 'pdf';
      const base = isPdf ? (k % 3 === 0 ? 63 : 78) : 96; // AXA/Colmena más bajos; algunos <70
      const o = {
        ...emp, cron: `CRN-2026-${1500 + k}`, sec: `SEC-${3500 + k}`, horas: [4, 6, 8, 5, 10][k % 5],
        lowNit: isPdf && k % 3 === 0, lowHoras: isPdf && k % 4 === 0, lowDesc: isPdf,
      };
      const lote = lotes.find((l) => l.arl === arl) || lotes[0];
      const r = await client.query(
        `INSERT INTO sst.borradores_extraccion
          (lote_importacion_id, arl_id, nombre_archivo, url_archivo_original, confianza_general, metadatos_extraccion, estado, creado_en)
         VALUES ($1,$2,$3,$4,$5,$6,'PENDIENTE_VALIDACION',$7) RETURNING id`,
        [lote.id, arlMap[arl], isPdf ? `${arl.toLowerCase()}_os_${1500 + k}.pdf` : `SIPAB_${1500 + k}.xlsx`,
         `imports/2026/orig_${1500 + k}`, base, meta(o, base, isPdf ? 'gemini-mock' : 'excel-determinista'), iso(bi++ % 6)]
      );
      drafts.push(r.rows[0].id);
    }
    // 2 borradores marcados como DUPLICADA
    for (let k = 0; k < 2; k++) {
      const arl = ARL_ROT[k];
      const emp = EMPRESAS[k];
      const o = { ...emp, cron: `CRN-2026-${1500 + k}`, sec: `SEC-${3500 + k}`, horas: 6 };
      await client.query(
        `INSERT INTO sst.borradores_extraccion
          (lote_importacion_id, arl_id, nombre_archivo, confianza_general, metadatos_extraccion, estado, creado_en)
         VALUES ($1,$2,$3,$4,$5,'DUPLICADA',$6)`,
        [lotes[0].id, arlMap[arl], `dup_${k}.pdf`, 90, meta(o, 90, 'gemini-mock'), iso(k)]
      );
    }

    // 5 · Órdenes de servicio en TODOS los estados + historial + docs + soportes
    const plan = [
      ...Array(6).fill('SIN PROGRAMAR'),
      ...Array(7).fill('PROGRAMADA'),
      ...Array(4).fill('EN VERIFICACIÓN'),
      ...Array(7).fill('EJECUTADA'),
      ...Array(2).fill('CANCELADA'),
    ];
    let idx = 0;
    for (const estado of plan) {
      const arl = ARL_ROT[idx % 3];
      const emp = EMPRESAS[idx % EMPRESAS.length];
      const horas = [4, 6, 8, 10, 5, 12][idx % 6];
      const base = (idx % 7 === 0) ? 64 : 72 + (idx % 5) * 6; // algunos <70 → alertas
      const o = { ...emp, cron: `CRN-2026-${1000 + idx}`, sec: `SEC-${2000 + idx}`, horas };
      const codigo = `OS-2026-${String(1001 + idx).padStart(4, '0')}`;
      const isPdf = arlFmt[arl] === 'pdf';
      const prof = activos[idx % activos.length];
      const dCarga = idx; // idx 0 = hoy; las primeras caen en el mes actual, las últimas hacia atrás
      const assigned = estado !== 'SIN PROGRAMAR' && estado !== 'CANCELADA';
      const scheduled = assigned ? iso(Math.max(0, dCarga - 3), 8 + (idx % 6)) : null;
      const ejec = estado === 'EJECUTADA' ? iso(Math.max(0, dCarga - 6), 15) : null;

      const ord = await client.query(
        `INSERT INTO sst.ordenes_servicio (
          codigo, arl_id, codigo_cronograma, secuencia, nit_nic, empresa_nombre, actividad_economica,
          horas_asignadas, fecha_carga, descripcion, contacto_sst_nombre, contacto_sst_telefono, contacto_sst_correo,
          estado, profesional_asignado_id, fecha_programada, fecha_ejecucion, lote_importacion_id,
          url_archivo_original, metadatos_extraccion, creado_en)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$9) RETURNING id`,
        [codigo, arlMap[arl], o.cron, o.sec, o.nit, o.empresa, o.actividad, horas, iso(dCarga), o.desc,
         o.contacto, o.tel, o.correo, estado, assigned ? prof.id : null, scheduled, ejec,
         lotes.find((l) => l.arl === arl)?.id || null, `imports/2026/orig_${1000 + idx}`,
         meta(o, base, isPdf ? 'gemini-mock' : 'excel-determinista')]
      );
      const orderId = ord.rows[0].id;

      // Historial de estados (auditoría) según el camino recorrido
      const hist = [[null, 'SIN PROGRAMAR', 'Validación IA — creación de OS', dCarga]];
      if (['PROGRAMADA', 'EN VERIFICACIÓN', 'EJECUTADA'].includes(estado)) hist.push(['SIN PROGRAMAR', 'PROGRAMADA', null, Math.max(0, dCarga - 3)]);
      if (['EN VERIFICACIÓN', 'EJECUTADA'].includes(estado)) hist.push(['PROGRAMADA', 'EN VERIFICACIÓN', 'Soportes cargados por el profesional', Math.max(0, dCarga - 5)]);
      if (estado === 'EJECUTADA') hist.push(['EN VERIFICACIÓN', 'EJECUTADA', null, Math.max(0, dCarga - 6)]);
      if (estado === 'CANCELADA') hist.push(['SIN PROGRAMAR', 'CANCELADA', 'La empresa canceló la visita por reprogramación interna.', Math.max(0, dCarga - 2)]);
      for (const [de, a, motivo, dh] of hist) {
        await client.query(
          `INSERT INTO sst.historial_estados_orden (orden_id, estado_anterior, estado_nuevo, cambiado_por, motivo, cambiado_en)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [orderId, de, a, admin, motivo, iso(dh)]
        );
      }

      // Documentos generados (formatos) para asignadas/en verificación/ejecutadas
      if (assigned) {
        const tpls = plantillas.filter((t) => t.arl_id === arlMap[arl]);
        for (const t of (tpls.length ? tpls : plantillas.slice(0, 1))) {
          await client.query(
            `INSERT INTO sst.documentos_generados (orden_id, plantilla_id, tipo, url_pdf, generado_en)
             VALUES ($1,$2,$3,$4,$5)`,
            [orderId, t.id, t.tipo, `documents/2026/${codigo}_${t.tipo}.pdf`, scheduled]
          );
        }
        // Enlace público de soportes
        const link = await client.query(
          `INSERT INTO sst.enlaces_publicos (orden_id, token, activo, creado_en) VALUES ($1,$2,true,$3) RETURNING id`,
          [orderId, token(), scheduled]
        );
        // Soportes cargados para EN VERIFICACIÓN / EJECUTADA
        if (['EN VERIFICACIÓN', 'EJECUTADA'].includes(estado)) {
          const files = [
            ['acta_visita_firmada.pdf', 'application/pdf'],
            ['lista_asistencia.pdf', 'application/pdf'],
            ['evidencia_fotografica.jpg', 'image/jpeg'],
          ].slice(0, 2 + (idx % 2));
          for (const [name, mime] of files) {
            await client.query(
              `INSERT INTO sst.archivos_soporte (orden_id, enlace_publico_id, url_archivo, nombre_original, mime, tamano_bytes, via_enlace_publico, subido_en)
               VALUES ($1,$2,$3,$4,$5,$6,true,$7)`,
              [orderId, link.rows[0].id, `supports/${orderId}/${name}`, name, mime, 120000 + idx * 5000, iso(Math.max(0, dCarga - 5))]
            );
          }
        }
      }
      idx++;
    }

    // 6 · Notificaciones para el admin (mezcla leídas/no leídas)
    const notifs = [
      ['ASIGNACION', 'OS asignada', 'OS-2026-1007 · Alimentos La Sabana S.A.', 1, false],
      ['SOPORTE_CARGADO', 'Soportes recibidos', 'OS-2026-1014 pasó a EN VERIFICACIÓN', 0, false],
      ['RECHAZO', 'Soportes rechazados', 'OS-2026-1010 · faltó firma del cliente', 2, true],
      ['SOPORTE_CARGADO', 'Soportes recibidos', 'OS-2026-1016 pasó a EN VERIFICACIÓN', 3, true],
      ['IMPORTACION', 'Lote procesado', 'SIPAB_bolivar_semana27.xlsx · 4 órdenes', 2, true],
    ];
    for (const [tipo, titulo, mensaje, dAgo, leida] of notifs) {
      await client.query(
        `INSERT INTO sst.notificaciones (usuario_id, tipo, titulo, mensaje, datos, leido_en, creado_en)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [admin, tipo, titulo, mensaje, JSON.stringify({ demo: true }), leida ? iso(dAgo - 1) : null, iso(dAgo)]
      );
    }

    // 7 · COSTURAS FASE 2 (datos de muestra en cada tabla)
    // 7a · Tarifas por actividad/profesional
    for (const p of activos.slice(0, 4)) {
      for (const [act, val] of [['Capacitación', 85000], ['Inspección', 95000], ['Asesoría', 120000]]) {
        await client.query(
          `INSERT INTO sst.tarifas_actividad_profesional (profesional_id, actividad, valor_hora, vigente_desde)
           VALUES ($1,$2,$3, CURRENT_DATE - interval '90 days')`,
          [p.id, act, val]
        );
      }
    }
    // 7b · Pre-cuentas + items (snapshot inmutable) sobre OS EJECUTADAS
    const ejecutadas = (await client.query(
      `SELECT id, horas_asignadas, profesional_asignado_id FROM sst.ordenes_servicio
       WHERE estado='EJECUTADA' AND profesional_asignado_id IS NOT NULL LIMIT 4`
    )).rows;
    if (ejecutadas.length) {
      const profId = ejecutadas[0].profesional_asignado_id;
      const vh = 55000;
      const mine = ejecutadas.filter((e) => e.profesional_asignado_id === profId);
      const totalHoras = mine.reduce((s, e) => s + Number(e.horas_asignadas || 0), 0);
      const pb = await client.query(
        `INSERT INTO sst.precuentas (profesional_id, periodo, total_horas, total_monto, estado, observaciones)
         VALUES ($1,'2026-06',$2,$3,'aceptada','Pre-cuenta de demostración.') RETURNING id`,
        [profId, totalHoras, totalHoras * vh]
      );
      for (const e of mine) {
        await client.query(
          `INSERT INTO sst.precuenta_items (precuenta_id, orden_id, horas, valor_hora_snapshot, monto)
           VALUES ($1,$2,$3,$4,$5)`,
          [pb.rows[0].id, e.id, e.horas_asignadas, vh, Number(e.horas_asignadas || 0) * vh]
        );
      }
    }
    // 7c · Respuestas de encuesta sobre OS EJECUTADAS
    for (const e of ejecutadas.slice(0, 3)) {
      await client.query(
        `INSERT INTO sst.respuestas_encuesta (orden_id, contacto_correo, token, satisfaccion, recomendacion, comentarios, enviado_en)
         VALUES ($1,$2,$3,$4,$5,$6, now())`,
        [e.id, 'contacto.sst@empresa.co', token(), 4 + (Math.random() > 0.5 ? 1 : 0), 5, 'Excelente acompañamiento del asesor.']
      );
    }
  });

  // Resumen
  const counts = await pool.query(`
    SELECT 'usuarios' t, count(*) c FROM sst.usuarios
    UNION ALL SELECT 'profesionales', count(*) FROM sst.profesionales
    UNION ALL SELECT 'lotes_importacion', count(*) FROM sst.lotes_importacion
    UNION ALL SELECT 'borradores (pend.)', count(*) FROM sst.borradores_extraccion WHERE estado='PENDIENTE_VALIDACION'
    UNION ALL SELECT 'ordenes_servicio', count(*) FROM sst.ordenes_servicio
    UNION ALL SELECT 'historial', count(*) FROM sst.historial_estados_orden
    UNION ALL SELECT 'documentos', count(*) FROM sst.documentos_generados
    UNION ALL SELECT 'soportes', count(*) FROM sst.archivos_soporte
    UNION ALL SELECT 'notificaciones', count(*) FROM sst.notificaciones
    UNION ALL SELECT 'precuentas', count(*) FROM sst.precuentas
    UNION ALL SELECT 'encuestas', count(*) FROM sst.respuestas_encuesta
    ORDER BY 1`);
  console.table(counts.rows);
  await pool.end();
  console.log('== Seed de DEMO completo ✔ ==');
}

main().catch((e) => { console.error('✖ Error en seed-demo:', e); process.exit(1); });
