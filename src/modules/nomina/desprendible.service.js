import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { pool } from '../../config/db.js';
import { OTRAS_DEDUCCIONES, OTROS_DEVENGADOS, TIPOS_HORA, TIPOS_LICENCIA } from './calculo.js';
import { obtenerEmpleado } from './empleados.service.js';
import { obtenerLiquidacion } from './liquidaciones.service.js';

/**
 * A5-01 · Desprendible de nómina en PDF: lo que se le entrega al empleado.
 *
 * Una hoja carta con los datos del empleado, los devengados, las deducciones y el neto.
 * Si la nómina ya está validada lleva el número, el CUNE y el QR de la DIAN; si no,
 * una marca «BORRADOR» (o «ANULADA») para que no se confunda con un comprobante en firme.
 */

const LOGO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../assets/facturacion/logo-jdd.jpg');
const [W, H] = [612, 792];
const AZUL = rgb(0, 0.043, 0.314); // #000b50, el de la identidad
const GRIS = rgb(0.42, 0.45, 0.5);
const LINEA = rgb(0.82, 0.85, 0.9);
const NEGRO = rgb(0.1, 0.1, 0.12);
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

const winAnsi = (t) => String(t ?? '').replace(/—/g, '-').replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF‘’“”–…•€]/g, '?');
const pesos = (v) => `$ ${(Number(v) || 0).toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fechaCO = (f) => { const [a, m, d] = String(f ?? '').slice(0, 10).split('-'); return a && m && d ? `${d}/${m}/${a}` : '-'; };

/** Los renglones del desprendible: solo los conceptos con valor. Mismo orden que la pantalla. */
export function renglonesDesprendible(r) {
  const d = r.devengados;
  const devengados = [['Sueldo', `${r.diasTrabajados} días`, d.sueldo]];
  if (d.auxilioTransporte) devengados.push(['Auxilio de transporte', '', d.auxilioTransporte]);
  for (const h of d.horas) devengados.push([TIPOS_HORA[h.tipo]?.nombre ?? 'Horas', `${h.cantidad} h · ${h.porcentaje} %`, h.valor]);
  if (d.comisiones) devengados.push(['Comisiones', '', d.comisiones]);
  if (d.bonificacion) devengados.push(['Bonificación', '', d.bonificacion]);
  for (const v of d.vacaciones) devengados.push([v.codigo === 2 ? 'Vacaciones compensadas' : 'Vacaciones', `${v.dias} días`, v.valor]);
  for (const l of d.licencias) devengados.push([TIPOS_LICENCIA[l.tipo]?.nombre ?? 'Licencia', `${l.dias} días`, l.valor]);
  for (const i of d.incapacidades) devengados.push(['Incapacidad', `${i.dias} días`, i.valor]);
  if (d.prima) devengados.push(['Prima de servicios', `${d.prima.dias} días`, d.prima.valor]);
  if (d.cesantias) {
    devengados.push(['Cesantías', `${d.cesantias.dias} días`, d.cesantias.valor]);
    devengados.push(['Intereses a las cesantías', `${d.cesantias.porcentajeIntereses} %`, d.cesantias.intereses]);
  }
  // `?? []`: las liquidaciones guardadas antes del 8-oct-2026 no traen estas listas.
  for (const o of d.otros ?? []) devengados.push([o.descripcion || OTROS_DEVENGADOS[o.tipo]?.nombre || 'Otro pago', o.descripcion ? OTROS_DEVENGADOS[o.tipo]?.nombre ?? '' : (o.salarial ? '' : 'no salarial'), o.valor]);
  const x = r.deducciones;
  const deducciones = [['Salud', `${x.salud.porcentaje} %`, x.salud.valor], ['Pensión', `${x.pension.porcentaje} %`, x.pension.valor]];
  if (x.fondoSolidaridad) deducciones.push(['Fondo de solidaridad pensional', `${x.fondoSolidaridad.porcentaje} %`, x.fondoSolidaridad.valor]);
  for (const o of x.otras ?? []) deducciones.push([OTRAS_DEDUCCIONES[o.tipo]?.nombre ?? 'Otra deducción', o.descripcion ?? '', o.valor]);
  return { devengados, deducciones };
}

/** Devuelve { nombre, buffer } del desprendible de una liquidación. */
export async function pdfDesprendible(liquidacionId) {
  const liq = await obtenerLiquidacion(liquidacionId);
  const emp = await obtenerEmpleado(liq.empleado_id);
  const e = (await pool.query(`SELECT razon_social, nit, dv FROM sst.emisor WHERE id = 1`)).rows[0];
  // Sin empresa emisora parametrizada se usa la razón social de siempre (como el paquete de la ARL).
  const empresa = e
    ? { nombre: e.razon_social, nit: `${Number(e.nit).toLocaleString('es-CO')}-${e.dv}` }
    : { nombre: 'JD&D CONSULTORES EN SISTEMAS DE GESTIÓN SAS', nit: '901.203.812-4' };

  const pdf = await PDFDocument.create();
  const [n, b] = await Promise.all([pdf.embedFont(StandardFonts.Helvetica), pdf.embedFont(StandardFonts.HelveticaBold)]);
  const p = pdf.addPage([W, H]);
  const texto = (t, x, arriba, { f = n, s = 9, c = NEGRO } = {}) => p.drawText(winAnsi(t), { x, y: H - arriba, size: s, font: f, color: c });
  const ancho = (t, { f = n, s = 9 } = {}) => f.widthOfTextAtSize(winAnsi(t), s);
  const derecha = (t, xDer, arriba, o = {}) => texto(t, xDer - ancho(t, o), arriba, o);
  const hor = (x1, x2, arriba, color = LINEA, grosor = 0.8) => p.drawLine({ start: { x: x1, y: H - arriba }, end: { x: x2, y: H - arriba }, thickness: grosor, color });
  const [IZQ, DER] = [48, W - 48];

  // ── Marca de agua mientras no esté en firme
  const marca = liq.estado === 'ANULADO' ? 'ANULADA' : liq.estado === 'VALIDADO' ? null : 'BORRADOR';
  if (marca) p.drawText(marca, { x: 120, y: 250, size: 92, font: b, color: rgb(0.93, 0.93, 0.95), rotate: degrees(38) });

  // ── Cabecera
  if (fs.existsSync(LOGO)) {
    const logo = await pdf.embedJpg(new Uint8Array(fs.readFileSync(LOGO)));
    const wLogo = 104;
    p.drawImage(logo, { x: IZQ, y: H - 48 - wLogo * (logo.height / logo.width), width: wLogo, height: wLogo * (logo.height / logo.width) });
  }
  derecha('Comprobante de pago de nómina', DER, 62, { f: b, s: 14, c: AZUL });
  derecha(`${MESES[liq.mes - 1]} de ${liq.anio}`, DER, 80, { s: 11, c: AZUL });
  derecha(liq.numero ? `Nómina electrónica ${liq.numero}` : 'Sin emitir ante la DIAN', DER, 95, { s: 8.5, c: GRIS });
  texto(empresa.nombre, IZQ, 138, { f: b, s: 9.5 });
  texto(`NIT ${empresa.nit}`, IZQ, 151, { s: 8.5, c: GRIS });
  hor(IZQ, DER, 162, AZUL, 1.4);

  // ── Datos del empleado, en dos columnas
  const dato = (rotulo, valor, x, arriba) => { texto(rotulo, x, arriba, { s: 7.5, c: GRIS }); texto(valor || '-', x, arriba + 12, { f: b, s: 9.5 }); };
  const col2 = IZQ + 270;
  dato('Empleado', emp.nombre, IZQ, 180);
  dato(emp.tipo_documento_nombre || 'Documento', emp.numero_documento, col2, 180);
  dato('Cargo', emp.cargo, IZQ, 212);
  dato('Salario básico', `${pesos(liq.salario)}${liq.salario_integral ? ' (integral)' : ''}`, col2, 212);
  dato('Días laborados', String(Number(liq.dias_trabajados)), IZQ, 244);
  dato('Fecha de pago', fechaCO(liq.fecha_pago), col2, 244);
  dato('Forma de pago', emp.metodo_pago === '10' ? 'Efectivo' : `${emp.metodo_pago === '42' ? 'Consignación' : 'Transferencia'} · ${emp.banco ?? ''} ${emp.numero_cuenta ? `· cuenta terminada en ${String(emp.numero_cuenta).slice(-4)}` : ''}`, IZQ, 276);

  // ── Devengados y deducciones, lado a lado
  const { devengados, deducciones } = renglonesDesprendible(liq.liquidacion);
  const medio = (IZQ + DER) / 2;
  const tabla = (titulo, filas, total, rotuloTotal, x1, x2) => {
    let y = 322;
    p.drawRectangle({ x: x1, y: H - y - 6, width: x2 - x1, height: 18, color: AZUL });
    texto(titulo, x1 + 6, y, { f: b, s: 8.5, c: rgb(1, 1, 1) });
    derecha('Valor', x2 - 6, y, { f: b, s: 8.5, c: rgb(1, 1, 1) });
    y += 22;
    for (const [concepto, detalle, valor] of filas) {
      texto(concepto, x1 + 6, y, { s: 8.5 });
      if (detalle) texto(detalle, x1 + 6, y + 9.5, { s: 7, c: GRIS });
      derecha(pesos(valor), x2 - 6, y, { s: 8.5 });
      y += detalle ? 23 : 16;
      hor(x1, x2, y - 9);
    }
    return { y, pintarTotal: (yTotal) => { texto(rotuloTotal, x1 + 6, yTotal, { f: b, s: 9 }); derecha(pesos(total), x2 - 6, yTotal, { f: b, s: 9 }); } };
  };
  const t = liq.liquidacion.totales;
  const a = tabla('DEVENGADOS', devengados, t.devengado, 'Total devengado', IZQ, medio - 8);
  const c = tabla('DEDUCCIONES', deducciones, t.deducido, 'Total deducciones', medio + 8, DER);
  const yTotales = Math.max(a.y, c.y) + 6;
  a.pintarTotal(yTotales);
  c.pintarTotal(yTotales);

  // ── Neto
  const yNeto = yTotales + 22;
  p.drawRectangle({ x: IZQ, y: H - yNeto - 22, width: DER - IZQ, height: 34, color: AZUL });
  texto('NETO A PAGAR', IZQ + 12, yNeto + 9, { f: b, s: 10.5, c: rgb(1, 1, 1) });
  derecha(pesos(t.neto), DER - 12, yNeto + 10, { f: b, s: 14, c: rgb(1, 1, 1) });
  texto(`Base de cotización a salud y pensión: ${pesos(liq.liquidacion.ibc)}`, IZQ, yNeto + 40, { s: 7.5, c: GRIS });
  if (liq.observaciones) texto(`Observaciones: ${String(liq.observaciones).slice(0, 110)}`, IZQ, yNeto + 52, { s: 7.5, c: GRIS });

  // ── Pie: validación de la DIAN y firma de recibido
  if (liq.cune) {
    if (liq.qr_url) {
      const qr = await pdf.embedPng(await QRCode.toBuffer(liq.qr_url, { margin: 0, width: 300, errorCorrectionLevel: 'M' }));
      p.drawImage(qr, { x: IZQ, y: 70, width: 74, height: 74 });
    }
    const xT = liq.qr_url ? IZQ + 86 : IZQ;
    texto(liq.estado === 'ANULADO' ? `Nómina anulada con la nota de ajuste ${liq.nota_numero ?? ''}` : 'Documento soporte de pago de nómina electrónica validado por la DIAN', xT, H - 132, { f: b, s: 8 });
    texto('CUNE', xT, H - 118, { s: 7, c: GRIS });
    // El CUNE son 96 caracteres: va en dos renglones para no salirse de la hoja.
    texto(liq.cune.slice(0, 48), xT, H - 107, { s: 7 });
    texto(liq.cune.slice(48), xT, H - 97, { s: 7 });
  }
  hor(DER - 190, DER, H - 96, NEGRO, 0.7);
  derecha('Recibí conforme', DER, H - 84, { s: 8, c: GRIS });
  derecha(`${winAnsi(emp.nombre)} · ${emp.numero_documento}`, DER, H - 73, { s: 7.5, c: GRIS });
  texto('Generado por ORBITA', IZQ, H - 40, { s: 6.5, c: GRIS });

  const archivo = `nomina-${liq.anio}-${String(liq.mes).padStart(2, '0')}-${emp.numero_documento}.pdf`;
  return { nombre: archivo, buffer: Buffer.from(await pdf.save()) };
}
