import { aCentavos, porcentaje, sumar } from '../../utils/dinero.js';

/**
 * A1-04 (adelantado por A1-02) · Cálculo de un documento electrónico: bruto por
 * línea → descuento comercial del pagador → base → IVA → retenciones → total a
 * pagar. Puro (sin BD ni red) para poder probarlo con los casos reales de Siigo
 * sin tocar nada más; A1-04 lo llamará desde el borrador de factura.
 *
 * Todo entra y sale en CENTAVOS enteros (ver `utils/dinero.js`): en JS nunca se
 * suman pesos como float.
 *
 * ## El orden que siguen las facturas reales (§3.4 del plan)
 *
 * Total bruto → Descuento comercial → Subtotal → (IVA) → Retenciones → Total a
 * pagar. El descuento se aplica sobre el BRUTO TOTAL del documento (no línea por
 * línea) y se reparte entre las líneas a prorrata para que cada una tenga su
 * propia base de IVA; la última línea absorbe el céntimo que sobra del reparto
 * (método del mayor resto), para que la suma de las líneas cuadre siempre con
 * el total del documento.
 *
 * ## Qué retención SÍ resta del total a pagar, y cuál no
 *
 * En las facturas reales a las ARL, el **retefuente va restado en la propia
 * factura** ("Valor Impto. Rete." por línea) y el total a pagar es neto de él:
 * así lo hace Siigo y así lo confirman FE-775/FE-781. La **autorretención**
 * (1,1 %) es un impuesto que JD&D se practica A SÍ MISMA — no se lo retiene el
 * cliente — así que se calcula y se informa (va al XML por `withholding_taxes`,
 * §5.4 del plan) pero **no** se descuenta de lo que paga el cliente (§3.5:
 * es un asiento contable propio, 13551816/23657502, no toca el recibo de caja
 * del cliente). El ReteICA queda fuera de este cálculo por completo: se
 * practica AL PAGAR, nunca en la factura (confirmado con Factus, A0-07).
 */

/** Tipos de retención que SÍ se restan del total a pagar de la factura. */
const RETENCIONES_QUE_DESCUENTAN_TOTAL = new Set(['RETEFUENTE', 'RETEIVA']);

/**
 * Reparte `totalCentavos` entre `pesos` (los `bruto` de cada línea, en
 * centavos) a prorrata de su peso, por el método del mayor resto: cada línea
 * recibe el entero por defecto (floor) y las que más resto perdieron se llevan
 * el céntimo sobrante, uno por uno, hasta que la suma cuadra exactamente con
 * `totalCentavos`. Sin esto, repartir centavos línea por línea con un simple
 * `round()` puede dejar la suma un céntimo por encima o por debajo del total.
 */
function repartirProrrata(totalCentavos, pesos) {
  const sumaPesos = pesos.reduce((a, b) => a + b, 0);
  if (sumaPesos === 0) return pesos.map(() => 0);

  const brutos = pesos.map((p) => (totalCentavos * p) / sumaPesos);
  const enteros = brutos.map(Math.floor);
  let faltante = totalCentavos - enteros.reduce((a, b) => a + b, 0);

  // Reparte lo que falta empezando por la línea con mayor resto (la que más se
  // redondeó hacia abajo), para que el reparto sea lo más proporcional posible.
  const ordenPorResto = brutos
    .map((b, i) => ({ i, resto: b - enteros[i] }))
    .sort((a, b) => b.resto - a.resto);
  for (let k = 0; k < ordenPorResto.length && faltante > 0; k++, faltante--) {
    enteros[ordenPorResto[k].i] += 1;
  }
  return enteros;
}

/**
 * @param {object} doc
 * @param {{cantidad: number, valorUnitario: number, ivaPct?: number}[]} doc.items
 *   `valorUnitario` en PESOS (no centavos): así llegan de `tarifas_venta` y de
 *   los formularios. `cantidad` puede traer decimales (horas fraccionadas).
 * @param {number} [doc.descuentoComercialPct] Ej. 2 para el 2 % de AXA.
 * @param {{codigo: string, tipo: 'RETEFUENTE'|'RETEIVA'|'AUTORRETENCION', tarifa: number}[]} [doc.retenciones]
 *   Tarifa en el mismo formato de `sst.retenciones.tarifa` (11 = 11 %, 1.1 = 1,1 %).
 * @returns Todos los importes en CENTAVOS enteros.
 */
export function calcularDocumento({ items, descuentoComercialPct = 0, retenciones = [] }) {
  if (!Array.isArray(items) || items.length === 0) throw new TypeError('calcularDocumento: se necesita al menos un ítem');

  const brutosLinea = items.map((it) => aCentavos(Number(it.cantidad) * Number(it.valorUnitario)));
  const totalBruto = sumar(brutosLinea);
  const totalDescuento = porcentaje(totalBruto, descuentoComercialPct);
  const subtotal = totalBruto - totalDescuento;

  // El descuento se reparte a prorrata del bruto de cada línea, para que
  // `base` de cada línea (con la que se calcula su IVA) sea coherente con el
  // subtotal del documento.
  const descuentosLinea = descuentoComercialPct ? repartirProrrata(totalDescuento, brutosLinea) : brutosLinea.map(() => 0);
  const basesLinea = brutosLinea.map((b, i) => b - descuentosLinea[i]);
  const ivasLinea = basesLinea.map((base, i) => porcentaje(base, Number(items[i].ivaPct) || 0));
  const totalIva = sumar(ivasLinea);

  // La ReteIVA (Estatuto Tributario, art. 437-1) se practica sobre el IVA facturado,
  // no sobre el subtotal: 15 % de un IVA de $190.000 son $28.500. Las demás van sobre
  // el subtotal. Hasta el 9-oct-2026 todas tomaban el subtotal (la ReteIVA salía ~5 veces mayor).
  const detalleRetenciones = retenciones.map((r) => {
    const base = r.tipo === 'RETEIVA' ? totalIva : subtotal;
    const valor = porcentaje(base, Number(r.tarifa));
    return { codigo: r.codigo, tipo: r.tipo, tarifa: Number(r.tarifa), base, valor, reduceTotal: RETENCIONES_QUE_DESCUENTAN_TOTAL.has(r.tipo) };
  });
  const totalRetenciones = sumar(detalleRetenciones.filter((r) => r.reduceTotal).map((r) => r.valor));
  const totalAPagar = subtotal + totalIva - totalRetenciones;

  return {
    items: items.map((it, i) => ({
      cantidad: Number(it.cantidad),
      valorUnitario: Number(it.valorUnitario),
      bruto: brutosLinea[i],
      descuento: descuentosLinea[i],
      base: basesLinea[i],
      ivaPct: Number(it.ivaPct) || 0,
      iva: ivasLinea[i],
      totalLinea: basesLinea[i] + ivasLinea[i],
    })),
    totalBruto,
    totalDescuento,
    subtotal,
    totalIva,
    retenciones: detalleRetenciones,
    totalRetenciones,
    totalAPagar,
  };
}
