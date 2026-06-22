# F006 — Calendar Integration

**Status:** Spec Ready  
**Date:** 2026-05-06  
**Author:** Claude  

---

## Goal

Connect the scheduler to real calendar systems so that staff availability is read from Google Calendar (not just the manually-entered schedule) and confirmed appointments are written back as calendar events. This eliminates double-booking and removes the need for staff to maintain two systems.

---

## Scope

| Area | What |
|---|---|
| Google Calendar read | Fetch busy/free blocks for a staff member's calendar |
| Availability merge | Intersect calendar busy blocks with schedule slots before offering to AI |
| Appointment write-back | Create/update/delete Google Calendar events when appointment status changes |
| OAuth token storage | Persist and refresh Google OAuth tokens per staff member |
| iCal read (basic) | Accept an iCal feed URL as a read-only busy source |

Out of scope: Outlook/Microsoft Calendar (deferred), two-way sync of arbitrary events, attendee management, meeting links (Zoom/Meet), multi-calendar selection per staff member.

---

## Existing Foundation

- F002 already implements Google OAuth login for staff. The OAuth flow exists; we need to extend it to request `calendar` scope and store the refresh token.
- `schedule` and `schedule_slot` tables exist (F004). Slot availability is already queried by `SlotManager` in F003.
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are already in the env.

---

## Data Model

### New columns on `staff_user`

```sql
ALTER TABLE staff_user
  ADD COLUMN google_calendar_id      TEXT,           -- e.g. "primary" or specific calendar ID
  ADD COLUMN google_refresh_token    TEXT,           -- encrypted at rest
  ADD COLUMN google_token_expires_at TIMESTAMPTZ,
  ADD COLUMN ical_feed_url           TEXT,           -- optional read-only busy source
  ADD COLUMN calendar_sync_enabled   BOOLEAN NOT NULL DEFAULT false;
```

> `google_refresh_token` must be encrypted using AES-256-GCM via a `CALENDAR_TOKEN_ENCRYPTION_KEY` env var. Never store plaintext OAuth tokens.

### New table: `calendar_busy_cache`

```sql
CREATE TABLE calendar_busy_cache (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_user_id UUID NOT NULL REFERENCES staff_user(id) ON DELETE CASCADE,
  starts_at    TIMESTAMPTZ NOT NULL,
  ends_at      TIMESTAMPTZ NOT NULL,
  source       TEXT NOT NULL CHECK (source IN ('google', 'ical')),
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON calendar_busy_cache (staff_user_id, starts_at, ends_at);
```

Cache is rebuilt on each sync. TTL: 15 minutes (stale rows deleted on next sync for that staff member).

---

## 1. Google Calendar OAuth — Scope Extension

### OAuth flow change

When a staff member connects Google Calendar (separate from login), re-run the OAuth flow requesting:

```
scope: openid email profile https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly
```

Add `access_type=offline` and `prompt=consent` to get a refresh token.

### Route: `GET /api/v1/staff/me/calendar/connect`

- **Auth:** `requireAuth`
- Redirects to Google OAuth with calendar scopes
- After callback, stores encrypted `google_refresh_token` and sets `calendar_sync_enabled = true`
- Returns `{ ok: true, calendarId: 'primary' }`

### Route: `DELETE /api/v1/staff/me/calendar/disconnect`

- **Auth:** `requireAuth`
- Clears `google_refresh_token`, `google_token_expires_at`, `google_calendar_id`, sets `calendar_sync_enabled = false`
- Deletes `calendar_busy_cache` rows for this staff member
- Revokes token via `https://oauth2.googleapis.com/revoke`

---

## 2. Calendar Sync Service

### Service: `src/services/calendarService.ts`

```ts
fetchBusyBlocks(staffUserId: string, windowStart: Date, windowEnd: Date): Promise<BusyBlock[]>
```

- Decrypts `google_refresh_token`, refreshes access token if expired
- Calls Google Calendar FreeBusy API: `POST https://www.googleapis.com/calendar/v3/freeBusy`
- Returns array of `{ starts_at, ends_at }` blocks
- Upserts into `calendar_busy_cache` (delete old + insert new for staff + window)

```ts
fetchIcalBusyBlocks(feedUrl: string, windowStart: Date, windowEnd: Date): Promise<BusyBlock[]>
```

- Fetches the iCal feed URL (GET with 10s timeout)
- Parses with `ical.js` or `node-ical`
- Filters `VEVENT` entries that overlap the window
- Upserts into `calendar_busy_cache` with `source: 'ical'`

### Sync job: `jobs/calendarSyncJob.ts`

- Runs every 15 minutes via BullMQ
- For each `staff_user` where `calendar_sync_enabled = true`, fetches busy blocks for the next 7 days
- Failures are logged but do not block scheduling (fall back to schedule-only availability)

---

## 3. Availability Merge

### Change to `SlotManager.getAvailableSlots()`

After querying `schedule_slot` rows, subtract any overlapping `calendar_busy_cache` rows for the assigned staff member(s):

```ts
// Existing: slots from schedule_slot table
const slots = await getScheduleSlots(scheduleId, date);

// New: subtract busy blocks from calendar cache
const busy = await getBusyBlocksFromCache(staffUserId, dayStart, dayEnd);
return slots.filter(slot => !overlapsAny(slot, busy));
```

- `overlapsAny`: returns true if slot `[starts_at, ends_at)` overlaps any busy block
- Cache miss (no rows for staff + day): treat as no busy blocks — do not block scheduling
- Log a warning if `calendar_sync_enabled = true` but cache is older than 30 minutes

---

## 4. Appointment Write-Back

### Service: `src/services/calendarService.ts` (additions)

```ts
createCalendarEvent(appointment: Appointment, staffUser: StaffUser): Promise<string>  // returns eventId
updateCalendarEvent(eventId: string, appointment: Appointment, staffUser: StaffUser): Promise<void>
deleteCalendarEvent(eventId: string, staffUser: StaffUser): Promise<void>
```

- Uses Google Calendar Events API (`calendar.events.insert/patch/delete`)
- Event title: `"[Client Name] — [Service]"` or configurable via `business.settings`
- Event body: appointment ID, client phone, notes
- Stores returned `eventId` on the `appointment` row (new column)

### New column on `appointment`

```sql
ALTER TABLE appointment
  ADD COLUMN calendar_event_id TEXT;  -- Google Calendar event ID, null if not synced
```

### Triggers (hook into existing appointment status changes)

| Appointment transition | Calendar action |
|---|---|
| `pending` → `confirmed` | `createCalendarEvent` |
| `confirmed` → `confirmed` (reschedule) | `updateCalendarEvent` |
| `confirmed` → `cancelled` | `deleteCalendarEvent` |
| `confirmed` → `no_show` | `deleteCalendarEvent` |

Integrate into the existing F003 appointment status side-effect handlers. Failure to write to calendar: log error, do NOT fail the appointment transition (calendar sync is best-effort).

---

## 5. iCal Feed (Read-Only)

### Route: `PATCH /api/v1/staff/me/calendar/ical`

- **Auth:** `requireAuth`
- **Body:** `{ feedUrl: string | null }`
- Validates URL format; sets `ical_feed_url` on `staff_user`
- If `feedUrl` is null, clears the field and deletes cache rows with `source: 'ical'`
- Triggers an immediate sync for the next 7 days
- Returns `{ ok: true }`

---

## 6. Staff Calendar Settings API

### `GET /api/v1/staff/me/calendar`

- **Auth:** `requireAuth`
- **Response:**

```json
{
  "calendarSyncEnabled": true,
  "googleCalendarId": "primary",
  "icalFeedUrl": null,
  "lastSyncedAt": "2026-05-06T14:00:00Z"
}
```

(`lastSyncedAt` = MAX `fetched_at` from `calendar_busy_cache` for this staff member)

---

## Environment Variables Required

```
CALENDAR_TOKEN_ENCRYPTION_KEY=   # 32-byte hex key for AES-256-GCM
# GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET already exist from F002
```

---

## Phases (proposed)

| Phase | Scope |
|---|---|
| 1 | DB migrations (staff_user columns + calendar_busy_cache + appointment.calendar_event_id) + token encryption util |
| 2 | Google OAuth connect/disconnect routes + calendarService.fetchBusyBlocks |
| 3 | Sync job + SlotManager availability merge |
| 4 | Appointment write-back (create/update/delete) + iCal feed support |

---

## Open Questions

1. Should calendar sync be per-business-controlled (admin can force-enable/disable for all staff) or purely per-staff opt-in?
2. What event title format does the business prefer? Could be a `business.settings` field.
3. If a staff member has no Google Calendar connected, should the UI show a nudge or just silently use schedule-only availability?
