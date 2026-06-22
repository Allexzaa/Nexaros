import { Job } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';
import { AutoPickupData } from '../types';
import { db } from '../../db';
import { scheduleOutreach, scheduleAutoPickup } from '../scheduler';

const DEFAULT_INTERVAL_MINUTES = 5;
const DEFAULT_HOURS_START = 9;
const DEFAULT_HOURS_END = 18;

function currentHourIn(timezone: string): number {
  const hourStr = new Intl.DateTimeFormat('en', {
    hour: 'numeric', hour12: false, timeZone: timezone,
  }).format(new Date());
  return parseInt(hourStr, 10);
}

function msUntilNextWindowStart(timezone: string, hoursStart: number): number {
  const now = new Date();
  // Get current local time components in the target timezone
  const parts = new Intl.DateTimeFormat('en', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, timeZone: timezone,
  }).formatToParts(now);

  const get = (type: string) => parseInt(parts.find(p => p.type === type)!.value, 10);
  const year = get('year'); const month = get('month') - 1; const day = get('day');

  // Construct next window start in local time, convert back to UTC
  const candidate = new Date(Date.UTC(year, month, day));
  // Find the UTC time that corresponds to hoursStart in the target timezone
  const candidateLocal = new Date(candidate.toLocaleString('en-US', { timeZone: 'UTC' }));
  candidateLocal.setHours(hoursStart, 0, 0, 0);
  const nextStart = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
  nextStart.setHours(hoursStart, 0, 0, 0);
  if (nextStart <= new Date()) nextStart.setDate(nextStart.getDate() + 1);
  return Math.max(nextStart.getTime() - Date.now(), 60 * 1000);
}

export async function processAutoPickup(job: Job<AutoPickupData>): Promise<void> {
  const businessResult = await db.query<{
    id: string;
    settings: Record<string, unknown> | null;
    timezone: string;
  }>(`SELECT id, settings, timezone FROM business`);

  let nextIntervalMs = DEFAULT_INTERVAL_MINUTES * 60 * 1000;

  for (const business of businessResult.rows) {
    const settings = business.settings ?? {};
    const hoursStart = (settings.outreach_hours_start as number) ?? DEFAULT_HOURS_START;
    const hoursEnd   = (settings.outreach_hours_end   as number) ?? DEFAULT_HOURS_END;
    const intervalMinutes = (settings.auto_pickup_interval_minutes as number) ?? DEFAULT_INTERVAL_MINUTES;
    nextIntervalMs = intervalMinutes * 60 * 1000;

    const tz = business.timezone || 'UTC';
    const currentHour = currentHourIn(tz);

    if (currentHour < hoursStart || currentHour >= hoursEnd) {
      continue;
    }

    const apptResult = await db.query<{ id: string; client_id: string }>(
      `SELECT a.id, a.client_id FROM appointment a
       WHERE a.business_id = $1
         AND a.status = 'pending-outreach'
         AND a.client_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM conversation c WHERE c.appointment_id = a.id)`,
      [business.id],
    );

    for (const appt of apptResult.rows) {
      const convId = uuidv4();
      await db.query(
        `INSERT INTO conversation (id, business_id, client_id, appointment_id) VALUES ($1, $2, $3, $4)`,
        [convId, business.id, appt.client_id, appt.id],
      );
      await scheduleOutreach(appt.id);
    }
  }

  await scheduleAutoPickup(nextIntervalMs);
}
