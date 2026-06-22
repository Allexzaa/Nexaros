import express from 'express';
import cookieParser from 'cookie-parser';
import { corsMiddleware } from './middleware/cors';
import { errorHandler } from './middleware/errorHandler';
import { registerRoutes } from './routes';
import { bullBoardRouter } from './jobs/board';

export function createApp(): express.Express {
  const app = express();

  app.use(corsMiddleware);
  app.options('*', corsMiddleware);
  app.use(express.json());
  app.use(cookieParser());

  // Bull Board — open in dev; restrict to Admin role once F002 auth is built
  app.use('/admin/queues', bullBoardRouter);

  registerRoutes(app);

  app.use(errorHandler);

  return app;
}
