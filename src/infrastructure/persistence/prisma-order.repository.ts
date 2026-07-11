import { Prisma, type PrismaClient } from '@prisma/client';
import type { OrderRepositoryPort } from '../../application/ports/order-repository.port.js';
import type { OrdenServicio } from '../../domain/entities/orden-servicio.entity.js';
import type { IdentidadOrden } from '../../domain/value-objects/identidad-orden.vo.js';
import type { OrdenServicioId } from '../../domain/shared/identifiers.js';
import { aDatosPersistencia, aDominio } from './order.mapper.js';
import { PersistenciaError } from './persistence.error.js';

/**
 * Adaptador Prisma del puerto de repositorio de OS. Solo acceso a datos:
 * ninguna regla de negocio (transiciones, dedup como decisión) ni OpenAI.
 */
export class PrismaOrderRepository implements OrderRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async existePorIdentidad(identidad: IdentidadOrden): Promise<boolean> {
    const encontrada = await this.prisma.order.findFirst({
      where: {
        arlId: identidad.arlId,
        codigoCronograma: identidad.codigoCronograma,
        secuencia: identidad.secuencia,
      },
      select: { id: true },
    });
    return encontrada !== null;
  }

  async guardar(orden: OrdenServicio): Promise<void> {
    const datos = aDatosPersistencia(orden);
    try {
      await this.prisma.order.upsert({
        where: { id: orden.id },
        create: datos,
        update: datos,
      });
    } catch (causa) {
      if (
        causa instanceof Prisma.PrismaClientKnownRequestError &&
        causa.code === 'P2002'
      ) {
        throw new PersistenciaError(
          'Ya existe una orden con la misma identidad (ARL + cronograma + secuencia).',
          causa,
        );
      }
      throw new PersistenciaError('No se pudo guardar la orden de servicio.', causa);
    }
  }

  async obtenerPorId(id: OrdenServicioId): Promise<OrdenServicio | null> {
    const row = await this.prisma.order.findUnique({ where: { id } });
    return row === null ? null : aDominio(row);
  }
}
