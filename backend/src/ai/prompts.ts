/**
 * F016 Phase 3 — Persona prompt + business context injection
 *
 * buildSystemPrompt (legacy): still used by messageProcessor.ts (old intent-classifier path).
 * buildAgentSystemPrompt: used by conversationAgent.ts (new tool-calling path).
 * fetchBusinessContext: queries live DB data at call time — services, hours, policy.
 */

import { db } from '../db';

// ── Legacy prompt (messageProcessor.ts / F003 intent-classifier) ──────────────

export interface PromptContext {
  businessName: string;
  state: string;
  appointmentDetails: string;
  availableSlots: string;
  contextSummary?: string | null;
}

export function buildSystemPrompt(ctx: PromptContext): string {
  const summary = ctx.contextSummary
    ? `\nConversation summary (earlier messages):\n${ctx.contextSummary}\n`
    : '';

  const today = new Intl.DateTimeFormat('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  }).format(new Date());

  const reschedulingRules = `
RESCHEDULING RULES (follow strictly):
1. When a client says they cannot make their appointment WITHOUT specifying an alternative, respond by asking what specific date and time works best. Use intent "decline".
   Exception: if the client combines a decline WITH a specific date or time preference in the same message (e.g. "I can't make it, do you have anything May 12th afternoon?"), use intent "reschedule_preference" directly — no need to ask again.
2. Use intent "reschedule_preference" when the client has given a clear preferred date, time, or range — whether stated alone or combined with a decline.
3. When presenting available slots (available_slots provided below), list ALL of them as a numbered list so the client can choose. Ask "Which of these works best for you?" Do NOT pick one and say "this is the only option".
4. When the client selects a specific slot from a numbered list you previously presented (e.g., "I'll take the 11am", "option 2", "the second one"), use intent "slot_accept". Set preferred_date_from = preferred_date_to = the selected date in YYYY-MM-DD format, and extracted_preferences to exactly what they said.

DATE RESOLUTION RULES — always compute real YYYY-MM-DD dates using today's date (${today}).
Extract dates even when the client combines a decline with a preference (e.g. "I can't make it, any time May 12th after 12pm?" → preferred_date_from = preferred_date_to = 2026-05-12, preferred_time_of_day = afternoon).

Specific dates → preferred_date_from = preferred_date_to = that date:
  "May 18", "the 15th", "this Friday" → single day

Relative ranges → compute from/to as actual calendar dates:
  "early next week"  → Monday and Tuesday of next week
  "mid next week"    → Wednesday of next week (from=to=that Wednesday)
  "late next week"   → Thursday and Friday of next week
  "early this week"  → Monday and Tuesday of current week
  "next week"        → Monday through Friday of next week (full week)
  "early next month" → 1st through 7th of next month
  "mid next month"   → 11th through 20th of next month
  "late next month"  → 21st through last day of next month
  "this weekend"     → nearest Saturday and Sunday

No date at all ("any time", "whenever", "I'm flexible") → both null.

TIME-OF-DAY — set preferred_time_of_day to one of: morning | afternoon | evening | any.
Specific times like "after 3pm" or "before noon" are handled by the system — just set the closest bucket and capture the raw preference in extracted_preferences.`;

  return `You are a scheduling assistant for ${ctx.businessName}.
Your only job is to confirm, reschedule, or handle questions about appointments.
Current conversation state: ${ctx.state}
Appointment details: ${ctx.appointmentDetails}
Available alternative slots: ${ctx.availableSlots || 'none'}
Today: ${today}
${summary}${reschedulingRules}

Respond ONLY with valid JSON in this exact shape:
{
  "intent": "confirm | decline | question | reschedule_preference | slot_accept | slot_decline | opt_out | off_topic | ambiguous | human_requested",
  "confidence": <number 0.0-1.0>,
  "response_text": "<message to send to client>",
  "extracted_preferences": "<stated day/time preferences as plain text, or null>",
  "preferred_date_from":   "<YYYY-MM-DD start of date range, or null if truly open-ended>",
  "preferred_date_to":     "<YYYY-MM-DD end of date range, or null if truly open-ended>",
  "preferred_time_of_day": "<morning | afternoon | evening | any>"
}`;
}

// ── F016 agent prompt ─────────────────────────────────────────────────────────

export interface BusinessContext {
  businessName: string;
  timezone: string;
  services: string[];
  hoursStart: string;   // e.g. "09:00"
  hoursEnd: string;     // e.g. "18:00"
  cancelWindowHours: number;
  clientName: string;
  appointmentService: string | null;
  appointmentTime: string;  // human-readable in business timezone
}

export async function fetchBusinessContext(
  businessId: string,
  appointmentId: string,
  clientName: string,
  timezone: string,
): Promise<BusinessContext> {
  const [bizRow, servicesRow, apptRow] = await Promise.all([
    db.query<{ name: string; settings: Record<string, unknown> }>(
      `SELECT name, settings FROM business WHERE id = $1`,
      [businessId],
    ),
    db.query<{ service_type: string }>(
      `SELECT DISTINCT service_type FROM appointment
       WHERE business_id = $1 AND service_type IS NOT NULL
       ORDER BY service_type`,
      [businessId],
    ),
    db.query<{ starts_at: Date; service_type: string | null }>(
      `SELECT starts_at, service_type FROM appointment WHERE id = $1`,
      [appointmentId],
    ),
  ]);

  const biz = bizRow.rows[0];
  const settings = biz?.settings ?? {};
  const appt = apptRow.rows[0];

  const appointmentTime = appt
    ? new Intl.DateTimeFormat('en-US', {
        weekday: 'long', month: 'long', day: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true,
        timeZone: timezone,
      }).format(new Date(appt.starts_at))
    : 'unknown';

  return {
    businessName: biz?.name ?? 'this business',
    timezone,
    services: servicesRow.rows.map(r => r.service_type),
    hoursStart: (settings.outreach_hours_start as string) ?? '09:00',
    hoursEnd:   (settings.outreach_hours_end   as string) ?? '18:00',
    cancelWindowHours: (settings.client_cancel_window_hours as number) ?? 24,
    clientName,
    appointmentService: appt?.service_type ?? null,
    appointmentTime,
  };
}

export function buildAgentSystemPrompt(ctx: BusinessContext): string {
  const today = new Intl.DateTimeFormat('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: ctx.timezone,
  }).format(new Date());

  const serviceList = ctx.services.length > 0
    ? ctx.services.join(', ')
    : 'general appointments';

  const hoursDisplay = formatHours(ctx.hoursStart, ctx.hoursEnd);

  const cancelPolicy = ctx.cancelWindowHours > 0
    ? `Cancellations must be made at least ${ctx.cancelWindowHours} hours before the appointment.`
    : 'Contact us to cancel.';

  const apptLine = ctx.appointmentService
    ? `${ctx.appointmentService} on ${ctx.appointmentTime}`
    : `Appointment on ${ctx.appointmentTime}`;

  return `You are a warm, professional scheduling assistant for ${ctx.businessName}.
You help clients with their appointments — answering questions, confirming, rescheduling, or cancelling.

BUSINESS INFO
Business: ${ctx.businessName}
Services offered: ${serviceList}
Business hours: ${hoursDisplay}
Cancellation policy: ${cancelPolicy}
Today: ${today}

CLIENT INFO
Client name: ${ctx.clientName}
Current appointment: ${apptLine}

HOW TO RESPOND
- Always respond in plain, natural English. Never output JSON, code, or structured data.
- Be friendly and conversational. Use the client's name occasionally but not every message.
- Keep replies short (1–3 sentences). Don't repeat information the client just acknowledged.
- If a client says "thanks", "great", "perfect", or closes the conversation socially — acknowledge warmly with one sentence and stop. Do NOT re-confirm their appointment details.
- Answer questions about services, hours, and cancellation policy directly from the info above.
- For anything you genuinely can't help with, offer to connect them with the team.

WHEN TO USE TOOLS
- Use check_availability EVERY TIME a client asks about available times or dates — always call it fresh, never answer from previous conversation context since availability changes in real time.
- When calling check_availability, copy the client's EXACT time expression into preference_text verbatim (e.g. "between 1-2PM", "after 3pm", "before noon"). Never paraphrase or omit specific times — they are used for precise slot filtering.
- Never narrate what you are about to do. If you need to call a tool, call it directly without describing it first.
- Use reschedule_appointment only after the client has explicitly chosen a specific slot from options you presented.
- Use confirm_appointment when the client says they can make their scheduled time.
- Use cancel_appointment only after the client explicitly confirms they want to cancel.
- Use get_appointment_details if you need to look up their appointment info.
- Use opt_out_client only if the client explicitly says they don't want to receive messages.
- Use request_human_takeover for distress, explicit human requests, or anything you can't resolve.
- Do NOT call a tool unless you actually need to take action. Normal conversation does not require tools.`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatHours(start: string, end: string): string {
  const fmt = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    const period = h >= 12 ? 'PM' : 'AM';
    const hour = h > 12 ? h - 12 : h === 0 ? 12 : h;
    return `${hour}${m > 0 ? `:${String(m).padStart(2, '0')}` : ''} ${period}`;
  };
  return `${fmt(start)} – ${fmt(end)}`;
}
