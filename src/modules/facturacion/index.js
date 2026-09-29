import { FactusAdaptador } from './adaptadores/factus.adaptador.js';

/**
 * Único punto por el que el resto de Orbita obtiene al proveedor de facturación
 * electrónica. Todo el código depende del contrato de `puerto.js`; solo esta
 * fábrica sabe que hoy el proveedor es Factus (§5.1, principio 2 del plan).
 */
let instancia = null;
export function proveedorFE() {
  instancia ??= new FactusAdaptador();
  return instancia;
}

export { estaConfigurado as proveedorConfigurado, esSandbox as proveedorEsSandbox } from './adaptadores/factus.cliente.js';
