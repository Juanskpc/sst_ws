import { ErrorDominio } from '../shared/errors/domain-error.js';
import type { EstadoExtraccion, EstadoOrden } from '../enums/index.js';

/** El archivo subido no es Excel ni PDF, o su MIME no está permitido (IMP-01). */
export class ArchivoNoSoportadoError extends ErrorDominio {
  override readonly codigo = 'ARCHIVO_NO_SOPORTADO';

  constructor(nombreArchivo: string, tipoMime: string | null) {
    super(
      `El archivo "${nombreArchivo}" no es un formato soportado (se esperaba Excel o PDF).`,
      { nombreArchivo, tipoMime },
    );
  }
}

/** No fue posible clasificar la ARL de origen del documento (IMP-05). */
export class ArlNoReconocidaError extends ErrorDominio {
  override readonly codigo = 'ARL_NO_RECONOCIDA';

  constructor(pista: string) {
    super('No se pudo reconocer la ARL de origen del documento.', { pista });
  }
}

/** Ya existe una OS con la misma identidad (ARL + cronograma + secuencia) (IMP-07/09). */
export class OrdenDuplicadaError extends ErrorDominio {
  override readonly codigo = 'ORDEN_DUPLICADA';

  constructor(claveIdentidad: string, ordenExistenteId?: string) {
    super('Ya existe una Orden de Servicio con la misma identidad.', {
      claveIdentidad,
      ordenExistenteId: ordenExistenteId ?? null,
    });
  }
}

/** La extracción con IA falló (timeout, salida inválida, límite de tasa, etc.). */
export class ExtraccionFallidaError extends ErrorDominio {
  override readonly codigo = 'EXTRACCION_FALLIDA';

  constructor(motivo: string, causa?: unknown) {
    super(`La extracción del documento falló: ${motivo}`, {
      motivo,
      causa: causa instanceof Error ? causa.message : causa ?? null,
    });
  }
}

/** No existe el lote de importación referido. */
export class LoteNoEncontradoError extends ErrorDominio {
  override readonly codigo = 'LOTE_NO_ENCONTRADO';

  constructor(loteId: string) {
    super(`No existe el lote de importación ${loteId}.`, { loteId });
  }
}

/** No existe el borrador de extracción referido. */
export class BorradorNoEncontradoError extends ErrorDominio {
  override readonly codigo = 'BORRADOR_NO_ENCONTRADO';

  constructor(borradorId: string) {
    super(`No existe el borrador de extracción ${borradorId}.`, { borradorId });
  }
}

/** Se intentó validar/materializar un borrador que no está PENDIENTE_VALIDACION. */
export class BorradorNoValidableError extends ErrorDominio {
  override readonly codigo = 'BORRADOR_NO_VALIDABLE';

  constructor(estadoActual: EstadoExtraccion) {
    super(
      `El borrador no puede validarse en su estado actual (${estadoActual}).`,
      { estadoActual },
    );
  }
}

/** Transición de estado no permitida por la matriz EST-01. */
export class TransicionInvalidaError extends ErrorDominio {
  override readonly codigo = 'TRANSICION_INVALIDA';

  constructor(desde: EstadoOrden, hacia: EstadoOrden) {
    super(`Transición de estado inválida: ${desde} → ${hacia}.`, {
      desde,
      hacia,
    });
  }
}

/** Falta el motivo obligatorio para la transición (CANCELADA o rechazo de verificación). */
export class MotivoRequeridoError extends ErrorDominio {
  override readonly codigo = 'MOTIVO_REQUERIDO';

  constructor(desde: EstadoOrden, hacia: EstadoOrden) {
    super(`El motivo es obligatorio para la transición ${desde} → ${hacia}.`, {
      desde,
      hacia,
    });
  }
}

/** Se intentó cambiar el estado de una OS ya EJECUTADA (EST-06). */
export class RegresionEjecutadaError extends ErrorDominio {
  override readonly codigo = 'REGRESION_EJECUTADA';

  constructor() {
    super('No se puede cambiar el estado de una OS EJECUTADA (EST-06).');
  }
}
