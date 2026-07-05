import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { env } from './config/env.js';
import apiRoutes from './routes/index.js';
import { errorHandler } from './middleware/error.js';
import { notFound } from './utils/httpError.js';

export function createApp() {
  const app = express();

  app.use(cors({ origin: env.corsOrigin === '*' ? true : env.corsOrigin.split(','), credentials: true }));
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));
  if (env.nodeEnv !== 'test') app.use(morgan('dev'));

  app.use('/api', apiRoutes);

  // 404 y manejador de errores
  app.use((req, _res, next) => next(notFound(`Ruta no encontrada: ${req.method} ${req.originalUrl}`)));
  app.use(errorHandler);

  return app;
}
