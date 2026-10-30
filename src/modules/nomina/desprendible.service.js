import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { pool } from '../../config/db.js';
import { badRequest } from '../../utils/httpError.js';
import { validarCorreo } from '../../utils/personas.js';
import { sendEmail } from '../../services/email.service.js';
import { bloqueTotal, correoHtml, filaDato, parrafo, tablaDatos } from '../../services/email-layout.service.js';
import { OTRAS_DEDUCCIONES, OTROS_DEVENGADOS, TIPOS_HORA, TIPOS_LICENCIA } from './calculo.js';
import { obtenerEmpleado } from './empleados.service.js';
import { obtenerLiquidacion } from './liquidaciones.service.js';

/**
 * A5-01 · Comprobante de nómina en PDF: lo que se le entrega al empleado.
 *
 * 8-oct-2026 · MISMO FORMATO del comprobante que JD&D entregaba desde su software contable
 * anterior (modelo enviado por la contadora: «Comprobante de Nómina», abril de 2026):
 * marco, título centrado, logo y razón social a la izquierda, datos del periodo y del
 * empleado a la derecha, INGRESOS y DEDUCCIONES lado a lado con Concepto · Cantidad ·
 * Valor, y el NETO A PAGAR. Como con la factura, aquí no se «mejora» el diseño.
 *
 * Lo único propio: si la nómina no está validada lleva una marca «BORRADOR» (o «ANULADA»),
 * y si lo está, una línea final con el número de la nómina electrónica y su CUNE.
 */

const LOGO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../assets/facturacion/logo-jdd.jpg');
const [W, H] = [612, 792];
const NEGRO = rgb(0, 0, 0);
const GRIS_CABECERA = rgb(0.88, 0.88, 0.88);
const LINEA = rgb(0.72, 0.72, 0.72);
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

const winAnsi = (t) => String(t ?? '').replace(/—/g, '-').replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF‘’“”–…•€]/g, '?');
/** «$ 1,984,500.00», como en el modelo. */
const dinero = (v) => `$ ${(Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** Para el correo: pesos a la colombiana. */
const pesos = (v) => `$ ${(Number(v) || 0).toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fechaCO = (f) => { const [a, m, d] = String(f ?? '').slice(0, 10).split('-'); return a && m && d ? `${d}/${m}/${a}` : '-'; };
const cantidad = (n) => (n == null ? '0.0' : Number(n).toFixed(2));

/**
 * Los renglones del comprobante: [concepto, cantidad, valor]. Solo los conceptos con valor.
 * Los nombres son los del comprobante anterior («Aux. de transporte/Aux. de conectividad
 * digital», «Vacaciones disfrutadas», «Fondo de salud»…). La cantidad son días u horas; en
 * lo que no tiene, va «0.0» como en el modelo.
 */
export function renglonesDesprendible(r) {
  const d = r.devengados;
  const ingresos = [['Sueldo', r.diasTrabajados, d.sueldo]];
  if (d.auxilioTransporte) ingresos.push(['Aux. de transporte/Aux. de conectividad digital', r.diasTrabajados, d.auxilioTransporte]);
  for (const h of d.horas) ingresos.push([TIPOS_HORA[h.tipo]?.nombre ?? 'Horas extra', h.cantidad, h.valor]);
  if (d.comisiones) ingresos.push(['Comisiones', null, d.comisiones]);
  if (d.bonificacion) ingresos.push(['Bonificación', null, d.bonificacion]);
  for (const v of d.vacaciones) ingresos.push([v.codigo === 2 ? 'Vacaciones compensadas' : 'Vacaciones disfrutadas', v.dias, v.valor]);
  for (const l of d.licencias) ingresos.push([TIPOS_LICENCIA[l.tipo]?.nombre ?? 'Licencia', l.dias, l.valor]);
  for (const i of d.incapacidades) ingresos.push(['Incapacidad por enfermedad general', i.dias, i.valor]);
  if (d.prima) ingresos.push(['Prima de servicios', d.prima.dias, d.prima.valor]);
  if (d.cesantias) {
    ingresos.push(['Cesantías', d.cesantias.dias, d.cesantias.valor]);
    ingresos.push(['Intereses a las cesantías', null, d.cesantias.intereses]);
  }
  // `?? []`: las liquidaciones guardadas antes del 8-oct-2026 no traen estas listas.
  for (const o of d.otros ?? []) ingresos.push([o.descripcion || OTROS_DEVENGADOS[o.tipo]?.nombre || 'Otro pago', null, o.valor]);

  const x = r.deducciones;
  const deducciones = [['Fondo de salud', null, x.salud.valor], ['Fondo de pensión', null, x.pension.valor]];
  if (x.fondoSolidaridad) deducciones.push(['Fondo de solidaridad pensional', null, x.fondoSolidaridad.valor]);
  for (const o of x.otras ?? []) {
    const nombre = OTRAS_DEDUCCIONES[o.tipo]?.nombre ?? 'Otra deducción';
    deducciones.push([o.descripcion ? `${nombre}: ${o.descripcion}` : nombre, null, o.valor]);
  }
  return { ingresos, deducciones };
}

/** Parte un texto en renglones que quepan en `ancho` puntos. */
function renglones(texto, fuente, tam, ancho) {
  const salida = [];
  let linea = '';
  for (const palabra of winAnsi(texto).split(/\s+/).filter(Boolean)) {
    const prueba = linea ? `${linea} ${palabra}` : palabra;
    if (fuente.widthOfTextAtSize(prueba, tam) <= ancho || !linea) linea = prueba;
    else { salida.push(linea); linea = palabra; }
  }
  if (linea) salida.push(linea);
  return salida;
}

/** Devuelve { nombre, buffer } del comprobante de una liquidación. */
export async function pdfDesprendible(liquidacionId) {
  const liq = await obtenerLiquidacion(liquidacionId);
  const emp = await obtenerEmpleado(liq.empleado_id);
  const e = (await pool.query(`SELECT razon_social, nit FROM sst.emisor WHERE id = 1`)).rows[0];
  // Sin empresa emisora parametrizada: la razón social y el NIT del comprobante modelo.
  const empresa = e ? { nombre: e.razon_social, nit: e.nit } : { nombre: 'J D Y D CONSULTORES EN SISTEMAS DE GESTION SAS', nit: '901203812' };

  const pdf = await PDFDocument.create();
  const [n, b] = await Promise.all([pdf.embedFont(StandardFonts.Helvetica), pdf.embedFont(StandardFonts.HelveticaBold)]);
  const p = pdf.addPage([W, H]);
  // Todas las medidas van «desde arriba».
  const texto = (t, x, arriba, { f = n, s = 8.5 } = {}) => p.drawText(winAnsi(t), { x, y: H - arriba, size: s, font: f, color: NEGRO });
  const ancho = (t, { f = n, s = 8.5 } = {}) => f.widthOfTextAtSize(winAnsi(t), s);
  const derecha = (t, xDer, arriba, o = {}) => texto(t, xDer - ancho(t, o), arriba, o);
  const centro = (t, xCentro, arriba, o = {}) => texto(t, xCentro - ancho(t, o) / 2, arriba, o);
  const caja = (x1, arriba, x2, abajo, relleno = null) => p.drawRectangle({ x: x1, y: H - abajo, width: x2 - x1, height: abajo - arriba, borderColor: LINEA, borderWidth: 0.8, ...(relleno ? { color: relleno } : {}) });
  /** «Rótulo: valor» alineado a la derecha, con el valor en negrita, como en el modelo. */
  const par = (rotulo, valor, xDer, arriba) => {
    const v = winAnsi(valor || '');
    derecha(v, xDer, arriba, { f: b });
    derecha(`${rotulo} `, xDer - ancho(v, { f: b }), arriba);
  };

  const [IZQ, DER] = [36, W - 36];
  const [X1, X2] = [IZQ + 34, DER - 34]; // el cuerpo, dentro del marco
  const MEDIO = (X1 + X2) / 2;

  // ── Título
  centro('Comprobante de Nómina', W / 2, 62, { s: 15 });

  // ── Logo y razón social (izquierda)
  let yLogo = 100;
  if (fs.existsSync(LOGO)) {
    const logo = await pdf.embedJpg(new Uint8Array(fs.readFileSync(LOGO)));
    const wLogo = 170;
    const hLogo = wLogo * (logo.height / logo.width);
    p.drawImage(logo, { x: X1 - 6, y: H - yLogo - hLogo, width: wLogo, height: hLogo });
    yLogo += hLogo + 9;
  }
  const xLogo = X1 + 80;
  for (const l of renglones(empresa.nombre, b, 8, 176)) { centro(l, xLogo, yLogo, { f: b, s: 8 }); yLogo += 9.5; }
  centro(`Nit ${empresa.nit}`, xLogo, yLogo, { f: b, s: 8 });

  // ── Periodo y empleado (derecha)
  const ultimo = new Date(Date.UTC(liq.anio, liq.mes, 0)).getUTCDate();
  const mm = String(liq.mes).padStart(2, '0');
  par('Periodo de Pago:', `${liq.anio}/${mm}/01 - ${liq.anio}/${mm}/${ultimo}`, X2, 116);
  par('Comprobante Número:', liq.numero ?? 'sin emitir', X2, 129);
  par('Nombre:', emp.nombre.toUpperCase(), X2, 155);
  par('Identificación:', emp.numero_documento, X2, 168);
  par('Cargo:', emp.cargo ?? '', X2, 181);
  par('Salario básico:', dinero(liq.salario).replace('$ ', '$'), X2, 194);

  // ── INGRESOS y DEDUCCIONES
  const { ingresos, deducciones } = renglonesDesprendible(liq.liquidacion);
  const ARRIBA = Math.max(yLogo + 26, 232);
  const ALTO_CAB = 20;
  // Columnas de cada tabla: concepto · cantidad · valor
  const columnas = (x1, x2) => [x1, x1 + (x2 - x1) * 0.53, x1 + (x2 - x1) * 0.71, x2];
  const pintar = (titulo, filas, total, rotuloTotal, x1, x2) => {
    const c = columnas(x1, x2);
    caja(x1, ARRIBA, x2, ARRIBA + ALTO_CAB, GRIS_CABECERA);
    centro(titulo, (x1 + x2) / 2, ARRIBA + 13.5, { f: b, s: 10 });
    let y = ARRIBA + ALTO_CAB;
    caja(x1, y, x2, y + ALTO_CAB);
    for (let i = 0; i < 3; i++) {
      if (i) p.drawLine({ start: { x: c[i], y: H - y }, end: { x: c[i], y: H - y - ALTO_CAB }, thickness: 0.8, color: LINEA });
      centro(['Concepto', 'Cantidad', 'Valor'][i], (c[i] + c[i + 1]) / 2, y + 13, { f: b });
    }
    y += ALTO_CAB;
    for (const [concepto, cant, valor] of filas) {
      const lineas = renglones(concepto, n, 8.5, c[1] - c[0] - 10);
      const alto = Math.max(20, lineas.length * 10.5 + 9);
      caja(x1, y, x2, y + alto);
      for (const xi of [c[1], c[2]]) p.drawLine({ start: { x: xi, y: H - y }, end: { x: xi, y: H - y - alto }, thickness: 0.8, color: LINEA });
      lineas.forEach((l, k) => texto(l, c[0] + 5, y + 13 + k * 10.5));
      const yMedio = y + alto / 2 + 3;
      derecha(cantidad(cant), c[2] - 6, yMedio);
      derecha(dinero(valor), c[3] - 6, yMedio);
      y += alto;
    }
    return { y, total: (yTotal) => {
      caja(x1, yTotal, x2, yTotal + ALTO_CAB);
      p.drawLine({ start: { x: c[2], y: H - yTotal }, end: { x: c[2], y: H - yTotal - ALTO_CAB }, thickness: 0.8, color: LINEA });
      derecha(rotuloTotal, c[2] - 6, yTotal + 13, { f: b });
      derecha(dinero(total), c[3] - 6, yTotal + 13, { f: b });
    } };
  };
  const t = liq.liquidacion.totales;
  const a = pintar('INGRESOS', ingresos, t.devengado, 'Total Ingresos', X1, MEDIO);
  const c = pintar('DEDUCCIONES', deducciones, t.deducido, 'Total Deducciones', MEDIO, X2);
  // Las dos tablas terminan a la misma altura: la más corta se completa con un recuadro vacío.
  const yTotales = Math.max(a.y, c.y);
  if (a.y < yTotales) caja(X1, a.y, MEDIO, yTotales);
  if (c.y < yTotales) caja(MEDIO, c.y, X2, yTotales);
  a.total(yTotales);
  c.total(yTotales);

  // ── NETO A PAGAR (a la derecha, bajo las deducciones)
  const yNeto = yTotales + ALTO_CAB + 15;
  const xNeto = MEDIO + 22;
  const xNetoMedio = xNeto + (X2 - xNeto) * 0.49;
  caja(xNeto, yNeto, X2, yNeto + 24, GRIS_CABECERA);
  texto('NETO A PAGAR', xNeto + 7, yNeto + 16, { f: b, s: 10 });
  p.drawLine({ start: { x: xNetoMedio, y: H - yNeto }, end: { x: xNetoMedio, y: H - yNeto - 24 }, thickness: 0.8, color: LINEA });
  derecha(dinero(t.neto), X2 - 7, yNeto + 16, { f: b, s: 10 });

  // ── Pie
  let yPie = yNeto + 64;
  centro('Este comprobante de nómina fue elaborado y enviado a través de ORBITA.', W / 2, yPie);
  if (liq.cune) {
    yPie += 14;
    centro(`${liq.estado === 'ANULADO' ? `Anulada con la nota de ajuste ${liq.nota_numero ?? ''} · ` : ''}Nómina electrónica ${liq.numero} · CUNE`, W / 2, yPie, { s: 6.5 });
    yPie += 8.5;
    centro(liq.cune, W / 2, yPie, { s: 6 });
  }

  // ── Marco, con el alto que haya ocupado el contenido
  caja(IZQ, 30, DER, yPie + 22);

  // ── Marca de agua mientras no esté en firme
  const marca = liq.estado === 'ANULADO' ? 'ANULADA' : liq.estado === 'VALIDADO' ? null : 'BORRADOR';
  if (marca) p.drawText(marca, { x: 130, y: H - yTotales - 40, size: 80, font: b, color: rgb(0.86, 0.86, 0.88), opacity: 0.45, rotate: degrees(28) });

  const archivo = `nomina-${liq.anio}-${mm}-${emp.numero_documento}.pdf`;
  return { nombre: archivo, buffer: Buffer.from(await pdf.save()) };
}

/**
 * Le envía el comprobante por correo al empleado, con el PDF adjunto. Solo de una nómina
 * validada: un borrador puede cambiar y no debe llegarle como si fuera el pago en firme.
 * Devuelve la dirección a la que salió.
 */
export async function enviarDesprendible(liquidacionId, correoAlterno) {
  const liq = await obtenerLiquidacion(liquidacionId);
  if (liq.estado !== 'VALIDADO') throw badRequest('El desprendible se envía cuando la nómina ya está validada por la DIAN.');
  const emp = await obtenerEmpleado(liq.empleado_id);
  const destino = validarCorreo(correoAlterno || emp.correo, { obligatorio: false });
  if (!destino) throw badRequest(`${emp.nombre} no tiene correo en su ficha de empleado. Escríbalo o agréguelo en Nómina → Empleados.`);

  const { nombre, buffer } = await pdfDesprendible(liquidacionId);
  const periodo = `${MESES[liq.mes - 1]} de ${liq.anio}`;
  const neto = pesos(liq.neto);
  await sendEmail({
    to: destino,
    subject: `Comprobante de nómina de ${periodo} — JD&D Consultores`,
    text:
      `Hola, ${emp.nombre}:\n\n` +
      `Adjuntamos su comprobante de pago de nómina de ${periodo}.\n\n` +
      `  · Neto pagado: ${neto}\n` +
      `  · Fecha de pago: ${fechaCO(liq.fecha_pago)}\n` +
      `  · Nómina electrónica: ${liq.numero}\n\n` +
      `JD&D Consultores en Sistemas de Gestión\n`,
    html: correoHtml({
      titulo: 'Comprobante de nómina',
      subtitulo: `${periodo} · ${emp.nombre}`,
      pie: 'JD&D Consultores · Seguridad y Salud en el Trabajo',
      cuerpo: [
        parrafo(`Hola, ${emp.nombre}:`),
        parrafo(`Adjuntamos su comprobante de pago de nómina de ${periodo}.`),
        bloqueTotal('Neto pagado', neto, `Pagado el ${fechaCO(liq.fecha_pago)}`),
        tablaDatos([
          filaDato('Total devengado', pesos(liq.total_devengado)),
          filaDato('Total deducciones', pesos(liq.total_deducido)),
          filaDato('Nómina electrónica', liq.numero),
        ]),
      ].join(''),
    }),
    attachments: [{ filename: nombre, content: buffer }],
  });
  return destino;
}
