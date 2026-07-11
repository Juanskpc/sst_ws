import { Router } from 'express';
import {
  ImportOrderController,
  type ImportOrderControllerDeps,
} from './import-order.controller.js';
import { middlewareSubida } from './upload.middleware.js';
import { asyncHandler } from './error-handler.middleware.js';

/**
 * Crea el router de importación. Montar en `/api/orders` para obtener la ruta
 * final `POST /api/orders/import`. El campo del formulario es `file`.
 */
export function crearRutasImportacion(deps: ImportOrderControllerDeps): Router {
  const router = Router();
  const controller = new ImportOrderController(deps);
  router.post('/import', middlewareSubida('file'), asyncHandler(controller.importar));
  return router;
}
