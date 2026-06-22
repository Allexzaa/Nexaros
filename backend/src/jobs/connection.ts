import IORedis from 'ioredis';
import { env } from '../config/env';

// maxRetriesPerRequest: null is required by BullMQ
export const redisConnection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

redisConnection.on('error', (err) => console.error('Redis error:', err.message));
