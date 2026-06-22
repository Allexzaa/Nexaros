# F008 — Automated Reminders

**Status:** Spec Ready  
**Date:** 2026-05-06  
**Author:** Claude  

---

## Goal

Send configurable SMS and email reminders to clients before their appointments to reduce no-shows. Reminders are scheduled automatically when an appointment is confirmed and cancelled if the appointment is cancelled or rescheduled.

---

## Scope

| Area | What |
|---|---|
| Reminder scheduling | Queue reminder jobs when appointment is confirmed |
| Reminder delivery | Send SMS + email at each configured interval |
| Cancellation | Cancel pending reminders when appointment is cancelled/rescheduled |
| Configuration | Per-business reminder intervals and channel preferences |
| Opt-out respect | Never send to clients with `opted_out = true` |

Out of scope: post-appointment reminders (F013), staff reminders, two-way confirmation ("Reply YES to confirm"), multi-language templates.

---

## Existing Foundation

- F003: appointment status transitions (`pending → confirmed`, `confirmed → cancelled`) — hook into these
- F005: `smsService` and `emailService` delivery layer
- BullMQ job infrastructure already in place
- `business.settings` JSONB already supports arbitrary config keys (F004)

---

## Data Model

### New columns on `business.settings` (JSONB — no migration needed)

```json
{
  "reminder_intervals_hours": [24, 2],
  "reminder_channels": ["sms", "email"]
}
```

- `reminder_intervals_hours`: array of integers; reminders sent this many hours before appointment; default `[24, 2]`
- `reminder_channels`: subset of `["sms", "email"]`; default `["sms"]`

### New table: `reminder_job`

```sql
CREATE TABLE reminder_job (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id UUID NOT NULL REFERENCES appointment(id) ON DELETE CASCADE,
  scheduled_for  TIMESTAMPTZ NOT NULL,
  hours_before   INTEGER NOT NULL,
  channel        TEXT NOT NULL CHECK (channel IN ('sms', 'email')),
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'sent', 'cancelled', 'failed')),
  bull_job_id    TEXT,
  sent_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON reminder_job (appointment_id);
CREATE INDEX ON reminder_job (scheduled_for) WHERE status = 'pending';
```

---

## 1. Reminder Scheduling

### Service: `src/services/reminderService.ts`

```ts
scheduleReminders(appointmentId: string): Promise<void>
cancelReminders(appointmentId: string): Promise<void>
```

**`scheduleReminders`:**
1. Load appointment + client + business settings
2. Skip if `client.opted_out = true`
3. For each `hours_before` in `reminder_intervals_hours`, for each channel in `reminder_channels`:
   - Compute `scheduled_for = appointment.scheduled_at - hours_before * 60 * 60 * 1000`
   - Skip if `scheduled_for` is in the past
   - Insert `reminder_job` row
   - Enqueue BullMQ delayed job with `delay = scheduled_for - now`
   - Store BullMQ job ID in `reminder_job.bull_job_id`

**`cancelReminders`:**
1. Query `reminder_job` where `appointment_id` and `status = 'pending'`
2. For each: remove BullMQ job by `bull_job_id`, update `status = 'cancelled'`

### Integration points

| Event | Action |
|---|---|
| Appointment → `confirmed` | Call `scheduleReminders(appointmentId)` |
| Appointment → `cancelled` | Call `cancelReminders(appointmentId)` |
| Appointment rescheduled | `cancelReminders` then `scheduleReminders` with new time |

Hook into the existing F003 appointment status side-effect handlers.

---

## 2. Reminder Job Processor

### Job: `jobs/reminderJob.ts`

```ts
processor(job: Job<{ reminderJobId: string }>): Promise<void>
```

1. Load `reminder_job` by ID — if `status !== 'pending'`, skip (idempotent)
2. Load `appointment` — if status is `cancelled` or `no_show`, mark `reminder_job.status = 'cancelled'` and exit
3. Load `client` — if `opted_out = true`, mark cancelled and exit
4. Send via `smsService.sendSMS()` or `emailService.sendEmail()` depending on `channel`
   - Template key: `appointment_reminder_client`
   - Params: `{ clientName, serviceName, appointmentDate, appointmentTime, businessName }`
5. On success: update `reminder_job` → `status = 'sent'`, `sent_at = now`
6. On failure: update `reminder_job` → `status = 'failed'`; BullMQ handles retry (max 3 attempts, exponential backoff)

---

## 3. Business Settings Integration

### Existing `PATCH /api/v1/business/settings`

Add validation for the new keys:

- `reminder_intervals_hours`: array of integers 1–168; max 5 items; no duplicates
- `reminder_channels`: non-empty array; values must be `"sms"` or `"email"`

No new routes needed — piggybacks on existing settings endpoint.

---

## 4. Admin Visibility

### Extend `GET /api/v1/appointments/:id` response

Add `reminders` array:

```json
{
  "reminders": [
    { "hoursBefore": 24, "channel": "sms", "scheduledFor": "...", "status": "pending" },
    { "hoursBefore": 2,  "channel": "sms", "scheduledFor": "...", "status": "pending" }
  ]
}
```

---

## Phases (proposed)

| Phase | Scope |
|---|---|
| 1 | DB migration + reminderService (schedule + cancel) |
| 2 | Reminder job processor + BullMQ wiring |
| 3 | Hook into appointment status transitions (confirmed / cancelled / reschedule) |
| 4 | Settings validation + appointment detail API extension |

---

## Open Questions

1. Should clients be able to reply "STOP" to cancel their reminder subscription (beyond the existing `opted_out` flag)?
2. Should there be a maximum look-ahead window — e.g. don't schedule reminders more than 7 days in advance in case plans change?
3. Should staff also get a reminder (e.g. 1h before their first appointment of the day)?
