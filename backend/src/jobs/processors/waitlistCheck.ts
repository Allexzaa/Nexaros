import { Job } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';
import { WaitlistCheckData } from '../types';
import { db } from '../../db';
import { stateEngine } from '../../ai/stateEngine';
import { llmClient } from '../../ai/llmInstance';
import { emitNewMessage } from '../../realtime/emitters';
import { scheduleWaitlistReminder, scheduleWaitlistTimeout } from '../scheduler';
import { MessageRecord } from '../../realtime/types';

const REMINDER_MS = 25 * 60 * 1000;
const TIMEOUT_MS  = 30 * 60 * 1000;

interface WaitlistEntry { id: string; client_id: string; preferences: string }
interface SlotRow { starts_at: Date; service_type: string | null }
interface ConvRow  { id: string; client_id: string }

export async function processWaitlistCheck(job: Job<WaitlistCheckData>): Promise<void> {
  const { slotId, businessId } = job.data;

  const slotResult = await db.query<SlotRow & { timezone: string }>(
    `SELECT a.starts_at, a.service_type, b.timezone
     FROM appointment a JOIN business b ON b.id = a.business_id
     WHERE a.id = $1`,
    [slotId],
  );
  if (!slotResult.rows[0]) return;
  const slot = slotResult.rows[0];
  const tz = slot.timezone || 'America/Los_Angeles';

  const entriesResult = await db.query<WaitlistEntry>(
    `SELECT id, client_id, preferences FROM waitlist_entry
     WHERE business_id = $1 AND status = 'waiting'
     ORDER BY created_at ASC`,
    [businessId],
  );
  if (!entriesResult.rows.length) return;

  const slotLabel = `${slot.service_type ?? 'Appointment'} on ${new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz,
  }).format(new Date(slot.starts_at))}`;

  for (const entry of entriesResult.rows) {
    const matchedId = await llmClient.rankSlots(entry.preferences, [{ id: slotId, label: slotLabel }]);
    if (!matchedId) continue;

    const convResult = await db.query<ConvRow>(
      `SELECT id, client_id FROM conversation WHERE client_id = $1 AND business_id = $2 AND state = 'waitlisted' LIMIT 1`,
      [entry.client_id, businessId],
    );
    if (!convResult.rows[0]) continue;

    const { id: conversationId, client_id: clientId } = convResult.rows[0];

    await stateEngine.applyTransition(conversationId, 'waitlist_match_found', { offeredSlotId: slotId });

    const slotDate = new Intl.DateTimeFormat('en-US', {
      weekday: 'long', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz,
    }).format(new Date(slot.starts_at));
    const serviceLabel = slot.service_type ? `your ${slot.service_type}` : 'an appointment';
    const responseText =
      `Good news — a slot just opened up: ${serviceLabel} on ${slotDate}. Would you like to take it?`;

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

    await db.query(`UPDATE waitlist_entry SET status = 'notified' WHERE id = $1`, [entry.id]);

    await scheduleWaitlistReminder(conversationId, slotId, businessId, REMINDER_MS);
    await scheduleWaitlistTimeout(conversationId, slotId, businessId, TIMEOUT_MS);

    return;
  }
}
