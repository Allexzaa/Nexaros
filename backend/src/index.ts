import { createServer } from 'http';
import { env } from './config/env';
import { createApp } from './app';
import { attachWebSocketServer } from './realtime/server';
import { startJobScheduler } from './jobs';

const app = createApp();
const httpServer = createServer(app);

attachWebSocketServer(httpServer);

httpServer.listen(env.PORT, () => {
  console.log(`Backend running on port ${env.PORT} [${env.NODE_ENV}]`);
  startJobScheduler().catch((err) => console.error('Job scheduler failed to start:', err));
});
