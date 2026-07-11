import type { OrdenServicio } from '../../domain/entities/orden-servicio.entity.js';
import type { IdentidadOrden } from '../../domain/value-objects/identidad-orden.vo.js';
import type { OrdenServicioId } from '../../domain/shared/identifiers.js';

/**
 * Puerto de persistencia de Órdenes de Servicio. Contrato que la infraestructura
 * (Prisma) implementa. No expone tipos de Prisma ni SQL: habla en dominio.
 *
 * Nota: la REGLA de rechazar duplicados es del caso de uso; aquí solo se ofrece
 * la CONSULTA de existencia (acceso a datos, no decisión de negocio).
 */
export interface OrderRepositoryPort {
  /** ¿Existe ya una OS con esta identidad (ARL + cronograma + secuencia)? */
  existePorIdentidad(identidad: IdentidadOrden): Promise<boolean>;

  /** Inserta o actualiza la OS (por id). */
  guardar(orden: OrdenServicio): Promise<void>;

  /** Recupera una OS por id, o `null` si no existe. */
  obtenerPorId(id: OrdenServicioId): Promise<OrdenServicio | null>;
}
