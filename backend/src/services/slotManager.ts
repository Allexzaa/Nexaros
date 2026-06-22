import { db } from '../db';
import { llmClient } from '../ai/llmInstance';
import { scheduleWaitlistCheck } from '../jobs/scheduler';

export class SlotConflictError extends Error {
  constructor() {
    super('Slot is no longer available');
    this.name = 'SlotConflictError';
  }
}

export interface SlotRow {
  id: string;
  starts_at: Date;
  service_type: string | null;
}

function fmtSlotLabel(row: SlotRow, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: tz,
  }).format(new Date(row.starts_at));
}

// Returns top N available slots ranked by LLM against client preferences.
export async function findMatchingSlots(
  businessId: string,
  preferences: string,
  excludeAppointmentId: string,
  timezone: string,
  limit = 3,
): Promise<SlotRow[]> {
  const result = await db.query<SlotRow>(
    `SELECT id, starts_at, service_type FROM appointment
     WHERE business_id = $1 AND status = 'available' AND id != $2
       AND starts_at > NOW()
     ORDER BY starts_at ASC
     LIMIT 50`,
    [businessId, excludeAppointmentId],
  );

  console.log(`[SlotManager] findMatchingSlots | preference="${preferences}" | candidates=${result.rows.length}`);
  if (result.rows.length > 0) {
    console.log(`[SlotManager] candidate range: ${new Date(result.rows[0].starts_at).toISOString()} → ${new Date(result.rows[result.rows.length - 1].starts_at).toISOString()}`);
  }

  if (!result.rows.length) return [];
  if (result.rows.length <= limit) return result.rows;

  // Ask LLM to rank all candidates — find the best matching slot
  const todayLabel = new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: timezone,
  }).format(new Date());

  const slots = result.rows.map((row) => ({
    id: row.id,
    label: fmtSlotLabel(row, timezone),
  }));

  const rankedId = await llmClient.rankSlots(preferences, slots, todayLabel);
  const best = rankedId ? result.rows.find((r) => r.id === rankedId) : null;

  if (!best) return result.rows.slice(0, limit);

  // Same-day-first: collect all slots on the same calendar date as the best match.
  // Only expand to adjacent days if the same day doesn't fill the quota.
  const toDateStr = (d: Date | string) =>
    new Date(d).toLocaleDateString('en-CA', { timeZone: timezone });

  const bestDate = toDateStr(best.starts_at);
  const bestTime = new Date(best.starts_at).getTime(); // declared before any sort that uses it

  // Sort same-day candidates by proximity to the best match time so that
  // slots closest in time to the best are offered first (e.g. 1pm and 2pm
  // come before 9am when best is 1pm for an "afternoon" preference).
  const sameDaySlots = result.rows
    .filter((r) => r.id !== rankedId && toDateStr(r.starts_at) === bestDate)
    .sort((a, b) =>
      Math.abs(new Date(a.starts_at).getTime() - bestTime) -
      Math.abs(new Date(b.starts_at).getTime() - bestTime),
    );

  if (sameDaySlots.length >= limit - 1) {
    console.log(`[SlotManager] same-day slots for ${bestDate}: ${sameDaySlots.length + 1} total (sorted by proximity to best)`);
    return [best, ...sameDaySlots.slice(0, limit - 1)];
  }

  // Not enough same-day — pad with nearest adjacent-day slots by time proximity
  const adjacentSlots = result.rows
    .filter((r) => r.id !== rankedId && toDateStr(r.starts_at) !== bestDate)
    .sort((a, b) =>
      Math.abs(new Date(a.starts_at).getTime() - bestTime) -
      Math.abs(new Date(b.starts_at).getTime() - bestTime),
    );

  const needed = limit - 1 - sameDaySlots.length;
  console.log(`[SlotManager] same-day slots: ${sameDaySlots.length}, adding ${needed} adjacent`);
  return [best, ...sameDaySlots, ...adjacentSlots.slice(0, needed)];
}

// Find ALL available slots within a date range that match the time filter.
// No limit. No fallback to adjacent days.
// Empty result = no availability for that date/time. Caller handles the message.
export async function findSlotsForDate(
  businessId: string,
  dateFrom: string,            // YYYY-MM-DD
  dateTo: string,              // YYYY-MM-DD
  timeOfDay: string | null,    // bucket fallback: morning/afternoon/evening/any
  excludeAppointmentId: string,
  timezone: string,
  timeFrom: string | null = null,  // HH:MM specific lower bound e.g. "13:00"
  timeTo:   string | null = null,  // HH:MM specific upper bound e.g. "17:00", null = no cap
): Promise<SlotRow[]> {
  const result = await db.query<SlotRow>(
    `SELECT id, starts_at, service_type FROM appointment
     WHERE business_id = $1
       AND status = 'available'
       AND id != $2
       AND starts_at > NOW()
       AND (starts_at AT TIME ZONE $3)::date BETWEEN $4::date AND $5::date
     ORDER BY starts_at ASC`,
    [businessId, excludeAppointmentId, timezone, dateFrom, dateTo],
  );

  const getHour = (d: Date | string) =>
    parseInt(
      new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: timezone })
        .format(new Date(d)),
      10,
    );

  const getMinute = (d: Date | string) =>
    new Date(d).toLocaleTimeString('en-US', { minute: '2-digit', timeZone: timezone, hour12: false })
      .split(':')[1] ? parseInt(new Date(d).toLocaleTimeString('en-US', { timeZone: timezone, hour12: false }).split(':')[1], 10) : 0;

  function matchesTime(slot: SlotRow): boolean {
    const hour   = getHour(slot.starts_at);
    const minute = getMinute(slot.starts_at);
    const totalMinutes = hour * 60 + minute;

    if (timeFrom) {
      // Specific time bounds take precedence over the bucket
      const [fh, fm] = timeFrom.split(':').map(Number);
      const fromMinutes = fh * 60 + fm;
      const toMinutes   = timeTo ? (() => { const [th, tm] = timeTo.split(':').map(Number); return th * 60 + tm; })() : 24 * 60;
      return totalMinutes >= fromMinutes && totalMinutes < toMinutes;
    }

    // Fall back to time-of-day bucket
    switch ((timeOfDay ?? 'any').toLowerCase()) {
      case 'morning':   return hour >= 6  && hour < 12;
      case 'afternoon': return hour >= 13 && hour < 17;
      case 'evening':   return hour >= 17;
      default:          return true;
    }
  }

  const matching = result.rows.filter((r) => matchesTime(r));
  const filterDesc = timeFrom
    ? `after ${timeFrom}${timeTo ? ` before ${timeTo}` : ''}`
    : (timeOfDay ?? 'any');
  console.log(`[SlotManager] findSlotsForDate | range=${dateFrom}→${dateTo} filter="${filterDesc}" | total=${result.rows.length} matching=${matching.length}`);
  return matching;
}

// Legacy single-slot lookup — kept for waitlist and approval flows.
export async function findBestSlot(
  businessId: string,
  preferences: string,
  excludeAppointmentId: string,
  timezone = 'America/Los_Angeles',
): Promise<SlotRow | null> {
  const slots = await findMatchingSlots(businessId, preferences, excludeAppointmentId, timezone, 1);
  return slots[0] ?? null;
}

export async function lockSlot(appointmentId: string, clientId: string): Promise<void> {
  const result = await db.query(
    `UPDATE appointment SET status = 'confirmed', client_id = $2
     WHERE id = $1 AND status = 'available'`,
    [appointmentId, clientId],
  );
  if ((result as any).rowCount === 0) throw new SlotConflictError();
}

export async function freeSlot(appointmentId: string, businessId: string): Promise<void> {
  await db.query(
    `UPDATE appointment SET status = 'available', client_id = NULL WHERE id = $1`,
    [appointmentId],
  );
  await scheduleWaitlistCheck(appointmentId, businessId);
}
