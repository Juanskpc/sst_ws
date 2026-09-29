import { Router } from 'express';
import { authRequired, requireRole } from '../../middleware/auth.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { badRequest } from '../../utils/httpError.js';
import { uploadImport } from '../../middleware/upload.js';
import { extraerPrefactura } from './prefacturas.extraction.js';
import { cruzarFilas, prefacturaExistente, aplicarPrefactura } from './prefacturas.service.js';

const router = Router();
router.use(authRequired);

/**
 * T0-09 · Sube el PDF, lo extrae con IA y devuelve la previsualización cruzada
 * contra Orbita. NO escribe nada en la base de datos: eso solo pasa en
 * `/aplicar`, después de que alguien mire la tabla y decida qué marcar.
 *
 * Reutiliza `uploadImport` (PDF, máx. 4 MB): es el mismo límite que cualquier
 * otro documento que se sube a la plataforma.
 */
router.post('/previsualizar', requireRole('admin', 'contador'), uploadImport.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('Adjunte el PDF de la prefactura en el campo "file".');
    const datos = await extraerPrefactura(req.file.buffer);
    if (!datos.numero_prefactura) {
      throw badRequest('No se pudo leer el número de prefactura en el PDF.');
    }

    const [existente, filasClasificadas] = await Promise.all([
      prefacturaExistente(datos.numero_prefactura),
      cruzarFilas(datos.filas, datos.numero_prefactura),
    ]);

    res.json({
      data: {
        ...datos,
        filas: filasClasificadas,
        nombre_archivo: req.file.originalname,
        // Informativo, no un bloqueo: cargar de nuevo no duplica nada y se puede
        // volver a aplicar (por ejemplo, si la primera vez algunas filas no
        // cruzaron porque la orden todavía no existía en Orbita).
        ya_cargada: existente
          ? { cargada_en: existente.cargada_en, cargada_por: existente.cargada_por_nombre }
          : null,
      },
    });
  }));

/**
 * Aplica la prefactura ya revisada: guarda el encabezado + las filas y marca
 * las filas indicadas (APROBADO + n.º de prefactura), todo en una transacción.
 * El cuerpo es lo mismo que devolvió `/previsualizar` (más `filas_marcadas`),
 * para que el frontend no tenga que reconstruir nada.
 */
router.post('/aplicar', requireRole('admin', 'contador'), asyncHandler(async (req, res) => {
  const {
    numero_prefactura: numeroPrefactura, plan_codigo: planCodigo, plan_descripcion: planDescripcion,
    fecha_corte: fechaCorte, valor_total: valorTotal, nombre_archivo: nombreArchivo,
    filas, filas_marcadas: filasMarcadas,
  } = req.body || {};
  if (!numeroPrefactura) throw badRequest('Falta el número de prefactura.');
  if (!Array.isArray(filas) || !filas.length) throw badRequest('La prefactura no trae filas.');
  if (!Array.isArray(filasMarcadas)) throw badRequest('Indique qué filas se aplican (filas_marcadas).');

  const resultado = await aplicarPrefactura({
    datos: {
      numero_prefactura: numeroPrefactura, plan_codigo: planCodigo, plan_descripcion: planDescripcion,
      fecha_corte: fechaCorte, valor_total: valorTotal, filas,
    },
    filasMarcadas,
    nombreArchivo,
    usuarioId: req.user.sub,
  });

  const n = resultado.aplicadas.length;
  res.json({
    message: n
      ? `${n === 1 ? '1 orden' : `${n} órdenes`} aprobada${n === 1 ? '' : 's'} con la prefactura ${numeroPrefactura}.`
      : 'Prefactura guardada; ninguna fila marcada se pudo aplicar.',
    ...resultado,
  });
}));

export default router;
