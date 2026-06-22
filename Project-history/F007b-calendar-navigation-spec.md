# F007b — Schedule Calendar: Month/Week/Day Navigation + Batch Slot Creator

**Status:** Approved  
**Date:** 2026-05-06  
**Author:** Claude  
**Parent:** F007 — Staff Dashboard

---

## Goal

Replace the flat schedule list with a full calendar navigation surface (month → week → day) and add a batch slot creator so staff can set up an entire week of availability in one action instead of adding slots one at a time.

---

## Scope

| Area | What |
|---|---|
| Month view | Full month grid; colored dot indicators per day; click day → day timeline |
| Week view | 7-column multi-day timeline; slots as colored blocks; click empty → add slot |
| Day view | Existing ScheduleDetail timeline — unchanged |
| Navigation | Month/Week/Day tabs + prev/next arrows + Today button |
| Batch creator | Modal: date range + days of week + time range + interval → bulk create |
| Backend: range API | `GET /api/v1/appointments/range` — all appointments across a date range |
| Backend: batch API | `POST /api/v1/schedules/batch` — create schedules + slots in bulk |

Out of scope: drag-to-reschedule, multi-staff column view, iCal export, printing.

---

## Navigation Structure

```
/schedules              → ScheduleCalendar (month/week view)
/schedules/:id          → ScheduleDetail   (day timeline — unchanged)
```

View state (month/week/day + current date) lives in URL query params so links are shareable:
- `/schedules?view=month&date=2026-05-01`
- `/schedules?view=week&date=2026-05-05`
- Clicking a day in month/week → `/schedules/:scheduleId` (existing day timeline)
- If a day has no schedule yet, clicking it prompts to create one first

---

## Month View

### Grid layout
- 7 columns (Sun → Sat), 5–6 rows
- Header row: Sun / Mon / Tue / Wed / Thu / Fri / Sat
- Days outside current month: dimmed (shown for context, not clickable for creation)
- Today: blue ring around date number

### Day cell contents
Each cell shows up to 3 indicators:
- Green dot + count → confirmed slots
- Yellow dot + count → available / pending-outreach slots  
- Blue dot + count → AI-active slots

If no schedule exists for the day: cell is empty with a faint `+` on hover.

### Click behavior
- Day with existing schedule → navigate to `/schedules/:id`
- Day with no schedule → inline "Create schedule for [date]?" confirm → creates schedule → navigate to detail

### Data
`GET /api/v1/appointments/range?from=YYYY-MM-DD&to=YYYY-MM-DD` — returns appointments grouped by date with status counts. Called once per month view load.

---

## Week View

### Layout
- 7 columns (one per day), time rows from 07:00–21:00 fixed
- Column headers: day name + date; today column has blue header
- `HOUR_HEIGHT = 60px` (tighter than day view's 80px to fit 7 columns)
- Left time label column: 48px wide

### Slot blocks
- Same colored block style as day timeline
- Width: full column width minus padding
- Overlapping slots within same day: side-by-side (same logic as day view)
- Click block → navigates to `/schedules/:scheduleId` with that slot pre-selected (via query param `?slot=:apptId`)

### Click empty area
- Click empty column area → snap to 15-min grid → open add-slot panel for that day/time
- If no schedule exists for that day, create it first, then open add-slot panel

### Navigation
- Prev/next week arrows
- "Today" jumps to current week

### Data
Same `GET /api/v1/appointments/range` endpoint — called once per week view load.

---

## Batch Slot Creator

Floating modal, triggered by a "Batch Create" button in the calendar header.

### Step 1 — Date range
- Start date / End date pickers
- Default: today → +14 days

### Step 2 — Days of week
- Checkbox row: Sun Mon Tue Wed Thu Fri Sat
- Default: Mon–Fri checked

### Step 3 — Time template
- Start time (default: 09:00)
- End time (default: 17:00)
- Slot interval: 15 / 30 / 45 / 60 min (default: 30)
- Service type (optional text field — applied to all created slots)

### Preview
Live count: "This will create **32 slots** across **8 days**"

### Submit
`POST /api/v1/schedules/batch` — server creates:
1. A `schedule` row for each date in range that matches selected days of week AND doesn't already have a schedule
2. An `appointment` row for each time slot on each day (status: `available`)

Returns `{ schedulesCreated: N, slotsCreated: M }`

---

## Backend: `GET /api/v1/appointments/range`

- **Auth:** `requireAuth`
- **Query:** `from=YYYY-MM-DD`, `to=YYYY-MM-DD` (max 42 days — 6 weeks)
- **Response:**

```json
{
  "days": {
    "2026-05-06": {
      "scheduleId": "uuid",
      "slots": [
        { "id": "uuid", "starts_at": "...", "service_type": "Haircut", "status": "confirmed", "client_name": "Sarah Johnson" }
      ]
    },
    "2026-05-07": { "scheduleId": "uuid", "slots": [...] }
  }
}
```

Days with no schedule are omitted from the response (client treats absence as empty).

---

## Backend: `POST /api/v1/schedules/batch`

- **Auth:** `requireAuth`, `requirePermission('canEditSchedule')`
- **Body:**

```json
{
  "dateFrom": "2026-05-06",
  "dateTo": "2026-05-20",
  "daysOfWeek": [1, 2, 3, 4, 5],
  "timeStart": "09:00",
  "timeEnd": "17:00",
  "intervalMinutes": 30,
  "serviceType": "Haircut"
}
```

- **Validation:**
  - `dateFrom` / `dateTo`: valid YYYY-MM-DD; from ≤ to; range ≤ 90 days
  - `daysOfWeek`: array of integers 0–6 (0=Sun); non-empty
  - `timeStart` / `timeEnd`: HH:MM; start < end
  - `intervalMinutes`: one of 15, 30, 45, 60
  - `serviceType`: optional string max 100 chars
- **Behavior:**
  - For each date in range that matches a selected day of week:
    - Upsert `schedule` (skip if already exists for that business+date)
    - Generate time slots from `timeStart` to `timeEnd - intervalMinutes` at `intervalMinutes` spacing
    - Insert `appointment` rows with `status = 'available'`
  - Skip slots in the past
- **Response:** `{ schedulesCreated: number, slotsCreated: number }`

---

## Phases

### Phase 1 — Backend endpoints
- `GET /api/v1/appointments/range`
- `POST /api/v1/schedules/batch`

### Phase 2 — Calendar shell + month view
- Replace `ScheduleBuilder.tsx` with `ScheduleCalendar.tsx`
- Month grid with day indicators, navigation, click-to-open

### Phase 3 — Week view
- 7-column timeline integrated into ScheduleCalendar
- Slot blocks, click-to-navigate, click-empty-to-add

### Phase 4 — Batch slot creator
- Modal with 3-step form, live preview count, submit → batch API

---

## Open Questions

1. Should the week view allow editing slots inline, or always navigate to the day timeline for edits?
2. Should "batch create" skip days that already have slots, or add to them?
3. Should the month view show a mini agenda (list of appointments) on click, or always navigate directly to the day timeline?
