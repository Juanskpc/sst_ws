// A1-02 · Prueba de emisión de factura contra el SANDBOX de Factus.
//
// Reproduce las dos facturas reales que la ficha pide reproducir al centavo:
//   FE-775 (AXA Colpatria): 3 ítems de 30, 27 y 4 horas a 58.856, descuento
//     comercial 2 %, retefuente 11 % y autorretención 1,1 % informativas.
//     Total a pagar real (PDF de Siigo): 3.131.386,40.
//   FE-781 (Transporte de Sandoná, privado): 1 ítem de 1.744.386,56, IVA 19 %.
//     Total a pagar real (PDF de Siigo): 2.075.820,01.
//
// El total "que manda" es el de `calculo.js` (nuestra fuente de verdad, ya
// verificada con `verificar-calculo.mjs`); este script solo comprueba si el que
// calcula FACTUS coincide. Si no coincide, lo dice y se detiene — no fuerza el
// número (ver §1.6 del plan: aparece algo que la API no hace como dice la
// ficha → se para y se pregunta, no se improvisa).
//
// Uso: node scripts/factus-probar-factura.mjs
//
// Se niega a correr si FACTUS_URL no es el sandbox (mismo criterio que
// factus-humo.mjs). Las respuestas del sandbox se guardan SOLO en el
// scratchpad de la sesión, nunca en el repo (instrucción del lote 4).
import fs from 'node:fs';
import path from 'node:path';
import { pool } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { calcularDocumento } from '../src/modules/facturacion/calculo.js';
import { deCentavos } from '../src/utils/dinero.js';
import { esSandbox, estaConfigurado } from '../src/modules/facturacion/adaptadores/factus.cliente.js';
import { proveedorFE } from '../src/modules/facturacion/index.js';

const CARPETA_SALIDA = process.argv[2] || null; // p. ej. el scratchpad; si no se da, no se guarda en disco

async function terceroPorDocumento(numeroDocumento) {
  const r = await pool.query(
    `SELECT t.numero_documento, t.dv, t.razon_social, t.direccion, t.correo_facturacion, t.telefono,
            m.codigo_dian AS municipio_dane
       FROM sst.terceros t LEFT JOIN sst.municipios m ON m.id = t.municipio_id
      WHERE t.numero_documento = $1`,
    [numeroDocumento],
  );
  if (!r.rows[0]) throw new Error(`No existe el tercero con documento ${numeroDocumento} en jdd_dev (¿corrió sembrar-terceros.mjs?).`);
  return r.rows[0];
}

async function rangoFactura() {
  const r = await pool.query(`SELECT factus_rango_id FROM sst.resoluciones_numeracion WHERE tipo_documento = 'FACTURA' AND activa LIMIT 1`);
  return r.rows[0] ? Number(r.rows[0].factus_rango_id) : undefined;
}

function guardar(nombre, contenido) {
  if (!CARPETA_SALIDA) return null;
  fs.mkdirSync(CARPETA_SALIDA, { recursive: true });
  const destino = path.join(CARPETA_SALIDA, nombre);
  fs.writeFileSync(destino, typeof contenido === 'string' ? contenido : JSON.stringify(contenido, null, 2));
  return destino;
}

/**
 * Compara DOS números contra lo que devuelve Factus:
 *  - el total BRUTO (subtotal + IVA) — es lo que Factus exige en payment_details
 *    y lo que debe devolver validado, al centavo.
 *  - nuestro "total a pagar" NETO de calculo.js (el que imprime Siigo) — se
 *    informa aparte, a título de registro: Factus NUNCA lo devuelve porque no
 *    resta el retefuente (ver el hallazgo de más arriba). No es un fallo si
 *    difieren en exactamente el retefuente: es el comportamiento esperado.
 */
function compararTotales(nombre, calculoNuestro, totalesFactus) {
  const bruto = deCentavos(calculoNuestro.subtotal + calculoNuestro.totalIva);
  const neto = deCentavos(calculoNuestro.totalAPagar);
  const factus = totalesFactus.total;
  const cuadraBruto = factus != null && Number(factus).toFixed(2) === Number(bruto).toFixed(2);
  console.log(`  Nuestro total BRUTO (subtotal + IVA):  ${bruto}  ← esto es lo que Factus valida`);
  console.log(`  Nuestro total NETO (total a pagar real, con retefuente restado): ${neto}  ← lo que imprime Siigo, Factus no lo maneja`);
  console.log(`  Total que devuelve Factus:             ${factus ?? '(sin dato)'}`);
  console.log(`  Subtotal Factus: ${totalesFactus.subtotal ?? '—'} · IVA Factus: ${totalesFactus.totalIva ?? '—'} · bruto Factus: ${totalesFactus.totalBruto ?? '—'}`);
  if (cuadraBruto) {
    console.log(`  ✓ ${nombre}: el BRUTO cuadra al centavo con Factus (Factus no resta el retefuente; el neto de Siigo es solo para nuestras cuentas, Fase B).`);
  } else {
    console.log(`  ⚠ ${nombre}: NI SIQUIERA el bruto cuadra con Factus. Diferencia: ${(Number(factus || 0) - Number(bruto)).toFixed(2)}.`);
    console.log('    (No se fuerza el número: revisar redondeo del descuento por línea u otro efecto no visto todavía.)');
  }
  return cuadraBruto;
}

async function emitirYVerificar({ nombre, referenceCode, tercero, tipoPersona, items, descuentoComercialPct, retenciones }) {
  console.log(`\n=== ${nombre} (${referenceCode}) ===`);
  const calculo = calcularDocumento({ items, descuentoComercialPct, retenciones });
  console.log(`  Ítems: ${items.length} · total bruto ${deCentavos(calculo.totalBruto)} · descuento ${deCentavos(calculo.totalDescuento)} · subtotal ${deCentavos(calculo.subtotal)} · IVA ${deCentavos(calculo.totalIva)}`);

  // ⚠️ HALLAZGO (27-sep-2026, confirmado en sandbox): Factus exige que
  // `payment_details.amount` sea su total BRUTO (subtotal + IVA), SIN restar el
  // retefuente — lo probé primero con nuestro "total a pagar" neto (el que
  // imprime Siigo, 3.131.386,40) y Factus lo rechazó: "La suma de todos los
  // detalles de pago no es igual al total de la factura. Esperado: 3.518.411,68".
  // Es coherente con la contabilización real (§3.5 del plan): la cuenta 13050501
  // (cliente) se debita por el NETO, pero eso es un asiento de Fase B, posterior
  // a la factura — la factura DIAN/Factus es siempre bruta. No se fuerza el
  // número neto: se manda el que Factus exige y se compara aparte.
  const montoParaFactus = deCentavos(calculo.subtotal + calculo.totalIva);
  const numberingRangeId = await rangoFactura();
  const resultado = await proveedorFE().emitirFactura({
    referenceCode,
    receptor: {
      nit: tercero.numero_documento,
      dv: tercero.dv,
      tipoDocumentoIdentidad: '31',
      tipoPersona,
      razonSocial: tercero.razon_social,
      direccion: tercero.direccion || 'Sin dirección registrada',
      municipioDane: tercero.municipio_dane || '11001',
      email: tercero.correo_facturacion || 'facturacion.prueba@jddconsultores.test',
      telefono: tercero.telefono || undefined,
      tributoCodigo: 'ZZ',
    },
    items: items.map((it) => ({ descripcion: it.descripcion, cantidad: it.cantidad, valorUnitario: it.valorUnitario, unidadMedidaCodigo: it.unidadMedidaCodigo, tarifaIva: it.ivaPct })),
    descuentoComercialPct,
    // Solo el RETEFUENTE se informa a Factus: la autorretención es un tributo que
    // JD&D se practica A SÍ MISMA (nunca al cliente) y NO va en la factura del
    // cliente (§3.5 del plan). Confirmado además en sandbox (27-sep-2026): Factus
    // rechaza dos withholding_taxes con el MISMO código (05/06) en un ítem, y
    // retefuente + autorretención comparten el código 06 de Factus.
    retenciones: retenciones.filter((r) => r.tipo === 'RETEFUENTE' || r.tipo === 'RETEIVA').map((r) => ({ codigoFactus: '06', tarifa: r.tarifa })),
    numberingRangeId,
    formaPagoCodigo: '2',
    medioPagoCodigo: 'ZZZ',
    montoAPagar: montoParaFactus,
    observacion: `Prueba A1-02 (sandbox, no es un documento real) — ${nombre}`,
    enviarCorreo: false,
  });

  guardar(`${referenceCode}.json`, resultado.respuestaCruda);
  console.log(`  HTTP validado=${resultado.validado} · número=${resultado.numeroDocumento ?? '(sin asignar)'} · CUFE=${resultado.cufe ?? '—'}`);
  for (const [k, v] of resultado.eventos.avisos) console.log(`    aviso  ${k}: ${v}`);
  for (const [k, v] of resultado.eventos.rechazos) console.log(`    RECHAZO ${k}: ${v}`);

  if (resultado.eventos.rechazos.length) {
    console.log(`  ✗ Rechazada por Factus. Para liberar el reference_code: node scripts/factus-borrar-prueba.mjs ${referenceCode}`);
    return { resultado, calculo, cuadra: false };
  }
  if (!resultado.validado) {
    console.log('  … Sin validar y sin rechazo todavía: la DIAN va lenta. No se reintenta con otro reference_code.');
    return { resultado, calculo, cuadra: null };
  }

  const cuadra = compararTotales(nombre, calculo, resultado.totales);

  if (resultado.numeroDocumento) {
    try {
      const pdf = await proveedorFE().descargarPdf(resultado.numeroDocumento);
      const rutaPdf = guardar(`${resultado.numeroDocumento}.pdf`, Buffer.from(pdf.base64, 'base64'));
      console.log(`  ✓ PDF descargado${rutaPdf ? ` (${rutaPdf})` : ''}`);
    } catch (e) { console.log(`  ✗ No se pudo descargar el PDF: ${e.message}`); }
    try {
      const xml = await proveedorFE().descargarXml(resultado.numeroDocumento);
      const rutaXml = guardar(`${resultado.numeroDocumento}.xml`, Buffer.from(xml.base64, 'base64'));
      console.log(`  ✓ XML descargado${rutaXml ? ` (${rutaXml})` : ''}`);
    } catch (e) { console.log(`  ✗ No se pudo descargar el XML: ${e.message}`); }

    const estado = await proveedorFE().consultarEstado(resultado.numeroDocumento);
    console.log(`  ✓ consultarEstado(${resultado.numeroDocumento}) → ${estado.estado}`);
  }

  return { resultado, calculo, cuadra };
}

async function main() {
  if (!estaConfigurado()) throw new Error('Faltan las variables FACTUS_* en .env');
  if (!esSandbox()) throw new Error(`FACTUS_URL apunta a ${env.factus.url}. Este script solo corre contra el sandbox.`);

  const marca = Date.now();
  const axa = await terceroPorDocumento('860002183');
  const sandona = await terceroPorDocumento('891200297');

  const r775 = await emitirYVerificar({
    nombre: 'FE-775 · AXA Colpatria',
    referenceCode: `ORB-TEST-FE775-${marca}`,
    tercero: axa,
    tipoPersona: 'JURIDICA',
    items: [
      { descripcion: '71-000XXXXXXX CAP SG-SST PROF (30 h)', cantidad: 30, valorUnitario: 58856, unidadMedidaCodigo: 'HUR', ivaPct: 0 },
      { descripcion: '71-000XXXXXXX CAP SG-SST PROF (27 h)', cantidad: 27, valorUnitario: 58856, unidadMedidaCodigo: 'HUR', ivaPct: 0 },
      { descripcion: '71-000XXXXXXX CAP SG-SST PROF (4 h)', cantidad: 4, valorUnitario: 58856, unidadMedidaCodigo: 'HUR', ivaPct: 0 },
    ],
    descuentoComercialPct: 2,
    retenciones: [
      { codigo: 'RF-HON', tipo: 'RETEFUENTE', tarifa: 11 },
      { codigo: 'AUTO-1.1', tipo: 'AUTORRETENCION', tarifa: 1.1 },
    ],
  });

  const r781 = await emitirYVerificar({
    nombre: 'FE-781 · Transporte de Sandoná',
    referenceCode: `ORB-TEST-FE781-${marca}`,
    tercero: sandona,
    tipoPersona: 'JURIDICA',
    items: [{ descripcion: 'Servicio SST del mes (prueba A1-02)', cantidad: 1, valorUnitario: 1744386.56, unidadMedidaCodigo: '94', ivaPct: 19 }],
    descuentoComercialPct: 0,
    retenciones: [],
  });

  console.log('\n=== Resumen ===');
  console.log(`FE-775: ${r775.cuadra === true ? 'CUADRA' : r775.cuadra === false ? 'NO CUADRA' : 'sin validar'}`);
  console.log(`FE-781: ${r781.cuadra === true ? 'CUADRA' : r781.cuadra === false ? 'NO CUADRA' : 'sin validar'}`);
  if (CARPETA_SALIDA) console.log(`\nRespuestas y documentos guardados en: ${CARPETA_SALIDA}`);
}

main()
  .catch((err) => {
    console.error(`\n✗ ${err.mensaje || err.message}`);
    if (err.detalle) console.error(`  detalle: ${JSON.stringify(err.detalle).slice(0, 500)}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
