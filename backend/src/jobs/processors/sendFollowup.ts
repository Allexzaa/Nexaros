import { Job } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';
import { SendFollowupData } from '../types';
import { db } from '../../db';
import { emitNewMessage } from '../../realtime/emitters';
import { MessageRecord } from '../../realtime/types';

const FOLLOWUP_MESSAGES: Record<number, string> = {
  1: "Just a quick reminder — your appointment is coming up soon. Please reply to confirm you're still on.",
  2: "Hi! Checking in about your upcoming appointment. We'd love to hear from you — just reply to confirm.",
  3: "This is your last reminder before we release your slot. Please reply now to keep your appointment.",
};

export async function processSendFollowup(job: Job<SendFollowupData>): Promise<void> {
  const { conversationId, followupCount } = job.data;

  const result = await db.query<{ client_id: string; business_id: string; state: string }>(
    `SELECT client_id, business_id, state FROM conversation WHERE id = $1`,
    [conversationId],
  );

  if (!result.rows.length) {
    console.warn(`[send-followup] Conversation not found: ${conversationId}`);
    return;
  }

  const { client_id, business_id, state } = result.rows[0];

  if (state !== 'awaiting_reply') {
    console.log(`[send-followup] Skipping — conversation ${conversationId} in state: ${state}`);
    return;
  }

  const messageContent = FOLLOWUP_MESSAGES[followupCount] ?? FOLLOWUP_MESSAGES[3];

  const msgResult = await db.query<{ id: string; timestamp: Date }>(
    `INSERT INTO message (id, conversation_id, sender, content) VALUES ($1, $2, 'ai', $3) RETURNING id, timestamp`,
    [uuidv4(), conversationId, messageContent],
  );
  const msgRow = msgResult.rows[0];

  await db.query(`UPDATE conversation SET follow_up_count = $1 WHERE id = $2`, [followupCount, conversationId]);

  const messageRecord: MessageRecord = {
    id: msgRow.id,
    sender: 'ai',
    content: messageContent,
    timestamp: msgRow.timestamp.toISOString(),
  };
  emitNewMessage(business_id, client_id, conversationId, messageRecord);
}
