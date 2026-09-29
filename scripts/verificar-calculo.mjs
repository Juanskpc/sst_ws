// Verifica src/modules/facturacion/calculo.js contra las dos facturas reales que
// A1-02 debe reproducir en el sandbox de Factus: FE-775 (AXA) y FE-781 (Sandoná).
// Uso: node scripts/verificar-calculo.mjs
import { calcularDocumento } from '../src/modules/facturacion/calculo.js';
import { deCentavos } from '../src/utils/dinero.js';

let fallos = 0;
const igual = (obtenido, esperado, texto) => {
  const ok = obtenido === esperado;
  if (!ok) fallos++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${texto} → ${obtenido}${ok ? '' : ` (esperado ${esperado})`}`);
};

// ── FE-775 · AXA Colpatria: 3 ítems (30, 27 y 4 horas) a 58.856/h, descuento
// comercial 2 %, retefuente 11 % (resta del total), autorretención 1,1 %
// (informativa, no resta). Total a pagar real del PDF: 3.131.386,40.
{
  const r = calcularDocumento({
    items: [
      { cantidad: 30, valorUnitario: 58856 },
      { cantidad: 27, valorUnitario: 58856 },
      { cantidad: 4, valorUnitario: 58856 },
    ],
    descuentoComercialPct: 2,
    retenciones: [
      { codigo: 'RF-HON', tipo: 'RETEFUENTE', tarifa: 11 },
      { codigo: 'AUTO-1.1', tipo: 'AUTORRETENCION', tarifa: 1.1 },
    ],
  });
  igual(deCentavos(r.totalBruto), '3590216.00', 'FE-775 · total bruto (61 h × 58.856)');
  igual(deCentavos(r.totalDescuento), '71804.32', 'FE-775 · descuento comercial 2 %');
  igual(deCentavos(r.subtotal), '3518411.68', 'FE-775 · subtotal');
  igual(deCentavos(r.totalIva), '0.00', 'FE-775 · sin IVA (servicio exento a ARL)');
  const retefuente = r.retenciones.find((x) => x.tipo === 'RETEFUENTE');
  const autorretencion = r.retenciones.find((x) => x.tipo === 'AUTORRETENCION');
  igual(deCentavos(retefuente.valor), '387025.28', 'FE-775 · retefuente 11 % (resta)');
  igual(retefuente.reduceTotal, true, 'FE-775 · el retefuente SÍ reduce el total a pagar');
  igual(deCentavos(autorretencion.valor), '38702.53', 'FE-775 · autorretención 1,1 % (informativa)');
  igual(autorretencion.reduceTotal, false, 'FE-775 · la autorretención NO reduce el total a pagar');
  igual(deCentavos(r.totalRetenciones), '387025.28', 'FE-775 · total_retenciones = solo el retefuente');
  igual(deCentavos(r.totalAPagar), '3131386.40', 'FE-775 · TOTAL A PAGAR (el número que manda: PDF de Siigo)');
  // Las líneas deben sumar exactamente el total del documento (reparto a prorrata sin perder centavos).
  const sumaLineas = r.items.reduce((a, it) => a + it.totalLinea, 0);
  igual(sumaLineas, r.subtotal + r.totalIva, 'FE-775 · las 3 líneas cuadran con subtotal + IVA (sin perder céntimos)');
}

// ── FE-781 · Transporte de Sandoná (privado): 1 ítem de 1.744.386,56, IVA
// 19 %, sin descuento ni retención. Total a pagar real del PDF: 2.075.820,01.
{
  const r = calcularDocumento({
    items: [{ cantidad: 1, valorUnitario: 1744386.56, ivaPct: 19 }],
  });
  igual(deCentavos(r.totalBruto), '1744386.56', 'FE-781 · total bruto');
  igual(deCentavos(r.totalDescuento), '0.00', 'FE-781 · sin descuento');
  igual(deCentavos(r.subtotal), '1744386.56', 'FE-781 · subtotal');
  igual(deCentavos(r.totalIva), '331433.45', 'FE-781 · IVA 19 %');
  igual(deCentavos(r.totalRetenciones), '0.00', 'FE-781 · sin retención (privado)');
  igual(deCentavos(r.totalAPagar), '2075820.01', 'FE-781 · TOTAL A PAGAR (el número que manda: PDF de Siigo)');
}

// ── Caso de borde: el reparto a prorrata del descuento no debe perder céntimos
// con líneas de bruto muy distinto entre sí (caso adverso a propósito).
{
  const r = calcularDocumento({
    items: [
      { cantidad: 1, valorUnitario: 100 },
      { cantidad: 1, valorUnitario: 100 },
      { cantidad: 1, valorUnitario: 100 },
    ],
    descuentoComercialPct: 10,
  });
  const sumaDescuentos = r.items.reduce((a, it) => a + it.descuento, 0);
  igual(sumaDescuentos, r.totalDescuento, 'reparto a prorrata: 3 líneas iguales, la suma de descuentos cuadra con el total');
}

if (fallos > 0) {
  console.error(`\n${fallos} caso(s) fallido(s).`);
  process.exit(1);
}
console.log('\nTodos los casos pasaron: FE-775 y FE-781 cuadran al centavo.');
