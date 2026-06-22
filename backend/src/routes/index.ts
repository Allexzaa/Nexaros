import { Express, Router } from 'express';
import healthRouter from './health';
import bootstrapRouter from './internal/bootstrap';
import devSimulateRouter from './internal/devSimulate';
import authRouter from './api/auth';
import authGoogleRouter from './api/authGoogle';
import authInviteResetRouter from './api/authInviteReset';
import staffRouter from './api/staff';
import schedulesRouter from './api/schedules';
import conversationsRouter from './api/conversations';
import businessRouter from './api/business';
import clientAuthRouter from './api/clientAuth';
import clientsRouter from './api/clients';
import portalRouter from './api/portal';

const apiV1 = Router();
apiV1.use(authRouter);
apiV1.use(authGoogleRouter);
apiV1.use(authInviteResetRouter);
apiV1.use(staffRouter);
apiV1.use(schedulesRouter);
apiV1.use(conversationsRouter);
apiV1.use(businessRouter);
apiV1.use(clientAuthRouter);
apiV1.use(clientsRouter);
apiV1.use(portalRouter);

export function registerRoutes(app: Express): void {
  app.use(healthRouter);
  app.use(bootstrapRouter);
  app.use(devSimulateRouter);
  app.use('/api/v1', apiV1);
}
