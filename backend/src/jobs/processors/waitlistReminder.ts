import { Job } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';
import { WaitlistReminderData } from '../types';
import { db } from '../../db';
import { emitNewMessage } from '../../realtime/emitters';
import { scheduleWaitlistCheck } from '../scheduler';
import { MessageRecord } from '../../realtime/types';

export async function processWaitlistReminder(job: Job<WaitlistReminderData>): Promise<void> {
  const { conversationId, slotId, businessId, final } = job.data;

  if (!final) {
    const convResult = await db.query<{ client_id: string; state: string }>(
      `SELECT client_id, state FROM conversation WHERE id = $1`,
      [conversationId],
    );
    if (!convResult.rows[0] || convResult.rows[0].state !== 'slot_offered') return;

    const clientId = convResult.rows[0].client_id;
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    const timeStr = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(expiresAt);

    const responseText = `Just a reminder — this slot is available until ${timeStr}. Would you like to take it?`;

    const msgResult = await db.query<{ id: string; timestamp: Date }>(
      `INSERT INTO message (id, conversation_id, sender, content) VALUES ($1, $2, 'ai', $3) RETURNING id, timestamp`,
      [uuidv4(), conversationId, responseText],
    );

    const messageRecord: MessageRecord = {
      id: msgResult.rows[0].id,
      sender: 'ai',
      content: responseText,
      timestamp: msgResult.rows[0].timestamp.toISOString(),
    };
    emitNewMessage(businessId, clientId, conversationId, messageRecord);
  } else {
    const convResult = await db.query<{ client_id: string }>(
      `SELECT client_id FROM conversation WHERE id = $1`,
      [conversationId],
    );
    if (!convResult.rows[0]) return;

    const clientId = convResult.rows[0].client_id;

    await db.query(
      `UPDATE waitlist_entry SET status = 'expired' WHERE client_id = $1 AND business_id = $2 AND status = 'notified'`,
      [clientId, businessId],
    );

    await scheduleWaitlistCheck(slotId, businessId);
  }
}
