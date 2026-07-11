import { Prisma, $Enums } from '@prisma/client';
import type { Order as OrderRow } from '@prisma/client';

import { OrdenServicio } from '../../domain/entities/orden-servicio.entity.js';
import { IdentidadOrden } from '../../domain/value-objects/identidad-orden.vo.js';
import { Nit } from '../../domain/value-objects/nit.vo.js';
import { HorasAsignadas } from '../../domain/value-objects/horas-asignadas.vo.js';
import { CorreoElectronico } from '../../domain/value-objects/correo-electronico.vo.js';
import { ContactoSst } from '../../domain/value-objects/contacto-sst.vo.js';
import { comoId } from '../../domain/shared/identifiers.js';
import type { EstadoOrden as EstadoOrdenDominio } from '../../domain/enums/estado-orden.enum.js';
import type { MetadatosExtraccion } from '../../domain/dto/metadatos-extraccion.dto.js';
import type { Resultado } from '../../domain/shared/result.js';
import type { ErrorDominio } from '../../domain/shared/errors/domain-error.js';
import { MapeoPersistenciaError } from './persistence.error.js';

/**
 * Mapper OrdenServicio (dominio) ↔ fila `Order` (Prisma). Es traducción/(de)serial-
 * ización PURA: no aplica reglas de negocio, no consulta la BD, no conoce OpenAI.
 * Reconstruir los Value Objects usa sus factorías (única fuente de invariantes);
 * un fallo aquí significa corrupción de datos → MapeoPersistenciaError.
 */

// Traducción entre los nombres del enum Prisma y los valores del dominio.
type EstadoDB = $Enums.EstadoOrden;

const ESTADO_A_DB: Record<EstadoOrdenDominio, EstadoDB> = {
  'SIN PROGRAMAR': 'SIN_PROGRAMAR',
  PROGRAMADA: 'PROGRAMADA',
  'EN VERIFICACIÓN': 'EN_VERIFICACION',
  EJECUTADA: 'EJECUTADA',
  CANCELADA: 'CANCELADA',
};

const ESTADO_A_DOMINIO: Record<EstadoDB, EstadoOrdenDominio> = {
  SIN_PROGRAMAR: 'SIN PROGRAMAR',
  PROGRAMADA: 'PROGRAMADA',
  EN_VERIFICACION: 'EN VERIFICACIÓN',
  EJECUTADA: 'EJECUTADA',
  CANCELADA: 'CANCELADA',
};

function exigir<T>(resultado: Resultado<T, ErrorDominio>, campo: string): T {
  if (resultado.ok) return resultado.valor;
  throw new MapeoPersistenciaError(campo, resultado.error.message);
}

/** Fila de la BD → entidad de dominio. */
export function aDominio(row: OrderRow): OrdenServicio {
  const identidad = exigir(
    IdentidadOrden.crear(comoId<'ArlId'>(row.arlId), row.codigoCronograma, row.secuencia),
    'identidad',
  );
  const nitNic = row.nitNic === null ? null : exigir(Nit.crear(row.nitNic), 'nit_nic');
  const horasAsignadas =
    row.horasAsignadas === null
      ? null
      : exigir(HorasAsignadas.crear(row.horasAsignadas.toNumber()), 'horas_asignadas');
  const correo =
    row.contactoSstCorreo === null
      ? null
      : exigir(CorreoElectronico.crear(row.contactoSstCorreo), 'contacto_sst_correo');
  const contactoSst = ContactoSst.crear({
    nombre: row.contactoSstNombre,
    telefono: row.contactoSstTelefono,
    correo,
  });
  const metadatosExtraccion =
    row.metadatosExtraccion === null
      ? null
      : (row.metadatosExtraccion as unknown as MetadatosExtraccion);

  return OrdenServicio.reconstituir({
    id: comoId<'OrdenServicioId'>(row.id),
    codigo: row.codigo,
    identidad,
    nitNic,
    empresaNombre: row.empresaNombre,
    actividadEconomica: row.actividadEconomica,
    horasAsignadas,
    descripcion: row.descripcion,
    contactoSst,
    estado: ESTADO_A_DOMINIO[row.estado],
    profesionalAsignadoId:
      row.profesionalAsignadoId === null
        ? null
        : comoId<'ProfesionalId'>(row.profesionalAsignadoId),
    fechaProgramada: row.fechaProgramada,
    fechaEjecucion: row.fechaEjecucion,
    loteImportacionId:
      row.loteImportacionId === null
        ? null
        : comoId<'LoteImportacionId'>(row.loteImportacionId),
    urlArchivoOriginal: row.urlArchivoOriginal,
    metadatosExtraccion,
    fechaCarga: row.fechaCarga,
    creadoEn: row.creadoEn,
    actualizadoEn: row.actualizadoEn,
  });
}

/** Entidad de dominio → datos para crear/actualizar en Prisma. */
export function aDatosPersistencia(orden: OrdenServicio): Prisma.OrderCreateInput {
  const p = orden.aPrimitivos();
  return {
    id: p.id,
    codigo: p.codigo,
    arlId: p.identidad.arlId,
    codigoCronograma: p.identidad.codigoCronograma,
    secuencia: p.identidad.secuencia,
    nitNic: p.nitNic?.valor ?? null,
    empresaNombre: p.empresaNombre,
    actividadEconomica: p.actividadEconomica,
    horasAsignadas:
      p.horasAsignadas === null ? null : new Prisma.Decimal(p.horasAsignadas.valor),
    fechaCarga: p.fechaCarga,
    descripcion: p.descripcion,
    contactoSstNombre: p.contactoSst.nombre,
    contactoSstTelefono: p.contactoSst.telefono,
    contactoSstCorreo: p.contactoSst.correo?.valor ?? null,
    estado: ESTADO_A_DB[p.estado],
    profesionalAsignadoId: p.profesionalAsignadoId,
    fechaProgramada: p.fechaProgramada,
    fechaEjecucion: p.fechaEjecucion,
    loteImportacionId: p.loteImportacionId,
    urlArchivoOriginal: p.urlArchivoOriginal,
    metadatosExtraccion:
      p.metadatosExtraccion === null
        ? Prisma.JsonNull
        : (p.metadatosExtraccion as unknown as Prisma.InputJsonValue),
    creadoEn: p.creadoEn,
    actualizadoEn: p.actualizadoEn,
  };
}
