import { type Resultado, exito, fallo } from '../../domain/shared/result.js';
import type { ErrorDominio } from '../../domain/shared/errors/domain-error.js';
import {
  ArchivoNoSoportadoError,
  ExtraccionFallidaError,
} from '../../domain/errors/ordenes.errors.js';

import type { FileStoragePort } from '../ports/file-storage.port.js';
import {
  seleccionarExtractor,
  type TextExtractorPort,
} from '../ports/text-extractor.port.js';
import type { DocumentExtractorPort } from '../ports/document-extractor.port.js';
import type { UmbralConfianzaProvider } from '../ports/umbral-confianza.provider.js';
import { type LoggerPort, silentLogger } from '../ports/logger.port.js';
import { calcularVistaPrevia } from '../mappers/vista-previa.mapper.js';
import type {
  ImportOrderCommand,
  ImportOrderResultDTO,
} from '../dto/import-order.dto.js';

/** Umbral de respaldo si `app_settings` no está disponible momentáneamente. */
const UMBRAL_POR_DEFECTO = 70;

/** Dependencias del caso de uso: TODAS son interfaces (Ports & Adapters). */
export interface ImportOrderDeps {
  readonly storage: FileStoragePort;
  readonly extractores: readonly TextExtractorPort[];
  readonly documentExtractor: DocumentExtractorPort;
  readonly umbralConfianza: UmbralConfianzaProvider;
  readonly logger?: LoggerPort;
}

/**
 * ImportOrderUseCase — orquesta la importación de una OS:
 *   1) leer archivo → 2) extraer texto → 3) enviar a OpenAI → 4) validar → 5) DTO.
 *
 * No conoce Express, Angular ni Prisma; depende únicamente de puertos. No persiste
 * (eso es de otro caso de uso): devuelve el DTO de vista previa ya enriquecido.
 * Los fallos esperables se devuelven como `Resultado` fallido, no como excepción.
 */
export class ImportOrderUseCase {
  private readonly storage: FileStoragePort;
  private readonly extractores: readonly TextExtractorPort[];
  private readonly documentExtractor: DocumentExtractorPort;
  private readonly umbralConfianza: UmbralConfianzaProvider;
  private readonly logger: LoggerPort;

  constructor(deps: ImportOrderDeps) {
    this.storage = deps.storage;
    this.extractores = deps.extractores;
    this.documentExtractor = deps.documentExtractor;
    this.umbralConfianza = deps.umbralConfianza;
    this.logger = deps.logger ?? silentLogger;
  }

  async ejecutar(
    comando: ImportOrderCommand,
  ): Promise<Resultado<ImportOrderResultDTO, ErrorDominio>> {
    const { referenciaArchivo, nombreArchivo, tipoMime } = comando;
    this.logger.info('import.inicio', { nombreArchivo, tipoMime });

    // 1) Leer archivo (a través del puerto de almacenamiento).
    let contenido: Uint8Array;
    try {
      contenido = await this.storage.leer(referenciaArchivo);
    } catch (causa) {
      return this.fallar(
        new ExtraccionFallidaError('No se pudo leer el archivo del almacenamiento.', causa),
        nombreArchivo,
      );
    }

    // 2) Extraer texto (extractor según el tipo MIME).
    const extractor = seleccionarExtractor(tipoMime, this.extractores);
    if (extractor === null) {
      return this.fallar(new ArchivoNoSoportadoError(nombreArchivo, tipoMime), nombreArchivo);
    }

    let texto: string;
    try {
      texto = await extractor.extraerTexto(contenido);
    } catch (causa) {
      return this.fallar(
        new ExtraccionFallidaError('No se pudo extraer el texto del documento.', causa),
        nombreArchivo,
      );
    }
    if (texto.trim().length === 0) {
      return this.fallar(
        new ExtraccionFallidaError(
          'El documento no contiene texto extraíble (posible PDF escaneado; requiere OCR).',
        ),
        nombreArchivo,
      );
    }

    // 3) Enviar a OpenAI y 4) validar respuesta (el puerto valida contra el esquema).
    const extraccion = await this.documentExtractor.extraer(texto);
    if (!extraccion.ok) {
      this.logger.warn('import.extraccion_fallida', {
        nombreArchivo,
        motivo: extraccion.error.message,
      });
      return fallo(extraccion.error);
    }

    // 5) Retornar DTO (enriquecido con el umbral configurable).
    const umbral = await this.obtenerUmbral();
    const vista = calcularVistaPrevia(extraccion.data, umbral);
    const dto: ImportOrderResultDTO = {
      nombreArchivo,
      tipoMime,
      requiereRevision: vista.requiereRevision,
      confianzaGeneral: vista.confianzaGeneral,
      campos: vista.campos,
      metadatos: extraccion.data,
      meta: extraccion.meta,
    };

    this.logger.info('import.exito', {
      nombreArchivo,
      requiereRevision: dto.requiereRevision,
      confianzaGeneral: dto.confianzaGeneral,
      tokensRespuesta: dto.meta.tokensRespuesta,
    });
    return exito(dto);
  }

  private async obtenerUmbral(): Promise<number> {
    try {
      return await this.umbralConfianza.obtener();
    } catch (causa) {
      this.logger.warn('import.umbral_por_defecto', {
        causa: causa instanceof Error ? causa.message : causa ?? null,
      });
      return UMBRAL_POR_DEFECTO;
    }
  }

  private fallar(
    error: ErrorDominio,
    nombreArchivo: string,
  ): Resultado<never, ErrorDominio> {
    this.logger.error('import.error', {
      nombreArchivo,
      codigo: error.codigo,
      mensaje: error.message,
    });
    return fallo(error);
  }
}
