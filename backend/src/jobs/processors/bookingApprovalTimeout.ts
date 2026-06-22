import { Job } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';
import { BookingApprovalTimeoutData } from '../types';
import { db } from '../../db';
import { stateEngine } from '../../ai/stateEngine';
import { findBestSlot } from '../../services/slotManager';
import { emitNewMessage } from '../../realtime/emitters';
import { TransitionExtras } from '../../ai/types';
import { MessageRecord } from '../../realtime/types';

interface ConvRow { state: string; business_id: string; appointment_id: string; client_id: string }

export async function processBookingApprovalTimeout(job: Job<BookingApprovalTimeoutData>): Promise<void> {
  const { conversationId } = job.data;

  const convResult = await db.query<ConvRow>(
    `SELECT state, business_id, appointment_id, client_id FROM conversation WHERE id = $1`,
    [conversationId],
  );
  if (!convResult.rows[0] || convResult.rows[0].state !== 'awaiting_approval') return;

  const { business_id, appointment_id, client_id } = convResult.rows[0];

  const slot = await findBestSlot(business_id, '', appointment_id);

  const extras: TransitionExtras = {};
  let responseText: string;

  if (slot) {
    const slotDate = new Intl.DateTimeFormat('en-US', {
      weekday: 'long', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date(slot.starts_at));
    const serviceLabel = slot.service_type ? `your ${slot.service_type}` : 'an appointment';
    responseText =
      `Unfortunately the office wasn't able to respond in time. I found ${serviceLabel} on ${slotDate} — would that work for you?`;
    extras.targetState = 'slot_offered';
    extras.offeredSlotId = slot.id;
  } else {
    responseText =
      "Unfortunately the office wasn't able to respond in time, and there are no available slots right now. I've added you to the waitlist.";
    extras.targetState = 'waitlisted';
  }

  await stateEngine.applyTransition(conversationId, 'approval_timeout', extras);

  if (extras.targetState === 'waitlisted') {
    await db.query(
      `INSERT INTO waitlist_entry (id, client_id, business_id, preferences) VALUES ($1, $2, $3, $4)`,
      [uuidv4(), client_id, business_id, ''],
    );
  }

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
  emitNewMessage(business_id, client_id, conversationId, messageRecord);
}
