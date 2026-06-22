import { aiQueue, aiWorker } from './queue';
import { JobType } from './types';
import { env } from '../config/env';

const AUTO_PICKUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes default; overridden per-business in processor

export async function startJobScheduler(): Promise<void> {
  // Remove stale repeatable jobs before re-registering (handles interval changes on restart)
  const repeatables = await aiQueue.getRepeatableJobs();
  for (const job of repeatables) {
    if (job.name === JobType.AUTO_PICKUP) await aiQueue.removeRepeatableByKey(job.key);
  }

  await aiQueue.add(
    JobType.AUTO_PICKUP,
    {},
    { repeat: { every: AUTO_PICKUP_INTERVAL_MS } },
  );

  console.log(`Job scheduler started — worker concurrency: ${env.BULL_CONCURRENCY}, auto-pickup every 5 min`);
}

export { aiQueue, aiWorker };
