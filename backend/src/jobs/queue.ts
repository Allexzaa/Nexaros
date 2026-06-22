import { Queue, Worker, Job } from 'bullmq';
import { redisConnection } from './connection';
import { env } from '../config/env';
import { JobType, JobTypeName } from './types';
import { processSendOutreach }           from './processors/sendOutreach';
import { processSendFollowup }           from './processors/sendFollowup';
import { processDeadlineCheck }          from './processors/deadlineCheck';
import { processWaitlistCheck }          from './processors/waitlistCheck';
import { processWaitlistReminder }       from './processors/waitlistReminder';
import { processAutoPickup }             from './processors/autoPickup';
import { processBookingApprovalTimeout } from './processors/bookingApprovalTimeout';

export const aiQueue = new Queue('ai-scheduler', { connection: redisConnection });

const processors: Record<JobTypeName, (job: Job) => Promise<void>> = {
  [JobType.SEND_OUTREACH]:            processSendOutreach,
  [JobType.SEND_FOLLOWUP]:            processSendFollowup,
  [JobType.DEADLINE_CHECK]:           processDeadlineCheck,
  [JobType.WAITLIST_CHECK]:           processWaitlistCheck,
  [JobType.WAITLIST_REMINDER]:        processWaitlistReminder,
  [JobType.AUTO_PICKUP]:              processAutoPickup,
  [JobType.BOOKING_APPROVAL_TIMEOUT]: processBookingApprovalTimeout,
};

export const aiWorker = new Worker(
  'ai-scheduler',
  async (job: Job) => {
    const processor = processors[job.name as JobTypeName];
    if (!processor) {
      console.warn(`No processor registered for job type: ${job.name}`);
      return;
    }
    await processor(job);
  },
  { connection: redisConnection, concurrency: env.BULL_CONCURRENCY },
);

aiWorker.on('completed', (job) => console.log(`Job completed: ${job.name} [${job.id}]`));
aiWorker.on('failed',    (job, err) => console.error(`Job failed: ${job?.name} [${job?.id}]:`, err.message));
