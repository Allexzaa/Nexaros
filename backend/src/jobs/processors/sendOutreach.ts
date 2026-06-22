import { Job } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';
import { SendOutreachData } from '../types';
import { db } from '../../db';
import { stateEngine } from '../../ai/stateEngine';
import { scheduleFollowup, scheduleDeadlineCheck } from '../scheduler';
import { emitNewMessage } from '../../realtime/emitters';
import { MessageRecord } from '../../realtime/types';

const DEFAULT_RESPONSE_WINDOW_HOURS = 24;

export async function processSendOutreach(job: Job<SendOutreachData>): Promise<void> {
  const { appointmentId } = job.data;

  const result = await db.query<{
    conversation_id: string;
    client_id: string;
    business_id: string;
    starts_at: Date;
    service_type: string | null;
    client_name: string;
    timezone: string;
    business_settings: Record<string, unknown> | null;
  }>(
    `SELECT c.id AS conversation_id, c.client_id, c.business_id,
            a.starts_at, a.service_type,
            cl.name AS client_name,
            b.timezone, b.settings AS business_settings
     FROM conversation c
     JOIN appointment a ON a.id = c.appointment_id
     JOIN client cl ON cl.id = c.client_id
     JOIN business b ON b.id = c.business_id
     WHERE c.appointment_id = $1`,
    [appointmentId],
  );

  if (!result.rows.length) {
    console.warn(`[send-outreach] No conversation for appointmentId=${appointmentId}`);
    return;
  }

  const { conversation_id, client_id, business_id, starts_at, service_type, client_name, timezone, business_settings } = result.rows[0];

  await stateEngine.applyTransition(conversation_id, 'outreach_triggered');
  await db.query(`UPDATE appointment SET status = 'ai-active' WHERE id = $1`, [appointmentId]);

  const appointmentDate = new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: timezone || 'UTC',
  }).format(new Date(starts_at));

  const cleanService = service_type?.replace(/\bappointment\b/gi, '').trim() || null;
  const serviceLabel = cleanService ? `your ${cleanService} appointment` : 'your appointment';
  const messageContent =
    `Hi ${client_name}! I'm reaching out about ${serviceLabel} scheduled for ${appointmentDate}. ` +
    `Please reply to confirm — it only takes a moment.`;

  console.log(`[Outreach] → client="${client_name}" appt="${appointmentDate}" service="${cleanService ?? 'none'}"`);
  console.log(`[Outreach]   message: "${messageContent}"`);

  const msgResult = await db.query<{ id: string; timestamp: Date }>(
    `INSERT INTO message (id, conversation_id, sender, content) VALUES ($1, $2, 'ai', $3) RETURNING id, timestamp`,
    [uuidv4(), conversation_id, messageContent],
  );
  const msgRow = msgResult.rows[0];

  const messageRecord: MessageRecord = {
    id: msgRow.id,
    sender: 'ai',
    content: messageContent,
    timestamp: msgRow.timestamp.toISOString(),
  };
  emitNewMessage(business_id, client_id, conversation_id, messageRecord);

  const windowHours = (business_settings?.outreach_response_window_hours as number) ?? DEFAULT_RESPONSE_WINDOW_HOURS;
  const windowMs = windowHours * 3600000;

  await scheduleFollowup(conversation_id, 1, 5 * 60 * 1000);
  await scheduleFollowup(conversation_id, 2, 65 * 60 * 1000);
  await scheduleFollowup(conversation_id, 3, windowMs - 5 * 60 * 1000);
  await scheduleDeadlineCheck(conversation_id, appointmentId, windowMs);
}
