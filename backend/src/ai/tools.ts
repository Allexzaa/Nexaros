/**
 * F016 — Conversational AI: Tool definitions + executors (Phase 2)
 *
 * Each tool has:
 *   - schema: OpenAI function-calling format (passed to LLM)
 *   - executor: real DB + slotManager + emitter wiring
 */

import { db } from '../db';
import { findSlotsForDate, findMatchingSlots, lockSlot, freeSlot, SlotConflictError } from '../services/slotManager';
import { cancelJobsByConversationId } from '../jobs/scheduler';
import { emitAppointmentConfirmed, emitEscalation } from '../realtime/emitters';
import { parseTimeExpression } from './timeParser';
import { ConversationState } from './types';

// ── Tool schemas (passed to LLM) ──────────────────────────────────────────────

export const TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'check_availability',
      description:
        'Find available appointment slots matching a date range and time of day preference. ' +
        'Call this before presenting options to the client.',
      parameters: {
        type: 'object',
        properties: {
          date_from: {
            type: 'string',
            description: 'Start of date range (YYYY-MM-DD). Omit if client has no date preference.',
          },
          date_to: {
            type: 'string',
            description: 'End of date range (YYYY-MM-DD). Same as date_from for a single day.',
          },
          time_of_day: {
            type: 'string',
            enum: ['morning', 'afternoon', 'evening', 'any'],
            description: 'Time-of-day preference.',
          },
          preference_text: {
            type: 'string',
            description: "Copy the client's EXACT time/date expression verbatim — do NOT paraphrase. Examples: 'between 1-2PM', 'after 3pm', 'before noon', 'around 2pm'. This is used for precise time filtering and must include specific times if the client mentioned any.",
          },
        },
        required: ['time_of_day'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'reschedule_appointment',
      description: 'Reschedule the client\'s appointment to a specific slot. Only call after the client has explicitly chosen a slot.',
      parameters: {
        type: 'object',
        properties: {
          slot_id: {
            type: 'string',
            description: 'The slot ID returned by check_availability.',
          },
        },
        required: ['slot_id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'cancel_appointment',
      description: 'Cancel the client\'s current appointment. Only call after the client has explicitly confirmed they want to cancel.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'confirm_appointment',
      description: 'Confirm the client\'s existing appointment as scheduled. Call when the client says they can make it.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_appointment_details',
      description: 'Get the details of the current appointment (service, date, time, status).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'opt_out_client',
      description: 'Mark the client as opted out — they no longer want to receive messages. Only call if they explicitly say so.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'request_human_takeover',
      description: 'Escalate this conversation to a human staff member. Use for distress, explicit requests, or situations you cannot handle.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Brief reason for escalation.',
          },
        },
        required: ['reason'],
      },
    },
  },
] as const;

export type ToolName =
  | 'check_availability'
  | 'reschedule_appointment'
  | 'cancel_appointment'
  | 'confirm_appointment'
  | 'get_appointment_details'
  | 'opt_out_client'
  | 'request_human_takeover';

// ── Tool result types ─────────────────────────────────────────────────────────

export interface SlotResult {
  id: string;
  starts_at: string;
  label: string;
  service_type: string | null;
}

export type ToolResult =
  | { tool: 'check_availability'; slots: SlotResult[]; note?: string }
  | { tool: 'reschedule_appointment'; success: boolean; new_time?: string; error?: string }
  | { tool: 'cancel_appointment'; success: boolean; error?: string }
  | { tool: 'confirm_appointment'; success: boolean; error?: string }
  | { tool: 'get_appointment_details'; service: string | null; starts_at: string; status: string }
  | { tool: 'opt_out_client'; success: boolean }
  | { tool: 'request_human_takeover'; success: boolean };

// ── Context passed to executors ───────────────────────────────────────────────

export interface ToolContext {
  conversationId: string;
  appointmentId: string;
  businessId: string;
  clientId: string;
  clientName: string;
  timezone: string;
  currentState: ConversationState;
}

// ── Tool arguments ────────────────────────────────────────────────────────────

export interface CheckAvailabilityArgs {
  date_from?: string;
  date_to?: string;
  time_of_day: 'morning' | 'afternoon' | 'evening' | 'any';
  preference_text?: string;
}

export interface RescheduleAppointmentArgs {
  slot_id: string;
}

export interface RequestHumanTakeoverArgs {
  reason: string;
}

// ── Executors ─────────────────────────────────────────────────────────────────

export async function executeCheckAvailability(
  args: CheckAvailabilityArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  const timeParsed = parseTimeExpression(args.preference_text ?? args.time_of_day);

  console.log(`[Tool:check_availability] date_from=${args.date_from ?? 'none'} date_to=${args.date_to ?? 'none'} time_of_day=${args.time_of_day} preference_text="${args.preference_text ?? ''}" → parsed from=${timeParsed.from ?? 'none'} to=${timeParsed.to ?? 'none'} bucket=${timeParsed.bucket}`);

  const hasSpecificTimeBounds = !!(timeParsed.from || timeParsed.to);
  let rows;
  let fallbackNote: string | undefined;

  if (args.date_from && args.date_to) {
    rows = await findSlotsForDate(
      ctx.businessId,
      args.date_from,
      args.date_to,
      args.time_of_day,
      ctx.appointmentId,
      ctx.timezone,
      timeParsed.from,
      timeParsed.to,
    );

    // If specific time bounds produced no results, fall back to all slots in the date range
    if (rows.length === 0 && hasSpecificTimeBounds) {
      console.log(`[Tool:check_availability] 0 slots in time window — falling back to full date range`);
      rows = await findSlotsForDate(
        ctx.businessId,
        args.date_from,
        args.date_to,
        'any',
        ctx.appointmentId,
        ctx.timezone,
        null,
        null,
      );
      if (rows.length > 0) {
        fallbackNote = `No slots found between ${timeParsed.from} and ${timeParsed.to}. These are the nearest available slots in the requested date range instead.`;
      }
    }
  } else {
    // Open-ended: get more candidates then post-filter by time bounds
    const candidates = await findMatchingSlots(
      ctx.businessId,
      args.preference_text ?? args.time_of_day,
      ctx.appointmentId,
      ctx.timezone,
      20,
    );
    // Apply time filtering if specific bounds were parsed
    const filtered = hasSpecificTimeBounds
      ? candidates.filter(r => slotMatchesTimeBounds(r.starts_at, timeParsed.from, timeParsed.to, ctx.timezone))
      : candidates;

    if (filtered.length === 0 && hasSpecificTimeBounds) {
      console.log(`[Tool:check_availability] 0 slots in time window (open-ended) — falling back to unfiltered`);
      rows = candidates.slice(0, 3);
      if (rows.length > 0) {
        fallbackNote = `No slots found in the requested time window. These are the nearest available slots instead.`;
      } else {
        rows = [];
      }
    } else {
      rows = filtered.slice(0, 3);
    }
  }

  const fmt = (d: Date | string) =>
    new Intl.DateTimeFormat('en-US', {
      weekday: 'long', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
      timeZone: ctx.timezone,
    }).format(new Date(d));

  const slots: SlotResult[] = (rows ?? []).map(r => ({
    id: r.id,
    starts_at: new Date(r.starts_at).toISOString(),
    label: fmt(r.starts_at),
    service_type: r.service_type,
  }));

  return { tool: 'check_availability', slots, ...(fallbackNote ? { note: fallbackNote } : {}) };
}

export async function executeRescheduleAppointment(
  args: RescheduleAppointmentArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    await lockSlot(args.slot_id, ctx.clientId);
  } catch (err) {
    if (err instanceof SlotConflictError) {
      return { tool: 'reschedule_appointment', success: false, error: 'That slot was just taken by someone else.' };
    }
    throw err;
  }

  // Free the original appointment slot
  await freeSlot(ctx.appointmentId, ctx.businessId);

  // Update conversation: link to new appointment + mark confirmed
  await db.query(
    `UPDATE conversation SET state = 'confirmed', appointment_id = $1 WHERE id = $2`,
    [args.slot_id, ctx.conversationId],
  );

  // Update new appointment to confirmed status
  await db.query(
    `UPDATE appointment SET status = 'confirmed', client_id = $1 WHERE id = $2`,
    [ctx.clientId, args.slot_id],
  );

  await cancelJobsByConversationId(ctx.conversationId);

  const apptRow = await db.query<{ starts_at: Date; service_type: string | null }>(
    `SELECT starts_at, service_type FROM appointment WHERE id = $1`,
    [args.slot_id],
  );
  const appt = apptRow.rows[0];
  const newTime = appt ? new Date(appt.starts_at).toISOString() : '';

  emitAppointmentConfirmed(
    ctx.businessId, args.slot_id, ctx.clientName,
    newTime, appt?.service_type ?? '',
  );

  return { tool: 'reschedule_appointment', success: true, new_time: newTime };
}

export async function executeCancelAppointment(ctx: ToolContext): Promise<ToolResult> {
  await db.query(
    `UPDATE appointment SET status = 'available', client_id = NULL WHERE id = $1`,
    [ctx.appointmentId],
  );
  await db.query(
    `UPDATE conversation SET state = 'cancelled' WHERE id = $1`,
    [ctx.conversationId],
  );
  await cancelJobsByConversationId(ctx.conversationId);
  return { tool: 'cancel_appointment', success: true };
}

export async function executeConfirmAppointment(ctx: ToolContext): Promise<ToolResult> {
  await db.query(
    `UPDATE appointment SET status = 'confirmed' WHERE id = $1`,
    [ctx.appointmentId],
  );
  await db.query(
    `UPDATE conversation SET state = 'confirmed' WHERE id = $1`,
    [ctx.conversationId],
  );
  await cancelJobsByConversationId(ctx.conversationId);

  const apptRow = await db.query<{ starts_at: Date; service_type: string | null }>(
    `SELECT starts_at, service_type FROM appointment WHERE id = $1`,
    [ctx.appointmentId],
  );
  const appt = apptRow.rows[0];
  emitAppointmentConfirmed(
    ctx.businessId, ctx.appointmentId, ctx.clientName,
    appt ? new Date(appt.starts_at).toISOString() : '',
    appt?.service_type ?? '',
  );

  return { tool: 'confirm_appointment', success: true };
}

export async function executeGetAppointmentDetails(ctx: ToolContext): Promise<ToolResult> {
  const r = await db.query<{ starts_at: Date; service_type: string | null; status: string }>(
    `SELECT starts_at, service_type, status FROM appointment WHERE id = $1`,
    [ctx.appointmentId],
  );
  const appt = r.rows[0];
  return {
    tool: 'get_appointment_details',
    service: appt?.service_type ?? null,
    starts_at: appt ? new Date(appt.starts_at).toISOString() : '',
    status: appt?.status ?? 'unknown',
  };
}

export async function executeOptOutClient(ctx: ToolContext): Promise<ToolResult> {
  await db.query(`UPDATE client SET opted_out = true WHERE id = $1`, [ctx.clientId]);
  await db.query(
    `UPDATE conversation SET state = 'resolved'
     WHERE client_id = $1 AND state NOT IN ('confirmed','cancelled','resolved','escalated')`,
    [ctx.clientId],
  );
  return { tool: 'opt_out_client', success: true };
}

export async function executeRequestHumanTakeover(
  args: RequestHumanTakeoverArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  await db.query(
    `UPDATE conversation SET state = 'escalated' WHERE id = $1`,
    [ctx.conversationId],
  );
  emitEscalation(ctx.businessId, ctx.conversationId, ctx.clientName, args.reason);
  return { tool: 'request_human_takeover', success: true };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function slotMatchesTimeBounds(
  startsAt: Date | string,
  from: string | null,
  to: string | null,
  timezone: string,
): boolean {
  if (!from && !to) return true;
  const d = new Date(startsAt);
  const hour = parseInt(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: timezone }).format(d),
    10,
  );
  const minute = d.toLocaleTimeString('en-US', { minute: '2-digit', timeZone: timezone, hour12: false }).split(':')[1]
    ? parseInt(d.toLocaleTimeString('en-US', { timeZone: timezone, hour12: false }).split(':')[1], 10)
    : 0;
  const total = hour * 60 + minute;
  if (from) {
    const [fh, fm] = from.split(':').map(Number);
    if (total < fh * 60 + fm) return false;
  }
  if (to) {
    const [th, tm] = to.split(':').map(Number);
    if (total >= th * 60 + tm) return false;
  }
  return true;
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

export async function dispatchTool(
  name: ToolName,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  switch (name) {
    case 'check_availability':
      return executeCheckAvailability(args as unknown as CheckAvailabilityArgs, ctx);
    case 'reschedule_appointment':
      return executeRescheduleAppointment(args as unknown as RescheduleAppointmentArgs, ctx);
    case 'cancel_appointment':
      return executeCancelAppointment(ctx);
    case 'confirm_appointment':
      return executeConfirmAppointment(ctx);
    case 'get_appointment_details':
      return executeGetAppointmentDetails(ctx);
    case 'opt_out_client':
      return executeOptOutClient(ctx);
    case 'request_human_takeover':
      return executeRequestHumanTakeover(args as unknown as RequestHumanTakeoverArgs, ctx);
    default:
      return { tool: 'request_human_takeover', success: false };
  }
}
