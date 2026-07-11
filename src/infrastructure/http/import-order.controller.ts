import type { Request, Response } from 'express';
import { ImportOrderUseCase } from '../../application/use-cases/import-order.usecase.js';
import type { TextExtractorPort } from '../../application/ports/text-extractor.port.js';
import type { DocumentExtractorPort } from '../../application/ports/document-extractor.port.js';
import type { UmbralConfianzaProvider } from '../../application/ports/umbral-confianza.provider.js';
import { type LoggerPort, silentLogger } from '../../application/ports/logger.port.js';
import { InMemoryFileStorage } from '../storage/in-memory-file-storage.js';
import { responderError, responderExito, STATUS_POR_CODIGO } from './http-response.js';

/** Colaboradores compartidos (singletons) que inyecta el composition root. */
export interface ImportOrderControllerDeps {
  readonly extractores: readonly TextExtractorPort[];
  readonly documentExtractor: DocumentExtractorPort;
  readonly umbralConfianza: UmbralConfianzaProvider;
  readonly logger?: LoggerPort;
}

/**
 * Controlador HTTP del endpoint de importación. Traduce la petición multipart al
 * comando del caso de uso y el `Resultado` a JSON. No contiene lógica de negocio
 * ni conoce OpenAI/extractores por dentro: solo orquesta el borde.
 */
export class ImportOrderController {
  private readonly logger: LoggerPort;

  constructor(private readonly deps: ImportOrderControllerDeps) {
    this.logger = deps.logger ?? silentLogger;
  }

  /** POST /api/orders/import — recibe el archivo y devuelve la vista previa. */
  importar = async (req: Request, res: Response): Promise<void> => {
    const archivo = req.file;
    if (archivo === undefined) {
      responderError(res, 400, 'ARCHIVO_REQUERIDO', 'Debe adjuntar un archivo en el campo "file".');
      return;
    }

    // El buffer subido se expone al caso de uso vía el puerto de almacenamiento,
    // en memoria: NO se persiste en disco/S3/BD (endpoint de solo vista previa).
    const REFERENCIA = 'upload';
    const storage = new InMemoryFileStorage();
    storage.guardar(REFERENCIA, new Uint8Array(archivo.buffer));

    const useCase = new ImportOrderUseCase({
      storage,
      extractores: this.deps.extractores,
      documentExtractor: this.deps.documentExtractor,
      umbralConfianza: this.deps.umbralConfianza,
      logger: this.logger,
    });

    const resultado = await useCase.ejecutar({
      referenciaArchivo: REFERENCIA,
      nombreArchivo: archivo.originalname,
      tipoMime: archivo.mimetype,
    });

    if (!resultado.ok) {
      const status = STATUS_POR_CODIGO[resultado.error.codigo] ?? 500;
      responderError(res, status, resultado.error.codigo, resultado.error.message, resultado.error.detalles);
      return;
    }

    responderExito(res, resultado.valor);
  };
}
