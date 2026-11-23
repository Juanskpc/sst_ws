// Verifica el arreglo del 22-nov-2026 (reporte del cliente del 20-nov, OS-2026-0249:
// «debía generar 4 formatos pero llegó solo uno y los que aparecen como descargar es
// una fecha en calendario»). No toca la base: arma órdenes en memoria.
//   · Bolívar, asistencia técnica / asesoría en 4 sesiones → 4 AT-031, cada uno con
//     la fecha y el horario de SU sesión, y nombres que dicen qué sesión es;
//   · Bolívar, capacitación presencial en 2 sesiones → sigue saliendo 1 AT-031 y
//     2 AT-028 (T0-13, verificado con el cliente el 29-sep);
//   · con una sola sesión el AT-031 se sigue llamando «seguimiento.pdf»;
//   · las invitaciones .ics se llaman «Calendario - sesion N de M - OS-….ics» y las
//     canceladas lo dicen.
//
// Uso: cd sst_ws && node --import tsx scripts/verificar-formatos-por-sesion.mjs
import { PDFDocument } from 'pdf-lib';
import { generarFormatosArl } from '../src/services/formatos-arl.service.js';
import { construirInvitaciones } from '../src/services/calendar.service.js';

let fallos = 0;
const igual = (obtenido, esperado, texto) => {
  const ok = JSON.stringify(obtenido) === JSON.stringify(esperado);
  if (!ok) fallos++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${texto} → ${JSON.stringify(obtenido)}${ok ? '' : ` (esperado ${JSON.stringify(esperado)})`}`);
};

const ordenBase = {
  id: '00000000-0000-0000-0000-000000000249', codigo: 'OS-PRUEBA-0249', arl_id: 1, arl_nombre: 'Bolívar',
  empresa_nombre: 'EMPRESA DE PRUEBA SAS', nit_nic: '900000000', direccion: 'Calle 1 # 2-3',
  ciudad_ejecucion: 'Pasto', codigo_cronograma: '1379444', secuencia: '57', horas_asignadas: 16,
  tipo_actividad: 'ASISTENCIA TECNICA EN SST', modalidad_ejecucion: 'PRESENCIAL',
};
const profesional = { id: 'p1', nombre: 'ASESOR DE PRUEBA', correo: 'asesor@prueba.invalid' };
const cuatro = [
  { fecha: '2026-11-19', hora_inicio: '08:00:00', hora_fin: '12:00:00' },
  { fecha: '2026-11-20', hora_inicio: '08:00:00', hora_fin: '12:00:00' },
  { fecha: '2026-11-24', hora_inicio: '14:00:00', hora_fin: '18:00:00' },
  { fecha: '2026-11-25', hora_inicio: '08:00:00', hora_fin: '12:00:00' },
];

const leerCampo = async (buffer, nombre) => {
  const doc = await PDFDocument.load(buffer);
  return doc.getForm().getTextField(nombre).getText() ?? '';
};

// 1) Asistencia técnica en 4 sesiones (el caso reportado).
{
  const docs = await generarFormatosArl({ orden: { ...ordenBase, tipo_servicio_arl: 'T' }, profesional, franjas: cuatro });
  const seguimientos = docs.filter((d) => d.clave === 'at031');
  igual(seguimientos.length, 4, 'T en 4 sesiones: un AT-031 por sesión');
  igual(docs.filter((d) => d.clave === 'informeBolivar').length, 1, 'T en 4 sesiones: un solo informe de gestión');
  igual(seguimientos.map((d) => d.filename), [
    'seguimiento - sesion 1 de 4 (19-11-2026).pdf',
    'seguimiento - sesion 2 de 4 (20-11-2026).pdf',
    'seguimiento - sesion 3 de 4 (24-11-2026).pdf',
    'seguimiento - sesion 4 de 4 (25-11-2026).pdf',
  ], 'T en 4 sesiones: nombres con la sesión y su fecha');
  igual(seguimientos.map((d) => d.sesion?.numero), [1, 2, 3, 4], 'T en 4 sesiones: cada archivo sabe su sesión');
  const dias = [];
  const inicios = [];
  for (const d of seguimientos) {
    dias.push(await leerCampo(d.buffer, 'Text1'));
    inicios.push(await leerCampo(d.buffer, '14'));
  }
  igual(dias, ['19', '20', '24', '25'], 'T en 4 sesiones: cada AT-031 trae el día de SU sesión');
  igual(inicios, ['08:00 AM', '08:00 AM', '02:00 PM', '08:00 AM'], 'T en 4 sesiones: y su hora de inicio');
}

// 2) Asesoría en 4 sesiones: misma regla.
{
  const docs = await generarFormatosArl({ orden: { ...ordenBase, tipo_servicio_arl: 'A' }, profesional, franjas: cuatro });
  igual(docs.filter((d) => d.clave === 'at031').length, 4, 'A en 4 sesiones: un AT-031 por sesión');
}

// 3) Capacitación presencial en 2 sesiones: T0-13 intacto (1 AT-031 + 2 AT-028).
{
  const docs = await generarFormatosArl({
    orden: { ...ordenBase, tipo_servicio_arl: 'C', tipo_actividad: 'CAPACITACION' }, profesional, franjas: cuatro.slice(0, 2),
  });
  igual(docs.filter((d) => d.clave === 'at031').map((d) => d.filename), ['seguimiento.pdf'], 'C presencial: un solo AT-031 por orden');
  igual(docs.filter((d) => d.clave === 'at028').map((d) => d.filename), [
    'asistencia - sesion 1 de 2 (19-11-2026).pdf',
    'asistencia - sesion 2 de 2 (20-11-2026).pdf',
  ], 'C presencial: un AT-028 por sesión, con nombre claro');
}

// 4) Una sola sesión: nombres de siempre.
{
  const docs = await generarFormatosArl({ orden: { ...ordenBase, tipo_servicio_arl: 'T' }, profesional, franjas: cuatro.slice(0, 1) });
  igual(docs.map((d) => d.filename), ['informe de gestion (EJEMPLO diligenciado).docx', 'seguimiento.pdf'], 'T en 1 sesión: seguimiento.pdf a secas');
}

// 5) Invitaciones de calendario.
{
  const franjas = cuatro.map((f) => ({ ...f, hora_inicio: f.hora_inicio.slice(0, 5), hora_fin: f.hora_fin.slice(0, 5) }));
  const inv = construirInvitaciones({ orden: ordenBase, profesional, organizador: { nombre: 'Admin', correo: 'a@prueba.invalid' }, franjas });
  igual(inv.map((i) => i.nombre), [
    'Calendario - sesion 1 de 4 - OS-PRUEBA-0249.ics',
    'Calendario - sesion 2 de 4 - OS-PRUEBA-0249.ics',
    'Calendario - sesion 3 de 4 - OS-PRUEBA-0249.ics',
    'Calendario - sesion 4 de 4 - OS-PRUEBA-0249.ics',
  ], '4 sesiones: un .ics por sesión, nombrado como calendario');
  igual(inv.every((i) => (i.contenido.match(/BEGIN:VEVENT/g) || []).length === 1), true, 'cada .ics lleva un solo evento (Gmail solo pinta el primero)');
  const una = construirInvitaciones({ orden: ordenBase, profesional, franjas: franjas.slice(0, 1) });
  igual(una.map((i) => i.nombre), ['Calendario - OS-PRUEBA-0249.ics'], '1 sesión: un solo .ics');
  const repro = construirInvitaciones({ orden: ordenBase, profesional, franjas: franjas.slice(0, 2), previas: 3 });
  igual(repro.map((i) => i.nombre), [
    'Calendario - sesion 1 de 2 - OS-PRUEBA-0249.ics',
    'Calendario - sesion 2 de 2 - OS-PRUEBA-0249.ics',
    'Calendario - sesion 3 CANCELADA - OS-PRUEBA-0249.ics',
  ], 'reprogramar de 3 a 2 sesiones: la sobrante sale cancelada');
}

console.log(fallos ? `\n${fallos} comprobación(es) FALLARON` : '\nTodo OK');
process.exit(fallos ? 1 : 0);
