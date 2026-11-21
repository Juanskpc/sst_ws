/**
 * 20-nov-2026 · Datos de DEMOSTRACIÓN para ver las gráficas de Estadísticas
 * (Operación y Finanzas) en la base de desarrollo compartida `jdd_dev`.
 *
 *   node scripts/demo/sembrar-demo-reportes.mjs            → ensayo: siembra y hace ROLLBACK
 *   node scripts/demo/sembrar-demo-reportes.mjs --aplicar  → siembra y hace COMMIT
 *
 * Borrar: node scripts/demo/borrar-demo-reportes.mjs [--aplicar]
 *
 * ⛔ Se niega a correr si DATABASE_URL no apunta a `jdd_dev`: NUNCA en producción.
 *
 * Qué siembra (dic-2025 → hoy, el mes en curso parcial):
 *  · Operación: ~400 órdenes de 4 ARL con su lote, borrador VALIDADA, franjas, historial de
 *    estados, visto bueno de cobro, encuestas y cuentas de cobro (precuentas) aceptadas.
 *  · Finanzas: facturas (FE) y notas crédito VALIDADAS, documentos soporte y notas de ajuste,
 *    compras y gastos, recibos de caja y egresos, nómina VALIDADA y el cierre de los meses
 *    dic-2025 → sep-2026. La contabilización, la cartera, los recibos, las compras y los
 *    egresos se hacen con las MISMAS funciones de servicio que usa la app (contabilizarEn,
 *    crearReciboCaja, crearCompra, crearEgreso): los asientos, la cartera y el libro salen
 *    como los arma ORBITA, cuadrados por sus propios triggers.
 *
 * Reglas de seguridad:
 *  · Nada sale de la base: ni el proveedor tecnológico, ni la DIAN, ni correos, ni S3. Los
 *    documentos se insertan ya VALIDADOS con CUFE/números ficticios (prefijos DEMOFE, DEMONC,
 *    DEMODS, DEMONA, DEMONE) que no chocan con los rangos reales.
 *  · Todo lo sembrado queda en `demo_semilla.registro (tabla, id)` (esquema aparte; no se
 *    altera ninguna tabla de `sst`). El borrado lee de ahí.
 *  · Consecutivos contables: dentro de la transacción se ponen en 900000 para que los
 *    comprobantes demo salgan 900001…, y al final se devuelven EXACTAMENTE a su valor. Los
 *    consecutivos de las resoluciones de numeración no se tocan.
 *  · Una sola transacción. Idempotente: si ya hay semilla, no hace nada.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';

const url = process.env.DATABASE_URL || '';
if (!/\/jdd_dev(\?|$)/.test(url)) {
  console.error('DATABASE_URL no apunta a jdd_dev: no se toca nada.');
  process.exit(1);
}
const APLICAR = process.argv.includes('--aplicar');

const { pool } = await import('../../src/config/db.js');
const { contabilizarEn } = await import('../../src/modules/contabilidad/contabilizacion.service.js');
const { conciliacion } = await import('../../src/modules/cartera/cartera.service.js');
const { crearComprobante } = await import('../../src/modules/contabilidad/comprobantes.service.js');
const { crearEgreso } = await import('../../src/modules/cartera/pagos.service.js');
const { crearCompra } = await import('../../src/modules/compras/compras.service.js');
const { liquidar } = await import('../../src/modules/nomina/calculo.js');
const { parametrosDelAnio } = await import('../../src/modules/nomina/parametros.service.js');
const { aCentavos, deCentavos } = await import('../../src/utils/dinero.js');
const { hoyCO } = await import('../../src/utils/formato.js');

// ─── Utilidades ───────────────────────────────────────────────────────────────

/** PRNG determinista (mulberry32): la misma semilla da los mismos datos. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = prng(20261120);
const entre = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const prob = (p) => rnd() < p;
const elegir = (lista) => lista[Math.floor(rnd() * lista.length)];
function ponderado(pares) {
  const total = pares.reduce((s, [, w]) => s + w, 0);
  let r = rnd() * total;
  for (const [v, w] of pares) { if ((r -= w) <= 0) return v; }
  return pares[pares.length - 1][0];
}

const DIA = 86400000;
const AHORA = new Date();
const HOY = hoyCO();
/** Instante a partir de fecha y hora de Colombia (UTC−5 fijo, sin horario de verano). */
const instante = (iso, h = 0, m = 0) => new Date(Date.parse(`${iso}T00:00:00Z`) + (h + 5) * 3600000 + m * 60000);
const fechaCO = (d) => new Date(d.getTime() - 5 * 3600000).toISOString().slice(0, 10);
const sumarDias = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DIA).toISOString().slice(0, 10);
const diaSemana = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();
const habil = (iso) => { let d = iso; while ([0, 6].includes(diaSemana(d))) d = sumarDias(d, 1); return d; };
const sumarHabiles = (iso, n) => { let d = iso; for (let i = 0; i < n; i++) d = habil(sumarDias(d, 1)); return habil(d); };
const masHoras = (d, h) => new Date(d.getTime() + h * 3600000);
const yaPaso = (d) => d.getTime() <= AHORA.getTime();
const fechaPasada = (iso) => iso <= HOY;
const mesDe = (iso) => iso.slice(0, 7);
const ultimoDiaMes = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const mesSiguiente = (ym) => { const [y, m] = ym.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };
const pad = (n, w) => String(n).padStart(w, '0');
const peso = (c) => Math.round(c / 100) * 100; // centavos → redondeado al peso

// ─── Conexión y registro ──────────────────────────────────────────────────────

const client = await pool.connect();
const registro = new Map(); // tabla → Set(ids)
const registrar = (tabla, ...ids) => {
  if (!registro.has(tabla)) registro.set(tabla, new Set());
  for (const id of ids.flat()) if (id) registro.get(tabla).add(id);
};
const q = (sql, p) => client.query(sql, p);
const uno = async (sql, p) => (await q(sql, p)).rows[0];

/** Inserta filas (objetos) en bloque con json_populate_recordset y las registra. */
async function insertar(tabla, filas, { registrarIds = true } = {}) {
  if (!filas.length) return;
  const cols = [...new Set(filas.flatMap((f) => Object.keys(f)))];
  const lista = cols.map((c) => `"${c}"`).join(', ');
  for (let i = 0; i < filas.length; i += 400) {
    const lote = filas.slice(i, i + 400);
    await q(`INSERT INTO sst.${tabla} (${lista}) SELECT ${lista} FROM json_populate_recordset(null::sst.${tabla}, $1::json)`, [JSON.stringify(lote)]);
  }
  if (registrarIds) registrar(tabla, filas.map((f) => f.id));
}

async function conteos() {
  const r = await q(`SELECT relname AS tabla FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                      WHERE n.nspname = 'sst' AND c.relkind = 'r' ORDER BY 1`);
  const out = {};
  for (const { tabla } of r.rows) out[tabla] = (await uno(`SELECT count(*)::int AS n FROM sst."${tabla}"`)).n;
  return out;
}

try {
  await q('BEGIN');
  const ya = await uno(`SELECT to_regclass('demo_semilla.registro') IS NOT NULL AS existe`);
  if (ya.existe) {
    const n = await uno(`SELECT count(*)::int AS n FROM demo_semilla.registro`);
    console.log(`Ya hay una semilla demo (${n.n} filas registradas en demo_semilla.registro). No se duplica nada.`);
    console.log('Para volver a sembrar, primero: node scripts/demo/borrar-demo-reportes.mjs --aplicar');
    await q('ROLLBACK');
    process.exit(0);
  }

  const antes = await conteos();
  const libroAntes = await uno(`SELECT COALESCE(sum(m.debito),0)::numeric(16,2) AS d, COALESCE(sum(m.credito),0)::numeric(16,2) AS c
                                   FROM sst.movimientos m JOIN sst.comprobantes c ON c.id = m.comprobante_id WHERE c.estado = 'CONTABILIZADO'`);
  const concAntes = { cxc: await conciliacion(client, 'CXC'), cxp: await conciliacion(client, 'CXP') };

  await q(`CREATE SCHEMA demo_semilla`);
  await q(`CREATE TABLE demo_semilla.registro (tabla text NOT NULL, id uuid NOT NULL, PRIMARY KEY (tabla, id))`);
  await q(`CREATE TABLE demo_semilla.meta (clave text PRIMARY KEY, valor jsonb NOT NULL)`);
  await q(`COMMENT ON SCHEMA demo_semilla IS 'Semilla de demostración de reportes (scripts/demo). Se borra con borrar-demo-reportes.mjs.'`);

  // Consecutivos contables: se apartan a 900000 durante la siembra y se restauran al final.
  const consecutivos = (await q(`SELECT id, codigo, consecutivo_actual FROM sst.tipos_comprobante ORDER BY codigo FOR UPDATE`)).rows;
  await q(`UPDATE sst.tipos_comprobante SET consecutivo_actual = 900000`);

  // ─── Catálogos existentes ───────────────────────────────────────────────────
  const admin = await uno(`SELECT id FROM sst.usuarios WHERE correo = 'admin@jdd.com'`) ?? await uno(`SELECT id FROM sst.usuarios WHERE rol = 'admin' LIMIT 1`);
  const ADMIN = admin.id;
  const arlRows = (await q(`SELECT id, nombre, tercero_id FROM sst.arls`)).rows;
  const ARL = Object.fromEntries(arlRows.map((a) => [a.nombre, a]));
  for (const n of ['Bolívar', 'AXA Colpatria', 'Colmena', 'ARL SURA']) if (!ARL[n]) throw new Error(`Falta la ARL ${n}`);
  const tiposOrden = Object.fromEntries((await q(`SELECT id, nombre FROM sst.tipos_orden`)).rows.map((t) => [t.nombre, t.id]));
  const cuenta = async (codigo) => {
    const c = await uno(`SELECT id FROM sst.cuentas_contables WHERE codigo = $1 AND acepta_movimiento AND activa`, [codigo]);
    if (!c) throw new Error(`Falta la cuenta ${codigo}`);
    return c.id;
  };
  const BANCO = await cuenta('11100501');
  const ret = Object.fromEntries((await q(`SELECT id, codigo, nombre, tarifa, cuenta_id FROM sst.retenciones`)).rows.map((r) => [r.codigo, r]));
  const TD = Object.fromEntries((await q(`SELECT id, codigo_dian FROM sst.tipos_documento_identidad WHERE codigo_dian IN ('13','31')`)).rows.map((t) => [t.codigo_dian, t.id]));
  const PASTO = (await uno(`SELECT id FROM sst.municipios WHERE codigo_dian = '52001'`))?.id ?? null;
  const formaCredito = (await uno(`SELECT id FROM sst.formas_pago WHERE codigo_dian = '2'`))?.id ?? null;
  const preguntas = (await uno(`SELECT valor FROM sst.configuracion WHERE clave = 'encuesta_preguntas'`))?.valor ?? null;

  // ─── Terceros, profesionales, empresas y empleados demo ────────────────────
  let docSeq = 1000;
  const terceros = [];
  const nuevoTercero = (t) => {
    const id = randomUUID();
    terceros.push({
      id, tipo_persona: t.natural ? 'NATURAL' : 'JURIDICA', tipo_documento_id: t.natural ? TD['13'] : TD['31'],
      numero_documento: `99900${pad(++docSeq, 5)}`, dv: t.natural ? null : 0,
      razon_social: t.natural ? null : t.nombre, nombres: t.natural ? t.nombres : null, apellidos: t.natural ? t.apellidos : null,
      direccion: 'CL 18 25-30 (DEMO)', municipio_id: PASTO, telefono: '3000000000', correo_facturacion: `demo.${docSeq}@ejemplo.invalid`,
      es_cliente: !!t.cliente, es_proveedor: !!t.proveedor, es_empleado: !!t.empleado, activo: true,
      regimen: 'RESPONSABLE_IVA', creado_por: ADMIN,
    });
    return id;
  };

  const PROFES = [
    { nombres: 'Ana Lucía', apellidos: 'Gómez (DEMO)', valor: 42000, peso: 26, sesgo: 0.35, esp: 'Higiene Industrial' },
    { nombres: 'Andrés Felipe', apellidos: 'Rosero (DEMO)', valor: 40000, peso: 22, sesgo: 0.15, esp: 'Tareas de alto riesgo' },
    { nombres: 'Camila', apellidos: 'Benavides (DEMO)', valor: 45000, peso: 20, sesgo: 0.45, esp: 'Psicología SST' },
    { nombres: 'Julián', apellidos: 'Ortega (DEMO)', valor: 38000, peso: 17, sesgo: -0.55, esp: 'Seguridad industrial' },
    { nombres: 'Paola', apellidos: 'Insuasty (DEMO)', valor: 44000, peso: 15, sesgo: 0.1, esp: 'Ergonomía' },
  ];
  const profesionales = PROFES.map((p) => {
    const tercero_id = nuevoTercero({ natural: true, nombres: p.nombres, apellidos: p.apellidos, proveedor: true });
    return {
      id: randomUUID(), nombre: `${p.nombres} ${p.apellidos}`, correo: `${p.nombres.split(' ')[0].toLowerCase()}.demo@ejemplo.invalid`,
      telefono: '3000000000', especialidad: p.esp, valor_hora: p.valor, estado: 'Activo', tercero_id,
      _peso: p.peso, _sesgo: p.sesgo,
    };
  });

  const EMPRESAS = {
    'Bolívar': ['DEMO LÁCTEOS ANDINOS SAS', 'DEMO SERVICIOS PORTUARIOS DEL SUR SAS', 'DEMO MADERAS EL ROBLE LTDA', 'DEMO CONSTRUCCIONES OBANDO SAS',
      'DEMO DISTRIBUIDORA NARIÑO SAS', 'DEMO CAFÉ DE LA MONTAÑA SAS', 'DEMO HOSPITAL SAN PEDRO ESE'],
    'AXA Colpatria': ['DEMO TRANSPORTES DEL MACIZO SAS', 'DEMO FERRETERÍA CENTRAL SAS', 'DEMO COLEGIO LOS ANDES', 'DEMO PALMERAS DEL PACÍFICO SAS'],
    'Colmena': ['DEMO AGROINDUSTRIAS DEL GUÁITARA SAS', 'DEMO TEXTILES IPIALES SAS', 'DEMO COOPERATIVA LECHERA DEL SUR', 'DEMO HOTEL VOLCÁN SAS'],
    'ARL SURA': ['DEMO CLÍNICA AMÉRICA SAS', 'DEMO SUPERMERCADOS EL ÉXITO DEL SUR SAS'],
  };
  const empresas = [];
  const empresasPorArl = {};
  let nitSeq = 9998000;
  for (const [arl, nombres] of Object.entries(EMPRESAS)) {
    empresasPorArl[arl] = nombres.map((nombre) => {
      const nit = String(++nitSeq * 10).slice(0, 9);
      const e = { id: randomUUID(), nit, nombre, ciudad: 'PASTO',
        direccion: 'CR 27 15-40 (DEMO)', contacto_sst_nombre: 'Contacto SST (DEMO)', contacto_sst_correo: `sst.${nit}@ejemplo.invalid`,
        contacto_sst_telefono: '3000000000', notas: 'Empresa de DEMOSTRACIÓN (scripts/demo).', activo: true };
      empresas.push(e);
      return e;
    });
  }

  // Clientes particulares (factura manual), proveedores y empleados.
  const CLIENTES = {
    constructora: nuevoTercero({ nombre: 'DEMO CONSTRUCTORA ANDINA SAS', cliente: true }),
    clinica: nuevoTercero({ nombre: 'DEMO CLÍNICA LOS VOLCANES SAS', cliente: true }),
    galeras: nuevoTercero({ nombre: 'DEMO TRANSPORTES GALERAS SAS', cliente: true }),
  };
  const PROV = {
    inmobiliaria: nuevoTercero({ nombre: 'DEMO INMOBILIARIA PASTO SAS', proveedor: true }),
    energia: nuevoTercero({ nombre: 'DEMO ENERGÍA DEL SUR ESP', proveedor: true }),
    telefonia: nuevoTercero({ nombre: 'DEMO TELECOMUNICACIONES NARIÑO SAS', proveedor: true }),
    papeleria: nuevoTercero({ nombre: 'DEMO PAPELERÍA EL ESTUDIANTE SAS', proveedor: true }),
    contador: nuevoTercero({ nombre: 'DEMO CONTADORES ASOCIADOS SAS', proveedor: true }),
    transporte: nuevoTercero({ nombre: 'DEMO TRANSPORTES RÁPIDO SAS', proveedor: true }),
    combustible: nuevoTercero({ nombre: 'DEMO ESTACIÓN DE SERVICIO EL CAMPANERO', proveedor: true }),
    banco: nuevoTercero({ nombre: 'DEMO BANCO DE OCCIDENTE (COMISIONES)', proveedor: true }),
    tecnologia: nuevoTercero({ nombre: 'DEMO SOLUCIONES INFORMÁTICAS SAS', proveedor: true }),
    seguros: nuevoTercero({ nombre: 'DEMO SEGUROS DEL ESTADO SA', proveedor: true }),
  };
  const EMPLEADOS = [
    { nombres: 'Lorena', apellidos: 'Muñoz (DEMO)', cargo: 'Coordinadora administrativa', salario: 3200000 },
    { nombres: 'Diego', apellidos: 'Erazo (DEMO)', cargo: 'Auxiliar contable', salario: 1900000 },
    { nombres: 'Sandra', apellidos: 'Cabrera (DEMO)', cargo: 'Auxiliar de operaciones', salario: 1750905 },
  ].map((e) => ({ ...e, tercero_id: nuevoTercero({ natural: true, nombres: e.nombres, apellidos: e.apellidos, empleado: true }), id: randomUUID() }));

  await insertar('terceros', terceros);
  await insertar('profesionales', profesionales.map(({ _peso, _sesgo, ...p }) => p));
  await insertar('empresas', empresas);
  await insertar('empleados', EMPLEADOS.map((e) => ({
    id: e.id, tercero_id: e.tercero_id, cargo: e.cargo, salario: e.salario, salario_integral: false, tipo_contrato: '2',
    tipo_trabajador: '01', subtipo_trabajador: '00', fecha_ingreso: '2025-06-02', metodo_pago: '10', eps: 'DEMO EPS',
    fondo_pension: 'DEMO PENSIONES', fondo_cesantias: 'DEMO CESANTÍAS', arl: 'Bolívar', caja_compensacion: 'DEMO CAJA',
    activo: true, correo: `empleado.${e.nombres.toLowerCase()}.demo@ejemplo.invalid`, creado_por: ADMIN,
  })));

  // ─── Operación: órdenes de 12 meses ─────────────────────────────────────────
  const MESES = [];
  for (let ym = '2025-12'; ym <= mesDe(HOY); ym = mesSiguiente(ym)) MESES.push(ym);
  // Volumen por mes de carga (estacionalidad: diciembre y enero flojos, segundo semestre fuerte).
  const VOLUMEN = { '2025-12': 22, '2026-01': 14, '2026-02': 26, '2026-03': 33, '2026-04': 37, '2026-05': 40, '2026-06': 29,
    '2026-07': 35, '2026-08': 42, '2026-09': 45, '2026-10': 48, '2026-11': 31 };
  const ACTIVIDADES = {
    'Bolívar': [['PROGRAMA DE PREVENCION CONTRA CAIDAS', 'Capacitación'], ['DIVULGACION PLAN DE EMERGENCIAS', 'Capacitación'],
      ['ACOMPANAMIENTO TECNICO EN RIESGO MECANICO', 'Asesoría'], ['INSPECCIONES DE SEGURIDAD', 'Inspección'],
      ['CAPACITACION EN RIESGO PSICOSOCIAL', 'Capacitación'], ['ASESORIA EN SG-SST', 'Asesoría']],
    'AXA Colpatria': [['Asesoría en SG-SST', 'Asesoría'], ['Capacitación brigadas de emergencia', 'Capacitación'],
      ['Inspección de extintores y botiquines', 'Inspección'], ['Estilos de vida saludable', 'Capacitación']],
    'Colmena': [['Gestión del riesgo biomecánico', 'Asesoría'], ['Capacitación COPASST', 'Capacitación'],
      ['Investigación de accidentes de trabajo', 'Asesoría'], ['Pausas activas', 'Capacitación']],
    'ARL SURA': [['IDENTIFICACION DE PELIGROS, EVALUACION Y VALORACION DE RIESGOS', 'Asesoría'], ['PRACTICAS SEGURAS', 'Capacitación']],
  };
  const TARIFA = { 'Bolívar': 71457, 'AXA Colpatria': 74000, 'Colmena': 69500, 'ARL SURA': 71457 };
  const CIUDADES = [['PASTO', 40], ['IPIALES', 14], ['TUMACO', 10], ['TÚQUERRES', 8], ['MOCOA', 7], ['LA UNIÓN', 6], ['SANDONÁ', 5],
    ['SAMANIEGO', 4], ['BARBACOAS', 3], ['LA CRUZ', 3]];
  const MOTIVOS_CANCELA = ['La empresa canceló la actividad.', 'La ARL anuló la orden.', 'Empresa cerrada temporalmente.'];

  const ordenes = [];
  const borradores = [];
  const lotes = [];
  const franjas = [];
  const historial = [];
  const aprobaciones = [];
  const encuestas = [];
  let osSeq = 0;
  let cronoSeq = 7700000;

  for (const ym of MESES) {
    const ultimo = ultimoDiaMes(ym);
    const dias = [];
    for (let d = `${ym}-01`; d <= ultimo; d = sumarDias(d, 1)) {
      if (![0, 6].includes(diaSemana(d)) && d <= HOY) dias.push(d);
    }
    const lotePorArl = {};
    for (let k = 0; k < VOLUMEN[ym]; k++) {
      const dia = elegir(dias);
      let carga = instante(dia, entre(7, 16), entre(0, 59));
      if (!yaPaso(carga)) carga = new Date(AHORA.getTime() - entre(1, 5) * 3600000);
      const diaCarga = fechaCO(carga);
      const conSura = diaCarga >= '2026-10-26';
      const arl = ponderado([['Bolívar', 45], ['AXA Colpatria', 27], ['Colmena', 28], ...(conSura ? [['ARL SURA', 22]] : [])]);
      const [actividad, tipo] = elegir(ACTIVIDADES[arl]);
      const empresa = elegir(empresasPorArl[arl]);
      const horas = elegir([2, 2, 3, 4, 4, 4, 4, 6, 6, 8, 8, 12]);
      const valorUnitario = TARIFA[arl];
      const transporte = prob(0.25) ? entre(15, 65) * 1000 : 0;
      const prof = ponderado(profesionales.map((p) => [p, p._peso]));
      const id = randomUUID();
      const codigo = `DEMO-OS-${ym.slice(0, 4)}-${pad(++osSeq, 4)}`;
      const vencimiento = sumarDias(diaCarga, entre(30, 45));
      if (!lotePorArl[arl]) {
        lotePorArl[arl] = { id: randomUUID(), subido_por: ADMIN, nombre_archivo: `DEMO-${arl.replace(/\s+/g, '-')}-${ym}.xlsx`,
          arl_detectada: ARL[arl].id, estado: 'PROCESADO', total_ordenes: 0, creado_en: carga.toISOString(), tipo_mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
        lotes.push(lotePorArl[arl]);
      }
      const lote = lotePorArl[arl];
      lote.total_ordenes++;
      if (carga < new Date(lote.creado_en)) lote.creado_en = carga.toISOString();

      // Línea de tiempo: carga → asignación → visita → soportes → aceptación → visto bueno.
      let estado = 'SIN PROGRAMAR';
      const h = [{ id: randomUUID(), orden_id: id, estado_anterior: null, estado_nuevo: 'SIN PROGRAMAR', cambiado_por: ADMIN, cambiado_en: carga.toISOString() }];
      let fechaProgramada = null; let fechaEjecucion = null; let aceptado = null; let visto = null; let asignado = null;
      const misFranjas = [];
      const cancela = prob(0.03);
      const atascada = prob(0.045);
      if (cancela) {
        const t = masHoras(carga, entre(30, 240));
        if (yaPaso(t)) {
          estado = 'CANCELADA';
          h.push({ id: randomUUID(), orden_id: id, estado_anterior: 'SIN PROGRAMAR', estado_nuevo: 'CANCELADA', cambiado_por: ADMIN, motivo: elegir(MOTIVOS_CANCELA), cambiado_en: t.toISOString() });
        }
      } else if (!atascada) {
        const tAsigna = masHoras(carga, entre(18, 140));
        if (yaPaso(tAsigna)) {
          asignado = prof;
          estado = 'PROGRAMADA';
          h.push({ id: randomUUID(), orden_id: id, estado_anterior: 'SIN PROGRAMAR', estado_nuevo: 'PROGRAMADA', cambiado_por: ADMIN, cambiado_en: tAsigna.toISOString() });
          let visita = sumarHabiles(fechaCO(tAsigna), entre(2, 14));
          if (arl === 'ARL SURA' && visita < '2026-11-03') visita = sumarHabiles('2026-11-02', entre(1, 6));
          // La visita se reparte en franjas de máximo 4 horas (mañana, tarde y, si hace falta, el día siguiente).
          let resto = horas; let dia = visita; let manana = true;
          while (resto > 0) {
            const tramo = Math.min(4, resto);
            const ini = manana ? 8 : 14;
            misFranjas.push({ id: randomUUID(), orden_id: id, fecha: dia, hora_inicio: `${pad(ini, 2)}:00`, hora_fin: `${pad(ini + tramo, 2)}:00`, creado_por: ADMIN, creado_en: tAsigna.toISOString(), profesional_id: prof.id });
            resto -= tramo;
            if (!manana) dia = sumarHabiles(dia, 1);
            manana = !manana;
          }
          const ultima = misFranjas[misFranjas.length - 1];
          fechaProgramada = instante(misFranjas[0].fecha, Number(misFranjas[0].hora_inicio.slice(0, 2)));
          const finVisita = instante(ultima.fecha, Number(ultima.hora_fin.slice(0, 2)));
          const tSoportes = masHoras(finVisita, prob(0.08) ? entre(240, 600) : entre(2, 70));
          if (yaPaso(tSoportes)) {
            estado = 'EJECUTADA';
            fechaEjecucion = finVisita;
            h.push({ id: randomUUID(), orden_id: id, estado_anterior: 'PROGRAMADA', estado_nuevo: 'EJECUTADA', cambiado_por: null, motivo: 'Soportes subidos por el profesional (DEMO).', cambiado_en: tSoportes.toISOString() });
            const tAcepta = masHoras(tSoportes, entre(6, 120));
            if (yaPaso(tAcepta)) {
              estado = 'FINALIZADA';
              aceptado = tAcepta;
              h.push({ id: randomUUID(), orden_id: id, estado_anterior: 'EJECUTADA', estado_nuevo: 'FINALIZADA', cambiado_por: ADMIN, cambiado_en: tAcepta.toISOString() });
              const tVisto = masHoras(tAcepta, entre(4, 190));
              if (prob(0.97) && yaPaso(tVisto)) visto = tVisto;
            }
          }
        }
      }
      const honorarios = horas * valorUnitario;
      const totalCobro = honorarios + transporte;
      const o = {
        id, codigo, arl_id: ARL[arl].id, numero_orden: `DEMO${pad(osSeq, 6)}`, codigo_cronograma: `DEMO${++cronoSeq}`, secuencia: '1',
        nit_nic: empresa.nit, empresa_nombre: empresa.nombre, empresa_id: empresa.id, actividad_economica: 'DEMO · actividad económica',
        tipo_actividad: actividad, tipo_orden_id: tiposOrden[tipo] ?? null, horas_asignadas: horas, valor_unitario: valorUnitario,
        valor_total: honorarios, fecha_orden: diaCarga, fecha_vencimiento: vencimiento, ciudad_ejecucion: ponderado(CIUDADES),
        direccion: 'Dirección de la visita (DEMO)', fecha_carga: carga.toISOString(), creado_en: carga.toISOString(),
        actualizado_en: (aceptado ?? fechaEjecucion ?? fechaProgramada ?? carga).toISOString(),
        descripcion: 'Orden de DEMOSTRACIÓN para las gráficas de Estadísticas.', contacto_sst_nombre: empresa.contacto_sst_nombre,
        contacto_sst_correo: empresa.contacto_sst_correo, contacto_sst_telefono: '3000000000', estado,
        profesional_asignado_id: asignado?.id ?? null, fecha_programada: fechaProgramada?.toISOString() ?? null,
        fecha_ejecucion: fechaEjecucion?.toISOString() ?? null, lote_importacion_id: lote.id,
        metadatos_extraccion: { overall_confidence: prob(0.06) ? entre(55, 69) : entre(82, 99), engine: 'demo' },
        soportes_aceptados_en: aceptado?.toISOString() ?? null, soportes_aceptados_por: aceptado ? ADMIN : null,
        valor_hora_cobro: asignado ? asignado.valor_hora : null, valor_hora_origen: asignado ? 'profesional' : null,
        tipo_servicio_arl: elegir(['C', 'C', 'A', 'T']),
        modalidad_ejecucion: prob(0.85) ? 'PRESENCIAL' : 'VIRTUAL', estado_cobro: 'NO FACTURADA', cobro_transporte: transporte || null,
        cobro_aprobado_en: visto?.toISOString() ?? null, cobro_aprobado_por: visto ? ADMIN : null, cobro_aprobado_total: visto ? totalCobro : null,
        estado_arl: 'PENDIENTE',
        // auxiliares (se quitan antes de insertar)
        _arl: arl, _prof: asignado, _total: totalCobro, _aceptado: aceptado, _visto: visto,
        _ejecucionDia: misFranjas.length && fechaEjecucion ? misFranjas[misFranjas.length - 1].fecha : null,
      };
      ordenes.push(o);
      borradores.push({ id: randomUUID(), lote_importacion_id: lote.id, arl_id: ARL[arl].id, nombre_archivo: lote.nombre_archivo, confianza_general: 96,
        metadatos_extraccion: { engine: 'demo', nit_nic: { value: empresa.nit, confidence: 99 }, empresa_nombre: { value: empresa.nombre, confidence: 98 },
          fecha_vencimiento: { value: vencimiento, confidence: 97 }, horas_asignadas: { value: String(horas), confidence: 99 } },
        estado: 'VALIDADA', orden_servicio_id: id, creado_en: carga.toISOString(), actualizado_en: carga.toISOString(),
        profesional_asignado_id: asignado?.id ?? null, fecha_programada: fechaProgramada?.toISOString() ?? null, deshabilitado: false,
        tipo_orden_id: tiposOrden[tipo] ?? null });
      if (estado !== 'CANCELADA' && estado !== 'SIN PROGRAMAR') franjas.push(...misFranjas);
      historial.push(...h);
      if (visto) aprobaciones.push({ id: randomUUID(), orden_id: id, accion: 'APROBADA', total: totalCobro, observacion: 'Visto bueno (DEMO)', usuario_id: ADMIN, creado_en: visto.toISOString() });

      // Encuesta de satisfacción al finalizar; ~62 % responde. Cada asesor tiene su sesgo.
      if (aceptado) {
        const enviado = masHoras(aceptado, 0.2);
        const responde = prob(0.62);
        const tResp = masHoras(enviado, entre(2, 96));
        const r = responde && yaPaso(tResp);
        const nota = () => {
          const base = 4.25 + asignado._sesgo + (rnd() - 0.5) * 1.9;
          return Math.max(1, Math.min(5, Math.round(base)));
        };
        const sat = r ? nota() : null;
        encuestas.push({ id: randomUUID(), orden_id: id, contacto_correo: empresa.contacto_sst_correo, contacto_nombre: empresa.contacto_sst_nombre,
          token: `demo-${randomUUID()}`, satisfaccion: sat, recomendacion: r ? Math.max(1, Math.min(5, sat + elegir([0, 0, 0, 1, -1]))) : null,
          calificacion_profesional: r ? nota() : null, comentarios: r && prob(0.3) ? elegir(['Muy buena actividad, el asesor fue puntual.', 'Excelente manejo del tema.', 'Faltó material de apoyo.', 'Recomendamos ampliar la duración.', 'Todo muy claro.']) : null,
          enviado_en: enviado.toISOString(), respondido_en: r ? tResp.toISOString() : null, creado_en: enviado.toISOString(),
          profesional_id: asignado.id, arl_id: ARL[arl].id, empresa_nombre: empresa.nombre, preguntas });
      }
    }
  }

  // ─── Plan de facturación de órdenes (fecha de la factura y qué órdenes lleva) ─
  // Bolívar factura por corte (16 → 15) el día 18; AXA y Colmena el 5 del mes siguiente.
  // Sura (entra el 24-oct-2026) todavía no se factura: queda «por facturar».
  const facturas = []; // { id, tercero, fecha, ordenes[], arl, tipo:'ARL'|'PARTICULAR', ... }
  const facturable = (o, fechaFactura) => o.estado === 'FINALIZADA' && o._visto && fechaCO(o._visto) <= fechaFactura && !o._facturada;
  for (const ym of MESES) {
    for (const arl of ['Bolívar', 'AXA Colpatria', 'Colmena']) {
      const fecha = arl === 'Bolívar' ? habil(`${ym}-18`) : habil(`${ym}-05`);
      if (!fechaPasada(fecha)) continue;
      const hasta = arl === 'Bolívar' ? `${ym}-15` : sumarDias(`${ym}-01`, -1);
      const lleva = ordenes.filter((o) => o._arl === arl && facturable(o, fecha) && o._ejecucionDia <= hasta);
      if (!lleva.length) continue;
      lleva.forEach((o) => { o._facturada = true; });
      facturas.push({ id: randomUUID(), tercero: ARL[arl].tercero_id, fecha, ordenes: lleva, arl, tipo: 'ARL' });
    }
  }
  // Facturas manuales a clientes particulares (con IVA del 19 %).
  const PARTICULARES = [
    { tercero: CLIENTES.constructora, meses: MESES.filter((m) => m !== '2026-11'), dia: '10', valor: () => entre(17, 22) * 100000, desc: 'Asesoría mensual en SG-SST (DEMO)' },
    { tercero: CLIENTES.clinica, meses: MESES.filter((_, i) => i % 2 === 1), dia: '12', valor: () => entre(22, 28) * 100000, desc: 'Programa de vigilancia epidemiológica (DEMO)' },
    { tercero: CLIENTES.galeras, meses: ['2026-03', '2026-06', '2026-09'], dia: '15', valor: () => entre(32, 38) * 100000, desc: 'Auditoría del SG-SST y plan de trabajo (DEMO)' },
  ];
  for (const p of PARTICULARES) {
    for (const ym of p.meses) {
      const fecha = habil(`${ym}-${p.dia}`);
      if (!fechaPasada(fecha)) continue;
      facturas.push({ id: randomUUID(), tercero: p.tercero, fecha, ordenes: [], tipo: 'PARTICULAR', valor: p.valor(), desc: p.desc, cliente: p.tercero });
    }
  }
  // Una factura particular que se anula con nota crédito (causal 2) y se vuelve a emitir.
  const aAnular = facturas.find((f) => f.tipo === 'PARTICULAR' && f.cliente === CLIENTES.constructora && f.fecha.startsWith('2026-04'));
  if (aAnular) {
    aAnular.anular = true;
    facturas.push({ id: randomUUID(), tercero: aAnular.tercero, fecha: habil(sumarDias(aAnular.fecha, 4)), ordenes: [], tipo: 'PARTICULAR',
      valor: aAnular.valor, desc: `${aAnular.desc} · reemplaza la factura anulada`, cliente: aAnular.cliente, reemplaza: true });
  }
  facturas.sort((a, b) => a.fecha.localeCompare(b.fecha));
  let feSeq = 0;
  for (const f of facturas) {
    f.numero = `DEMOFE${pad(++feSeq, 5)}`;
    for (const o of f.ordenes) {
      o.estado_cobro = 'FACTURADA';
      o.cobro_numero_factura = f.numero;
      o.cobro_actualizado_en = instante(f.fecha, 11).toISOString();
      o.cobro_actualizado_por = ADMIN;
    }
  }

  // ─── Inserción de Operación ─────────────────────────────────────────────────
  await insertar('lotes_importacion', lotes);
  await insertar('ordenes_servicio', ordenes.map((o) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_')))));
  await insertar('borradores_extraccion', borradores);
  await insertar('franjas_visita', franjas);
  await insertar('historial_estados_orden', historial);
  await insertar('historial_aprobacion_cobro', aprobaciones);
  await insertar('respuestas_encuesta', encuestas);
  await insertar('historial_cobro_orden', ordenes.filter((o) => o.estado_cobro === 'FACTURADA').map((o) => ({
    id: randomUUID(), orden_id: o.id, estado_anterior: 'NO FACTURADA', estado_nuevo: 'FACTURADA', numero_factura: o.cobro_numero_factura,
    observacion: 'Factura de DEMOSTRACIÓN', cambiado_por: ADMIN, cambiado_en: o.cobro_actualizado_en,
    documento_id: null, _f: o.cobro_numero_factura,
  })).map(({ _f, ...x }) => x));

  // ─── Precuentas (cuentas de cobro) por asesor y mes, aceptadas ──────────────
  // Todo el trabajo aceptado de los meses cerrados (hasta el mes anterior) queda en una
  // cuenta: así el aviso de corte no salta por la demo. El mes en curso queda «por cobrar».
  const precuentas = [];
  const precuentaItems = [];
  const mesAnterior = (() => { const [y, m] = HOY.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1, 2)}`; })();
  for (const p of profesionales) {
    for (const ym of MESES.filter((m) => m <= mesAnterior)) {
      const trabajo = ordenes.filter((o) => o._prof?.id === p.id && o._aceptado && o._ejecucionDia && mesDe(o._ejecucionDia) === ym);
      if (!trabajo.length) continue;
      const ultimoAceptado = trabajo.reduce((m, o) => (o._aceptado > m ? o._aceptado : m), new Date(0));
      let generada = instante(habil(`${mesSiguiente(ym)}-05`), 9);
      if (generada <= ultimoAceptado) generada = masHoras(ultimoAceptado, 20);
      if (!yaPaso(generada)) generada = masHoras(AHORA, -2);
      let respondida = masHoras(generada, entre(4, 40));
      if (!yaPaso(respondida)) respondida = masHoras(AHORA, -1);
      const horas = trabajo.reduce((s, o) => s + o.horas_asignadas, 0);
      const pc = { id: randomUUID(), profesional_id: p.id, periodo: ym, total_horas: horas, total_monto: horas * p.valor_hora, estado: 'aceptada',
        observaciones: 'Cuenta de cobro de DEMOSTRACIÓN', creado_en: generada.toISOString(), token: `demo-${randomUUID()}`,
        enviado_en: generada.toISOString(), respondido_en: respondida.toISOString(), generado_por: ADMIN, actualizado_en: respondida.toISOString(), total_viaticos: 0,
        _respondida: respondida, _prof: p, _trabajo: trabajo };
      precuentas.push(pc);
      for (const o of trabajo) {
        precuentaItems.push({ id: randomUUID(), precuenta_id: pc.id, orden_id: o.id, horas: o.horas_asignadas, valor_hora_snapshot: p.valor_hora,
          monto: o.horas_asignadas * p.valor_hora, orden_codigo: o.codigo, empresa_nombre: o.empresa_nombre, arl_nombre: o._arl,
          actividad: o.tipo_actividad, fecha_ejecucion: o._ejecucionDia, viaticos: 0, origen_tarifa: 'profesional' });
      }
    }
  }
  await insertar('precuentas', precuentas.map((x) => Object.fromEntries(Object.entries(x).filter(([k]) => !k.startsWith('_')))));
  await insertar('precuenta_items', precuentaItems);

  // ─── Finanzas: eventos en orden cronológico ─────────────────────────────────
  const eventos = []; // { fecha, prioridad, fn }
  const ev = (fecha, prioridad, fn) => { if (fechaPasada(fecha)) eventos.push({ fecha, prioridad, fn }); };
  const docsCreados = [];
  let cufeSeq = 0;
  const cufe = () => `DEMO-CUFE-${pad(++cufeSeq, 6)}-${randomUUID().slice(0, 8)}`;

  /** Inserta un documento electrónico ya VALIDADO (sin pasar por el proveedor) con sus ítems y tributos. */
  async function insertarDocumento(d, items) {
    await insertar('documentos_electronicos', [{
      id: d.id, tipo: d.tipo, prefijo: d.prefijo, numero: d.numero, reference_code: `DEMO-${d.numero}`, estado: 'VALIDADO',
      tercero_id: d.tercero_id, fecha_emision: d.fecha, fecha_vencimiento: d.vence, forma_pago_id: formaCredito,
      observaciones: d.observaciones ?? 'Documento de DEMOSTRACIÓN (no enviado a la DIAN).',
      total_bruto: deCentavos(d.subtotal), total_descuento: '0.00', subtotal: deCentavos(d.subtotal), total_iva: deCentavos(d.iva ?? 0),
      total_retenciones: deCentavos(d.retenciones ?? 0), total_a_pagar: deCentavos(d.subtotal + (d.iva ?? 0) - (d.retenciones ?? 0)),
      cufe: cufe(), respuesta_proveedor: { demo: true }, documento_referencia_id: d.referencia ?? null, causal: d.causal ?? null,
      precuenta_id: d.precuenta_id ?? null, creado_por: ADMIN, actualizado_por: ADMIN,
      creado_en: instante(d.fecha, 10).toISOString(), actualizado_en: instante(d.fecha, 10).toISOString(),
    }]);
    const its = []; const tribs = [];
    items.forEach((it, i) => {
      const itemId = randomUUID();
      its.push({ id: itemId, documento_id: d.id, orden_id: it.orden_id ?? null, codigo: it.codigo ?? null, descripcion: it.descripcion,
        cantidad: it.cantidad ?? 1, valor_unitario: deCentavos(it.unitario ?? it.base), descuento: '0.00', base: deCentavos(it.base),
        total_linea: deCentavos(it.base), orden: i });
      if (it.iva) tribs.push({ id: randomUUID(), item_id: itemId, tributo_codigo: '01', base: deCentavos(it.base), tarifa: 19, valor: deCentavos(it.iva) });
      if (i === items.length - 1 && d.retencion) {
        tribs.push({ id: randomUUID(), item_id: itemId, retencion_id: d.retencion.id, base: deCentavos(d.subtotal), tarifa: d.retencion.tarifa, valor: deCentavos(d.retenciones) });
      }
    });
    await insertar('documento_items', its);
    await insertar('documento_item_tributos', tribs);
    if (d.ordenes?.length) await insertar('documento_ordenes', d.ordenes.map((orden_id) => ({ documento_id: d.id, orden_id })), { registrarIds: false });
    const evId = randomUUID();
    await insertar('documento_eventos', [{ id: evId, documento_id: d.id, codigo: 'VALIDADO', descripcion: `DEMO · validado (ficticio). Número ${d.numero}.`, usuario_id: ADMIN, fecha: instante(d.fecha, 10).toISOString() }]);
    docsCreados.push(d.id);
    await contabilizarEn(client, d.id, ADMIN);
    return (await uno(`SELECT id, saldo FROM sst.cartera_documentos WHERE documento_id = $1`, [d.id]))?.id ?? null;
  }

  // Facturas, notas crédito y recibos de caja.
  let ncSeq = 0;
  const RF = ret['RF-HON'];
  const ICA = { 'Bolívar': ret['ICA-BOL'], 'AXA Colpatria': ret['ICA-AXA'] };
  const porcentajeC = (c, t) => Math.round((c * Number(t)) / 100);
  const recibosIds = []; const egresosIds = []; const comprasIds = [];

  /** Un recibo por el valor indicado (o el saldo) de una factura, con la ReteICA del pagador si la tiene. */
  async function pagar(carteraId, tercero, fecha, { fraccion = 1, reteica = null, subtotal = 0 } = {}) {
    const doc = await uno(`SELECT saldo, valor FROM sst.cartera_documentos WHERE id = $1`, [carteraId]);
    const saldo = aCentavos(doc.saldo);
    if (saldo <= 0) return;
    let retenido = 0;
    if (reteica && fraccion === 1) retenido = Math.min(peso(porcentajeC(subtotal * (saldo / aCentavos(doc.valor)), reteica.tarifa)), saldo - 100);
    let pagado = fraccion === 1 ? saldo - retenido : Math.round(saldo * fraccion / 100000) * 100000;
    if (pagado <= 0 || pagado + retenido > saldo) pagado = saldo - retenido;
    recibosIds.push(await reciboDeCaja({ terceroId: tercero, fecha, carteraId, pagado, retenido, reteica, base: subtotal }));
  }

  /**
   * El recibo de caja, con el MISMO asiento y las MISMAS aplicaciones que `crearReciboCaja`
   * (cartera.service.js: `prepararRecibo` + `guardarAplicaciones`):
   *   D banco (lo consignado) · C clientes (pagado + retenido) · D la retención a favor.
   * No se llama a `crearReciboCaja` porque al final relee el recibo con `obtenerRecibo`, que
   * pide `recibos_caja.modificado_en`, y esa columna (migración 2026-11-13) NO está en
   * jdd_dev. Las migraciones no se corren desde aquí.
   */
  async function reciboDeCaja({ terceroId, fecha, carteraId, pagado, retenido, reteica, base }) {
    const doc = await uno(`SELECT id, numero, saldo, cuenta_id, documento_id FROM sst.cartera_documentos WHERE id = $1 AND tipo = 'CXC' FOR UPDATE`, [carteraId]);
    if (pagado + retenido > aCentavos(doc.saldo)) throw new Error(`${doc.numero}: el recibo supera el saldo`);
    const nombre = (await uno(`SELECT COALESCE(razon_social, NULLIF(btrim(concat_ws(' ', nombres, apellidos)), '')) AS n FROM sst.terceros WHERE id = $1`, [terceroId])).n;
    const recibo = await uno(
      `INSERT INTO sst.recibos_caja (tercero_id, fecha, cuenta_banco_id, valor_consignado, observaciones, creado_por, creado_en)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [terceroId, fecha, BANCO, deCentavos(pagado), 'Recibo de DEMOSTRACIÓN', ADMIN, instante(fecha, 15).toISOString()],
    );
    const lineas = [
      { cuenta_id: BANCO, tercero_id: terceroId, debito: deCentavos(pagado), descripcion: 'Consignación' },
      { cuenta_id: doc.cuenta_id, tercero_id: terceroId, credito: deCentavos(pagado + retenido), documento_cruce: doc.numero, documento_cruce_id: doc.documento_id },
      ...(retenido ? [{ cuenta_id: reteica.cuenta_id, tercero_id: terceroId, debito: deCentavos(retenido), base: deCentavos(base),
        descripcion: reteica.nombre, documento_cruce: doc.numero, documento_cruce_id: doc.documento_id }] : []),
    ];
    const comp = await crearComprobante({
      tipo: 'RC', fecha, descripcion: `Recibo de caja · ${nombre}`, lineas, origen_tipo: 'RECIBO_CAJA', origen_id: recibo.id, contabilizar: true,
    }, ADMIN, { client });
    await q(`UPDATE sst.recibos_caja SET comprobante_id = $2 WHERE id = $1`, [recibo.id, comp.id]);
    const ap = await uno(
      `INSERT INTO sst.cartera_aplicaciones (cartera_documento_id, origen_tipo, origen_id, fecha, valor_pagado, valor_retenciones)
       VALUES ($1, 'RECIBO_CAJA', $2, $3, $4, $5) RETURNING id`,
      [doc.id, recibo.id, fecha, deCentavos(pagado), deCentavos(retenido)],
    );
    if (retenido) {
      await q(`INSERT INTO sst.cartera_aplicacion_retenciones (aplicacion_id, retencion_id, cuenta_id, base, valor) VALUES ($1, $2, $3, $4, $5)`,
        [ap.id, reteica.id, reteica.cuenta_id, deCentavos(base), deCentavos(retenido)]);
    }
    await q(`UPDATE sst.cartera_documentos SET saldo = saldo - $2 WHERE id = $1`, [doc.id, deCentavos(pagado + retenido)]);
    return recibo.id;
  }

  for (const f of facturas) {
    ev(f.fecha, 1, async () => {
      let items; let subtotal; let iva = 0;
      if (f.tipo === 'ARL') {
        items = f.ordenes.map((o) => ({ orden_id: o.id, codigo: o.codigo, descripcion: `${o.empresa_nombre} — ${o.tipo_actividad} (OS ${o.codigo})`, base: o._total * 100 }));
        subtotal = items.reduce((s, i) => s + i.base, 0);
      } else {
        const base = f.valor * 100;
        iva = porcentajeC(base, 19);
        items = [{ descripcion: f.desc, base, iva }];
        subtotal = base;
      }
      const retenciones = porcentajeC(subtotal, RF.tarifa);
      const d = { id: f.id, tipo: 'FACTURA', prefijo: 'DEMOFE', numero: f.numero, tercero_id: f.tercero, fecha: f.fecha, vence: sumarDias(f.fecha, 30),
        subtotal, iva, retenciones, retencion: RF, ordenes: f.ordenes.map((o) => o.id) };
      f.cartera = await insertarDocumento(d, items);
      f.subtotal = subtotal; f.items = items;

      // Nota crédito parcial (rebaja o ajuste de precio) en algunas facturas de AXA y Colmena.
      if (f.tipo === 'ARL' && f.arl !== 'Bolívar' && items.length >= 2 && prob(0.22)) {
        const fechaNc = habil(sumarDias(f.fecha, entre(6, 18)));
        ev(fechaNc, 2, async () => {
          const it = elegir(items);
          const frac = elegir([0.25, 0.5]);
          const base = Math.round(it.base * frac);
          const r = porcentajeC(base, RF.tarifa);
          const numero = `DEMONC${pad(++ncSeq, 5)}`;
          await insertarDocumento({ id: randomUUID(), tipo: 'NOTA_CREDITO', prefijo: 'DEMONC', numero, tercero_id: f.tercero, fecha: fechaNc, vence: fechaNc,
            subtotal: base, retenciones: r, retencion: RF, referencia: f.id, causal: elegir(['3', '4']),
            observaciones: 'Nota crédito de DEMOSTRACIÓN (ajuste de valor).' },
          [{ orden_id: it.orden_id, codigo: it.codigo, descripcion: it.descripcion, cantidad: frac, unitario: it.base, base }]);
          f.subtotal -= base;
        });
      }
      if (f.anular) {
        const fechaNc = habil(sumarDias(f.fecha, 3));
        ev(fechaNc, 2, async () => {
          const numero = `DEMONC${pad(++ncSeq, 5)}`;
          const base = subtotal; const r = porcentajeC(base, RF.tarifa);
          await insertarDocumento({ id: randomUUID(), tipo: 'NOTA_CREDITO', prefijo: 'DEMONC', numero, tercero_id: f.tercero, fecha: fechaNc, vence: fechaNc,
            subtotal: base, iva, retenciones: r, retencion: RF, referencia: f.id, causal: '2', observaciones: 'Anulación de DEMOSTRACIÓN (valor mal digitado).' },
          [{ descripcion: items[0].descripcion, base, iva }]);
          await q(`UPDATE sst.documentos_electronicos SET estado = 'ANULADO' WHERE id = $1`, [f.id]);
          f.anulada = true;
        });
        return;
      }

      // Recaudo: cada pagador con su costumbre (Colmena paga tarde; Galeras, muy tarde).
      const plan = {
        'Bolívar': () => [[entre(38, 55), 1]],
        'AXA Colpatria': () => (prob(0.25) ? [[entre(28, 40), 0.6], [entre(55, 75), 1]] : [[entre(30, 48), 1]]),
        'Colmena': () => (f.fecha >= '2026-07-01' && f.fecha < '2026-09-01' ? [] : prob(0.3) ? [[entre(60, 80), 0.5], [entre(95, 125), 1]] : [[entre(65, 105), 1]]),
      };
      let pagos;
      if (f.tipo === 'ARL') pagos = plan[f.arl]();
      else if (f.cliente === CLIENTES.galeras) pagos = f.fecha.startsWith('2026-03') ? [[entre(110, 130), 1]] : f.fecha.startsWith('2026-06') ? [[entre(70, 90), 0.5]] : [];
      else if (f.cliente === CLIENTES.clinica) pagos = [[entre(42, 60), 1]];
      else pagos = [[entre(18, 34), 1]];
      for (const [dias, frac] of pagos) {
        const fp = habil(sumarDias(f.fecha, dias));
        ev(fp, 6, async () => {
          if (f.anulada) return;
          await pagar(f.cartera, f.tercero, fp, { fraccion: frac, reteica: f.tipo === 'ARL' ? ICA[f.arl] ?? null : null, subtotal: f.subtotal });
        });
      }
    });
  }

  // Documentos soporte de las cuentas de cobro aceptadas, su nota de ajuste y su pago.
  let dsSeq = 0; let naSeq = 0;
  for (const pc of precuentas) {
    const fecha = habil(sumarDias(fechaCO(pc._respondida), entre(1, 3)));
    if (!fechaPasada(fecha)) continue;
    ev(fecha, 3, async () => {
      const numero = `DEMODS${pad(++dsSeq, 5)}`;
      const items = pc._trabajo.map((o) => ({ orden_id: o.id, codigo: o.codigo, descripcion: `${o.codigo} · ${o.tipo_actividad} · ${o.empresa_nombre}`,
        cantidad: o.horas_asignadas, unitario: pc._prof.valor_hora * 100, base: o.horas_asignadas * pc._prof.valor_hora * 100 }));
      const subtotal = items.reduce((s, i) => s + i.base, 0);
      const id = randomUUID();
      const cxp = await insertarDocumento({ id, tipo: 'DOC_SOPORTE', prefijo: 'DEMODS', numero, tercero_id: pc._prof.tercero_id, fecha, vence: sumarDias(fecha, 30),
        subtotal, precuenta_id: pc.id, observaciones: `Cuenta de cobro de ${pc.periodo} (DEMOSTRACIÓN).` }, items);
      // Nota de ajuste: una hora de menos en una orden (pocas veces).
      if (prob(0.08)) {
        const fNa = habil(sumarDias(fecha, 2));
        ev(fNa, 4, async () => {
          const it = elegir(items);
          const base = pc._prof.valor_hora * 100;
          await insertarDocumento({ id: randomUUID(), tipo: 'NOTA_AJUSTE_DS', prefijo: 'DEMONA', numero: `DEMONA${pad(++naSeq, 5)}`, tercero_id: pc._prof.tercero_id,
            fecha: fNa, vence: fNa, subtotal: base, referencia: id, observaciones: 'Nota de ajuste de DEMOSTRACIÓN (una hora de menos).' },
          [{ orden_id: it.orden_id, codigo: it.codigo, descripcion: it.descripcion, cantidad: 1, unitario: base, base }]);
        });
      }
      // Pago al asesor entre 6 y 14 días después.
      const fp = habil(sumarDias(fecha, entre(6, 14)));
      ev(fp, 7, async () => {
        const doc = await uno(`SELECT id, saldo FROM sst.cartera_documentos WHERE id = $1`, [cxp]);
        if (aCentavos(doc.saldo) <= 0) return;
        const e = await crearEgreso({ tercero_id: pc._prof.tercero_id, fecha: fp, cuenta_banco_id: BANCO, observaciones: 'Egreso de DEMOSTRACIÓN',
          aplicaciones: [{ cartera_documento_id: cxp, valor_pagado: doc.saldo }] }, ADMIN, { client });
        egresosIds.push(e.id);
      });
    });
  }

  // Compras y gastos del mes (las a crédito se pagan al vencer).
  const C = {
    arriendo: await cuenta('51201001'), energia: await cuenta('51353001'), telefono: await cuenta('51353501'),
    contabilidad: await cuenta('51101001'), papeleria: await cuenta('51953001'), pasajes: await cuenta('51552001'),
    viaje: await cuenta('51550501'), combustible: await cuenta('51953501'), bancarios: await cuenta('5305050101'),
    software: await cuenta('51352001'), mantenimiento: await cuenta('51452501'), bienestar: await cuenta('51059501'),
    seguros: await cuenta('51303001'), aseo: await cuenta('51952501'),
  };
  let fpSeq = 0;
  const compra = (fecha, tercero, tipo, items, { credito = false, plazo = 15 } = {}) => ev(fecha, 5, async () => {
    const r = await crearCompra({
      tipo, tercero_id: tercero, numero_proveedor: tipo === 'GASTO_INTERNO' ? null : `DEMO-FP-${pad(++fpSeq, 5)}`, fecha,
      forma_pago: credito ? 'CREDITO' : 'CONTADO', vencimiento: credito ? sumarDias(fecha, plazo) : null, cuenta_pago_id: credito ? null : BANCO,
      descripcion: 'Compra de DEMOSTRACIÓN', items,
    }, ADMIN, { client });
    comprasIds.push(r.id);
    if (credito) {
      const cxp = await uno(`SELECT id FROM sst.cartera_documentos WHERE compra_id = $1`, [r.id]);
      const fp = habil(sumarDias(fecha, plazo + entre(-3, 2)));
      ev(fp, 7, async () => {
        const doc = await uno(`SELECT saldo FROM sst.cartera_documentos WHERE id = $1`, [cxp.id]);
        if (aCentavos(doc.saldo) <= 0) return;
        const e = await crearEgreso({ tercero_id: tercero, fecha: fp, cuenta_banco_id: BANCO, observaciones: 'Egreso de DEMOSTRACIÓN',
          aplicaciones: [{ cartera_documento_id: cxp.id, valor_pagado: doc.saldo }] }, ADMIN, { client });
        egresosIds.push(e.id);
      });
    }
  });
  for (const ym of MESES) {
    compra(habil(`${ym}-01`), PROV.inmobiliaria, 'SERVICIO', [{ cuenta_id: C.arriendo, descripcion: 'Arriendo oficina Pasto', valor: '2500000', iva_pct: 19 }], { credito: true, plazo: 10 });
    compra(habil(`${ym}-08`), PROV.energia, 'SERVICIO', [{ cuenta_id: C.energia, descripcion: 'Energía eléctrica', valor: String(entre(170, 260) * 1000) }]);
    compra(habil(`${ym}-09`), PROV.telefonia, 'SERVICIO', [{ cuenta_id: C.telefono, descripcion: 'Internet y telefonía', valor: '189900', iva_pct: 19 }]);
    compra(habil(`${ym}-25`), PROV.contador, 'SERVICIO_PROFESIONAL', [{ cuenta_id: C.contabilidad, descripcion: 'Honorarios de revisoría y contabilidad', valor: '1200000' }], { credito: true, plazo: 20 });
    compra(habil(`${ym}-12`), PROV.tecnologia, 'SERVICIO', [{ cuenta_id: C.software, descripcion: 'Licencias de software y nube', valor: String(entre(28, 36) * 10000), iva_pct: 19 }]);
    if (prob(0.75)) compra(habil(`${ym}-${pad(entre(3, 26), 2)}`), PROV.papeleria, 'COMPRA', [{ cuenta_id: C.papeleria, descripcion: 'Papelería y fotocopias', valor: String(entre(8, 35) * 10000), iva_pct: 19 }, { cuenta_id: C.aseo, descripcion: 'Elementos de aseo y cafetería', valor: String(entre(5, 15) * 10000), iva_pct: 19 }]);
    const viajes = Math.round((VOLUMEN[ym] / 40) * entre(5, 9));
    for (let i = 0; i < viajes; i++) {
      compra(habil(`${ym}-${pad(entre(2, 27), 2)}`), elegir([PROV.transporte, PROV.combustible]), 'GASTO_INTERNO',
        [elegir([{ cuenta_id: C.pasajes, descripcion: 'Pasajes terrestres a visitas', valor: String(entre(4, 18) * 10000) },
          { cuenta_id: C.combustible, descripcion: 'Combustible vehículo de visitas', valor: String(entre(8, 20) * 10000) },
          { cuenta_id: C.viaje, descripcion: 'Alojamiento y alimentación en comisión', valor: String(entre(10, 32) * 10000) }])]);
    }
    compra(ultimoDiaMes(ym) > HOY ? HOY : ultimoDiaMes(ym), PROV.banco, 'GASTO_INTERNO', [{ cuenta_id: C.bancarios, descripcion: 'Comisiones y gravamen bancario', valor: String(entre(45, 95) * 1000) }]);
  }
  compra('2025-12-12', PROV.papeleria, 'COMPRA', [{ cuenta_id: C.bienestar, descripcion: 'Celebración de fin de año del equipo', valor: '2800000', iva_pct: 19 }], { credito: true, plazo: 30 });
  compra('2026-01-19', PROV.seguros, 'SERVICIO', [{ cuenta_id: C.seguros, descripcion: 'Póliza anual de la oficina', valor: '1850000', iva_pct: 19 }], { credito: true, plazo: 30 });
  compra('2026-01-26', PROV.tecnologia, 'SERVICIO', [{ cuenta_id: C.mantenimiento, descripcion: 'Mantenimiento de equipos de cómputo', valor: '950000', iva_pct: 19 }]);
  compra('2026-07-14', PROV.tecnologia, 'SERVICIO', [{ cuenta_id: C.mantenimiento, descripcion: 'Mantenimiento de equipos de cómputo', valor: '780000', iva_pct: 19 }]);

  eventos.sort((a, b) => a.fecha.localeCompare(b.fecha) || a.prioridad - b.prioridad);
  // Los eventos pueden programar otros (pagos, notas): se procesan en una cola ordenada.
  let procesados = 0;
  while (eventos.length) {
    eventos.sort((a, b) => a.fecha.localeCompare(b.fecha) || a.prioridad - b.prioridad);
    const e = eventos.shift();
    await e.fn();
    if (++procesados % 100 === 0) console.log(`  … ${procesados} eventos contables (${e.fecha})`);
  }
  registrar('documentos_electronicos', docsCreados);
  registrar('recibos_caja', recibosIds);
  registrar('egresos', egresosIds);
  registrar('compras', comprasIds);

  // historial_cobro_orden con el documento de la factura (como lo deja la emisión).
  await q(`UPDATE sst.historial_cobro_orden h SET documento_id = d.id
             FROM sst.documentos_electronicos d
            WHERE h.id = ANY($1::uuid[]) AND d.tipo = 'FACTURA' AND d.numero = h.numero_factura`, [[...registro.get('historial_cobro_orden') ?? []]]);

  // ─── Nómina mensual VALIDADA (no se contabiliza: ORBITA aún no lo hace) ─────
  const nominas = [];
  let neSeq = 0;
  for (const ym of MESES) {
    const [anio, mes] = ym.split('-').map(Number);
    const fechaPago = ultimoDiaMes(ym);
    if (!fechaPasada(fechaPago)) continue; // el mes en curso aún no se liquida
    const parametros = await parametrosDelAnio(anio, client);
    if (!parametros) throw new Error(`Faltan los parámetros de nómina de ${anio}`);
    for (const e of EMPLEADOS) {
      const novedades = {};
      const liq = liquidar({ salario: e.salario, periodo: { anio, mes, parametros }, salarioIntegral: false, novedades, parametros, diasPeriodo: 30 });
      const numero = `DEMONE${pad(++neSeq, 5)}`;
      nominas.push({ id: randomUUID(), empleado_id: e.id, anio, mes, estado: 'VALIDADO', salario: e.salario, salario_integral: false, novedades,
        liquidacion: liq, dias_trabajados: liq.diasTrabajados, total_devengado: liq.totales.devengado, total_deducido: liq.totales.deducido,
        neto: liq.totales.neto, fecha_pago: fechaPago, observaciones: 'Nómina de DEMOSTRACIÓN (no enviada a la DIAN).',
        reference_code: `DEMO-${numero}`, numero, cune: `DEMO-CUNE-${pad(neSeq, 6)}`, validada_en: instante(fechaPago, 17).toISOString(),
        respuesta_proveedor: { demo: true }, creado_por: ADMIN, actualizado_por: ADMIN, creado_en: instante(fechaPago, 9).toISOString(), actualizado_en: instante(fechaPago, 17).toISOString() });
    }
  }
  await insertar('nomina_liquidaciones', nominas);

  // ─── Cierre de los meses ya revisados (dic-2025 → sep-2026) ─────────────────
  // La validación de cada comprobante es un trigger DIFERIDO (cuadre, cuentas, periodo
  // abierto) que corre al COMMIT; si los meses se cierran antes, el COMMIT falla con «El
  // periodo 2025-12 está cerrado». Se disparan aquí, con los periodos aún abiertos (y así
  // el ensayo con ROLLBACK valida lo mismo que el COMMIT).
  await q('SET CONSTRAINTS ALL IMMEDIATE');
  const cerrados = [];
  for (const ym of MESES.filter((m) => m <= '2026-09')) {
    const [anio, mes] = ym.split('-').map(Number);
    const existe = await uno(`SELECT id FROM sst.periodos_contables WHERE anio = $1 AND mes = $2`, [anio, mes]);
    if (existe) continue; // no se toca un periodo que ya tenía fila
    const id = randomUUID();
    await q(`INSERT INTO sst.periodos_contables (id, anio, mes, estado, cerrado_por, cerrado_en) VALUES ($1, $2, $3, 'CERRADO', $4, $5)`,
      [id, anio, mes, ADMIN, instante(habil(`${mesSiguiente(ym)}-10`), 18).toISOString()]);
    cerrados.push(id);
  }
  registrar('periodos_contables', cerrados);

  // ─── Lo que crearon los servicios: se registra por relación ─────────────────
  const ids = (tabla) => [...(registro.get(tabla) ?? [])];
  const porConsulta = async (tabla, sql, p) => registrar(tabla, (await q(sql, p)).rows.map((r) => r.id));
  await porConsulta('comprobantes', `SELECT comprobante_id AS id FROM sst.documentos_electronicos WHERE id = ANY($1::uuid[]) AND comprobante_id IS NOT NULL
                                     UNION SELECT comprobante_id FROM sst.recibos_caja WHERE id = ANY($2::uuid[])
                                     UNION SELECT comprobante_id FROM sst.egresos WHERE id = ANY($3::uuid[])
                                     UNION SELECT comprobante_id FROM sst.compras WHERE id = ANY($4::uuid[])`,
  [ids('documentos_electronicos'), ids('recibos_caja'), ids('egresos'), ids('compras')]);
  await porConsulta('movimientos', `SELECT id FROM sst.movimientos WHERE comprobante_id = ANY($1::uuid[])`, [ids('comprobantes')]);
  await porConsulta('cartera_documentos', `SELECT id FROM sst.cartera_documentos WHERE documento_id = ANY($1::uuid[]) OR compra_id = ANY($2::uuid[])`, [ids('documentos_electronicos'), ids('compras')]);
  await porConsulta('cartera_aplicaciones', `SELECT id FROM sst.cartera_aplicaciones WHERE cartera_documento_id = ANY($1::uuid[])`, [ids('cartera_documentos')]);
  await porConsulta('cartera_aplicacion_retenciones', `SELECT id FROM sst.cartera_aplicacion_retenciones WHERE aplicacion_id = ANY($1::uuid[])`, [ids('cartera_aplicaciones')]);
  await porConsulta('compra_items', `SELECT id FROM sst.compra_items WHERE compra_id = ANY($1::uuid[])`, [ids('compras')]);
  await porConsulta('compra_retenciones', `SELECT id FROM sst.compra_retenciones WHERE compra_id = ANY($1::uuid[])`, [ids('compras')]);

  // Consecutivos contables: de vuelta a su valor exacto.
  for (const c of consecutivos) await q(`UPDATE sst.tipos_comprobante SET consecutivo_actual = $2 WHERE id = $1`, [c.id, c.consecutivo_actual]);

  for (const [tabla, set] of registro) {
    const lista = [...set];
    for (let i = 0; i < lista.length; i += 2000) {
      await q(`INSERT INTO demo_semilla.registro (tabla, id) SELECT $1, unnest($2::uuid[])`, [tabla, lista.slice(i, i + 2000)]);
    }
  }
  await q(`INSERT INTO demo_semilla.meta (clave, valor) VALUES ('conteos_antes', $1), ('consecutivos', $2), ('sembrado_en', $3), ('version', '"1"')`,
    [JSON.stringify(antes), JSON.stringify(consecutivos), JSON.stringify(AHORA.toISOString())]);

  // ─── Verificación dentro de la transacción ──────────────────────────────────
  const fallos = [];
  const libro = await uno(`SELECT COALESCE(sum(m.debito),0)::numeric(16,2) AS d, COALESCE(sum(m.credito),0)::numeric(16,2) AS c
                             FROM sst.movimientos m JOIN sst.comprobantes c ON c.id = m.comprobante_id WHERE c.estado = 'CONTABILIZADO'`);
  if (libro.d !== libro.c) fallos.push(`El libro no cuadra: débitos ${libro.d} ≠ créditos ${libro.c}`);
  const conc = { cxc: await conciliacion(client, 'CXC'), cxp: await conciliacion(client, 'CXP') };
  for (const k of ['cxc', 'cxp']) {
    if (conc[k].diferencia !== concAntes[k].diferencia) fallos.push(`La conciliación ${k.toUpperCase()} cambió: antes ${concAntes[k].diferencia}, ahora ${conc[k].diferencia}`);
  }
  const consecDespues = (await q(`SELECT id, consecutivo_actual FROM sst.tipos_comprobante`)).rows;
  for (const c of consecutivos) if (consecDespues.find((x) => x.id === c.id).consecutivo_actual !== c.consecutivo_actual) fallos.push(`Consecutivo ${c.codigo} no se restauró`);
  const pendientes = await uno(`SELECT count(*)::int AS n FROM sst.documentos_electronicos WHERE id = ANY($1::uuid[]) AND comprobante_id IS NULL`, [ids('documentos_electronicos')]);
  if (pendientes.n) fallos.push(`${pendientes.n} documentos demo quedaron sin contabilizar`);

  const despues = await conteos();
  console.log('\nFilas nuevas por tabla:');
  const tabla = Object.keys(despues).filter((t) => despues[t] !== antes[t]).map((t) => ({ tabla: t, antes: antes[t], despues: despues[t], nuevas: despues[t] - antes[t], registradas: registro.get(t)?.size ?? '(por cascada)' }));
  console.table(tabla);
  const porMes = await q(`
    SELECT m.mes,
      (SELECT count(*) FROM sst.ordenes_servicio o WHERE o.id = ANY($1::uuid[]) AND to_char(o.fecha_carga AT TIME ZONE 'America/Bogota','YYYY-MM') = m.mes)::int AS ordenes,
      (SELECT count(*) FROM sst.respuestas_encuesta e WHERE e.orden_id = ANY($1::uuid[]) AND to_char(e.respondido_en AT TIME ZONE 'America/Bogota','YYYY-MM') = m.mes)::int AS encuestas_resp,
      (SELECT count(*) FROM sst.documentos_electronicos d WHERE d.id = ANY($2::uuid[]) AND d.tipo='FACTURA' AND to_char(d.fecha_emision,'YYYY-MM') = m.mes)::int AS fe,
      (SELECT count(*) FROM sst.documentos_electronicos d WHERE d.id = ANY($2::uuid[]) AND d.tipo='NOTA_CREDITO' AND to_char(d.fecha_emision,'YYYY-MM') = m.mes)::int AS nc,
      (SELECT count(*) FROM sst.documentos_electronicos d WHERE d.id = ANY($2::uuid[]) AND d.tipo='DOC_SOPORTE' AND to_char(d.fecha_emision,'YYYY-MM') = m.mes)::int AS ds,
      (SELECT count(*) FROM sst.recibos_caja r WHERE r.id = ANY($3::uuid[]) AND to_char(r.fecha,'YYYY-MM') = m.mes)::int AS rc,
      (SELECT count(*) FROM sst.compras c WHERE c.id = ANY($4::uuid[]) AND to_char(c.fecha,'YYYY-MM') = m.mes)::int AS compras,
      (SELECT count(*) FROM sst.egresos e WHERE e.id = ANY($5::uuid[]) AND to_char(e.fecha,'YYYY-MM') = m.mes)::int AS egresos,
      (SELECT COALESCE(sum(d.subtotal) FILTER (WHERE d.tipo='FACTURA'),0) - COALESCE(sum(d.subtotal) FILTER (WHERE d.tipo='NOTA_CREDITO'),0)
         FROM sst.documentos_electronicos d WHERE d.id = ANY($2::uuid[]) AND to_char(d.fecha_emision,'YYYY-MM') = m.mes)::numeric(16,0) AS ventas_netas
      FROM unnest($6::text[]) AS m(mes) ORDER BY 1`,
  [ids('ordenes_servicio'), ids('documentos_electronicos'), ids('recibos_caja'), ids('compras'), ids('egresos'), MESES]);
  console.log('\nSembrado por mes:');
  console.table(porMes.rows);
  console.log(`Libro: débitos ${libro.d} = créditos ${libro.c} (antes ${libroAntes.d}).`);
  console.log(`Conciliación CXC: diferencia ${conc.cxc.diferencia} (antes ${concAntes.cxc.diferencia}) · CXP: ${conc.cxp.diferencia} (antes ${concAntes.cxp.diferencia}).`);

  if (fallos.length) {
    console.error('\n❌ Verificación fallida:\n - ' + fallos.join('\n - '));
    await q('ROLLBACK');
    process.exitCode = 1;
  } else if (APLICAR) {
    await q('COMMIT');
    console.log('\n✅ Semilla APLICADA (COMMIT).');
  } else {
    await q('ROLLBACK');
    console.log('\n↩️  Ensayo terminado: ROLLBACK (nada quedó en la base). Use --aplicar para guardar.');
  }
} catch (e) {
  await q('ROLLBACK').catch(() => {});
  console.error('❌ Error, se deshizo todo:', e.message);
  console.error(e.stack);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
