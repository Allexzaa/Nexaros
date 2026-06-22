import { Job } from 'bullmq';
import { DeadlineCheckData } from '../types';
import { db } from '../../db';
import { stateEngine } from '../../ai/stateEngine';
import { scheduleWaitlistCheck } from '../scheduler';
import { emitDeadlineReached } from '../../realtime/emitters';

export async function processDeadlineCheck(job: Job<DeadlineCheckData>): Promise<void> {
  const { conversationId, appointmentId } = job.data;

  const result = await db.query<{
    state: string;
    client_id: string;
    business_id: string;
    client_name: string;
  }>(
    `SELECT c.state, c.client_id, c.business_id, cl.name AS client_name
     FROM conversation c
     JOIN client cl ON cl.id = c.client_id
     WHERE c.id = $1`,
    [conversationId],
  );

  if (!result.rows.length) {
    console.warn(`[deadline-check] Conversation not found: ${conversationId}`);
    return;
  }

  const { state, business_id, client_name } = result.rows[0];

  if (state !== 'awaiting_reply' && state !== 'confirming') {
    console.log(`[deadline-check] Skipping — conversation ${conversationId} in state: ${state}`);
    return;
  }

  await stateEngine.applyTransition(conversationId, 'deadline_reached');
  await db.query(`UPDATE appointment SET status = 'no-response' WHERE id = $1`, [appointmentId]);

  emitDeadlineReached(business_id, conversationId, client_name);
  await scheduleWaitlistCheck(appointmentId, business_id);
}
