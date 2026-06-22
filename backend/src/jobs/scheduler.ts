import { aiQueue } from './queue';
import {
  JobType,
  jobId,
  SendOutreachData,
  SendFollowupData,
  DeadlineCheckData,
  WaitlistCheckData,
  WaitlistReminderData,
  AutoPickupData,
  BookingApprovalTimeoutData,
} from './types';

export async function scheduleOutreach(appointmentId: string, delayMs = 0): Promise<void> {
  await aiQueue.add(JobType.SEND_OUTREACH, { appointmentId } satisfies SendOutreachData, { delay: delayMs });
}

export async function scheduleFollowup(conversationId: string, followupCount: number, delayMs: number): Promise<void> {
  await aiQueue.add(
    JobType.SEND_FOLLOWUP,
    { conversationId, followupCount } satisfies SendFollowupData,
    { jobId: jobId.followup(conversationId, followupCount), delay: delayMs },
  );
}

export async function scheduleDeadlineCheck(conversationId: string, appointmentId: string, delayMs: number): Promise<void> {
  await aiQueue.add(
    JobType.DEADLINE_CHECK,
    { conversationId, appointmentId } satisfies DeadlineCheckData,
    { jobId: jobId.deadlineCheck(conversationId), delay: delayMs },
  );
}

export async function scheduleWaitlistCheck(slotId: string, businessId: string): Promise<void> {
  await aiQueue.add(JobType.WAITLIST_CHECK, { slotId, businessId } satisfies WaitlistCheckData);
}

export async function scheduleWaitlistReminder(
  conversationId: string,
  slotId: string,
  businessId: string,
  delayMs: number,
): Promise<void> {
  await aiQueue.add(
    JobType.WAITLIST_REMINDER,
    { conversationId, slotId, businessId, final: false } satisfies WaitlistReminderData,
    { jobId: jobId.waitlistReminder(conversationId), delay: delayMs },
  );
}

export async function scheduleWaitlistTimeout(
  conversationId: string,
  slotId: string,
  businessId: string,
  delayMs: number,
): Promise<void> {
  await aiQueue.add(
    JobType.WAITLIST_REMINDER,
    { conversationId, slotId, businessId, final: true } satisfies WaitlistReminderData,
    { jobId: jobId.waitlistTimeout(conversationId), delay: delayMs },
  );
}

export async function scheduleAutoPickup(delayMs: number): Promise<void> {
  await aiQueue.add(JobType.AUTO_PICKUP, {} satisfies AutoPickupData, { delay: delayMs });
}

export async function scheduleBookingApprovalTimeout(conversationId: string, delayMs: number): Promise<void> {
  await aiQueue.add(
    JobType.BOOKING_APPROVAL_TIMEOUT,
    { conversationId } satisfies BookingApprovalTimeoutData,
    { jobId: jobId.bookingApprovalTimeout(conversationId), delay: delayMs },
  );
}

// Cancels all pending follow-up, deadline, waitlist reminder, and approval timeout jobs
// for a conversation. Called immediately when a client responds.
export async function cancelJobsByConversationId(conversationId: string): Promise<void> {
  const ids = [
    jobId.followup(conversationId, 1),
    jobId.followup(conversationId, 2),
    jobId.followup(conversationId, 3),
    jobId.deadlineCheck(conversationId),
    jobId.waitlistReminder(conversationId),
    jobId.waitlistTimeout(conversationId),
    jobId.bookingApprovalTimeout(conversationId),
  ];
  await Promise.all(
    ids.map(async (id) => {
      const job = await aiQueue.getJob(id);
      if (job) await job.remove();
    }),
  );
}
