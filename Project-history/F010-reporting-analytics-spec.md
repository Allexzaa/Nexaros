# F010 — Reporting & Analytics

**Status:** Spec Ready  
**Date:** 2026-05-06  
**Author:** Claude  

---

## Goal

Give admins a dashboard to understand how the business is performing: booking volume, no-show rates, AI conversion, revenue, and staff utilization. Without this, the business owner has no visibility into whether the system is working.

---

## Scope

| Area | What |
|---|---|
| Booking funnel | Outreach sent → conversation started → confirmed → completed |
| Appointment metrics | Volume, no-show rate, cancellation rate by period |
| AI performance | Conversations handled autonomously vs. escalated to staff |
| Revenue summary | Completed appointment value (if services have prices) |
| Staff utilization | Appointments per staff member |
| Export | CSV download for any report |

Out of scope: real-time revenue tracking (requires F011 payments), predictive analytics, custom report builder, third-party BI tool integration (Looker, Metabase).

---

## Existing Foundation

- `appointment` table with `status`, `scheduled_at`, `created_at` (F004)
- `conversation` table with `state`, `created_at`, `staff_user_id` (F003)
- `client` table with `opted_out`, `created_at` (F004)
- `notification_log` table with outreach send records (F005)
- All data is scoped to `business_id`

---

## Data Model

No new persistent tables — all reports are computed queries. Add a `schedule.price_cents` column for revenue tracking:

```sql
ALTER TABLE schedule
  ADD COLUMN price_cents INTEGER NOT NULL DEFAULT 0;  -- 0 = free / not set
```

Set via existing `PATCH /api/v1/schedules/:id`.

---

## 1. Report: Booking Funnel

### `GET /api/v1/reports/funnel`

- **Auth:** `requireAuth`, `requireRole('admin')`
- **Query:** `from=YYYY-MM-DD&to=YYYY-MM-DD`
- **Response:**

```json
{
  "period": { "from": "2026-04-01", "to": "2026-04-30" },
  "outreachSent": 142,
  "conversationsStarted": 98,
  "appointmentsConfirmed": 71,
  "appointmentsCompleted": 64,
  "conversionRate": 0.65,
  "completionRate": 0.90
}
```

- `outreachSent`: `notification_log` rows where `template_key = 'outreach'` in period
- `conversationsStarted`: `conversation` rows with `created_at` in period
- `appointmentsConfirmed`: appointments reaching `confirmed` status in period
- `appointmentsCompleted`: appointments with `status = 'completed'` (or `no_show` is excluded) in period
- `conversionRate`: confirmed / conversations started
- `completionRate`: completed / confirmed

---

## 2. Report: Appointment Volume

### `GET /api/v1/reports/appointments`

- **Auth:** `requireAuth`, `requireRole('admin', 'staff')`
- **Query:** `from`, `to`, `groupBy=day|week|month`, `staffUserId?`, `scheduleId?`
- **Response:**

```json
{
  "series": [
    { "period": "2026-04-01", "confirmed": 8, "completed": 7, "cancelled": 1, "noShow": 0 }
  ],
  "totals": { "confirmed": 71, "completed": 64, "cancelled": 5, "noShow": 2 },
  "noShowRate": 0.031,
  "cancellationRate": 0.07
}
```

SQL: group `appointment` rows by truncated `scheduled_at` + `status`, filtered by business + date range.

---

## 3. Report: AI Performance

### `GET /api/v1/reports/ai-performance`

- **Auth:** `requireAuth`, `requireRole('admin')`
- **Query:** `from`, `to`
- **Response:**

```json
{
  "totalConversations": 98,
  "fullyAutonomous": 61,
  "escalatedToStaff": 37,
  "autonomousRate": 0.62,
  "avgMessagesPerConversation": 4.2,
  "avgResolutionMinutes": 18
}
```

- `fullyAutonomous`: conversations that reached a terminal state (`confirmed`, `declined`, `closed`) without ever entering `ESCALATED` state or having a staff takeover
- `avgResolutionMinutes`: `MIN(updated_at) WHERE state IN (terminal states)` - `created_at` averaged across conversations

---

## 4. Report: Revenue Summary

### `GET /api/v1/reports/revenue`

- **Auth:** `requireAuth`, `requireRole('admin')`
- **Query:** `from`, `to`, `groupBy=day|week|month`
- **Response:**

```json
{
  "series": [
    { "period": "2026-04-01", "revenueCents": 85000, "appointmentCount": 8 }
  ],
  "totalRevenueCents": 680000,
  "avgRevenuePerAppointmentCents": 10625,
  "currency": "USD"
}
```

- Revenue = SUM of `schedule.price_cents` for completed appointments in period
- Only counts appointments with `status = 'completed'` (not cancelled/no-show)
- If all `price_cents = 0`, response includes `"pricingNotConfigured": true`

---

## 5. Report: Staff Utilization

### `GET /api/v1/reports/staff`

- **Auth:** `requireAuth`, `requireRole('admin')`
- **Query:** `from`, `to`
- **Response:**

```json
{
  "staff": [
    {
      "staffUserId": "...",
      "name": "Jane Smith",
      "appointmentsCompleted": 24,
      "appointmentsCancelled": 2,
      "noShows": 1,
      "conversationsHandled": 12,
      "utilizationHours": 18.5
    }
  ]
}
```

- `utilizationHours`: SUM of slot durations for completed appointments (derived from `schedule_slot` duration)
- `conversationsHandled`: conversations where staff took over at least once

---

## 6. Dashboard Page (Staff Web)

### New page in `apps/staff-web`: `/reports`

- **Access:** Admin only (redirect to `/calendar` for staff/viewer)
- Four metric cards at top: Total Bookings | No-Show Rate | AI Autonomous Rate | Revenue This Month
- Booking volume chart (line, default: last 30 days, grouped by day)
- Funnel visualization (horizontal bar)
- Staff utilization table
- Date range picker (preset: Last 7 days / Last 30 days / Last 3 months / Custom)
- "Export CSV" button per section

### CSV Export

### `GET /api/v1/reports/export`

- **Auth:** `requireAuth`, `requireRole('admin')`
- **Query:** `report=appointments|funnel|staff|revenue`, `from`, `to`
- **Response:** `Content-Type: text/csv`, streamed
- Filename: `ai-scheduler-{report}-{from}-{to}.csv`

---

## Caching

All report endpoints are expensive queries. Add a short cache layer:

- Use Redis `GET`/`SET` with key `report:{businessId}:{reportType}:{from}:{to}:{groupBy}`
- TTL: 5 minutes for same-day ranges, 1 hour for historical ranges (past data doesn't change)
- Cache-bust: on any appointment status change for that business (existing Socket.io event can trigger)

---

## Phases (proposed)

| Phase | Scope |
|---|---|
| 1 | `schedule.price_cents` migration + funnel + appointment volume API endpoints |
| 2 | AI performance + revenue + staff utilization API endpoints |
| 3 | Redis caching layer + CSV export endpoint |
| 4 | Reports page in staff-web (charts + date picker + export button) |

---

## Open Questions

1. Should the `completed` appointment status be added formally? Currently `confirmed` is the terminal positive state. We'd need a staff action to mark an appointment as completed after it happens.
2. Should revenue reports be blocked/hidden when `price_cents` is all zero, or show with a "configure pricing" nudge?
3. Is the 5-minute Redis cache acceptable, or do admins need real-time data?
