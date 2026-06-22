# F007a — Schedule Detail: Timeline View

**Status:** Approved  
**Date:** 2026-05-06  
**Author:** Claude  
**Parent:** F007 — Staff Dashboard

---

## Goal

Replace the flat appointment table on the Schedule Detail page with a vertical day-timeline (Google Calendar–style). Each slot appears as a colored block at its correct time position, making it immediately clear how the day is laid out, where gaps exist, and which slots are active vs. available — without scrolling through a dense table.

---

## Scope

| Area | What |
|---|---|
| Timeline grid | Hourly rows with time labels, spanning earliest–latest slot |
| Appointment blocks | Colored, positioned by time; show client, service, status |
| Overlap handling | Side-by-side columns when slots overlap |
| Click to select | Click a block → detail panel slides in on the right |
| Click to add | Click empty timeline area → snaps to 15-min grid → opens add-slot panel |
| Detail panel | Right-side panel: selected slot info + Edit / Delete / Outreach actions |
| Add slot panel | Right-side panel: time (pre-filled from click), service, client dropdown |
| Outreach banner | Top banner when pending-outreach slots exist — unchanged from current |

Out of scope: drag-and-drop rescheduling, multi-day view, printing/export.

---

## Layout

```
┌─────────────────────────────────────────────────────────────┐
│ ← Wednesday, May 7   [3 confirmed · 1 pending · 2 available]│
│ ┌─ Outreach banner (if pending-outreach) ─────────────────┐ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
│ ┌── Timeline (flex 1) ──────┐  ┌── Right panel (280px) ──┐ │
│ │ 8am  ─────────────────    │  │  [Empty: tap to add]    │ │
│ │ 9am  ┌──────────────┐     │  │  OR                     │ │
│ │      │ Sarah Johnson│     │  │  [Selected slot detail] │ │
│ │      │ Haircut      │     │  │  OR                     │ │
│ │      └──────────────┘     │  │  [Add slot form]        │ │
│ │ 10am ─────────────────    │  │                         │ │
│ │ ...                       │  │                         │ │
│ └───────────────────────────┘  └─────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

---

## Timeline Mechanics

### Hour height
`80px` per hour. This makes a 10-hour day `800px` tall — scrollable but not overwhelming.

### Time range
Derived from actual appointments, padded by 1 hour on each side. Hard constraints: never earlier than `07:00`, never later than `21:00`. If no appointments, default to `08:00–18:00`.

### Block positioning
```
top  = (slotHour + slotMinute/60 - startHour) × HOUR_HEIGHT
height = 60px (fixed — duration not tracked)
```

### Overlap detection
Two slots overlap if their time ranges `[starts_at, starts_at + 60min)` intersect. Overlapping slots are assigned columns (0, 1, 2…). Each column takes an equal share of the block area width.

### Click-to-add snapping
Y position on the timeline → raw hour float → round to nearest 15-minute increment → pre-fill the add-slot panel time field.

---

## Appointment Block

Each block shows (in order, truncating if needed):
1. Time (e.g. `10:00 AM`)
2. Client name (or `Open slot` if unassigned)
3. Service type (if set)

**Status colors:**

| Status | Background | Border-left | Text |
|---|---|---|---|
| `available` | `#f9fafb` | `#d1d5db` | `#6b7280` |
| `pending-outreach` | `#fefce8` | `#f59e0b` | `#92400e` |
| `ai-active` | `#eff6ff` | `#3b82f6` | `#1e40af` |
| `confirmed` | `#f0fdf4` | `#22c55e` | `#15803d` |
| `cancelled` | `#fef2f2` | `#ef4444` | `#b91c1c` |
| `rescheduled` | `#f5f3ff` | `#8b5cf6` | `#5b21b6` |
| `no-response` | `#f9fafb` | `#9ca3af` | `#4b5563` |

Selected block gets a `box-shadow: 0 0 0 2px #0057ff` ring.

---

## Right Panel — States

### 1. Empty (nothing selected)
- Prompt: *"Click a slot to view details, or click anywhere on the timeline to add a new slot."*
- "+ Add Slot" button that opens the add form with default time `09:00`

### 2. Slot selected
- Status badge
- Time, service type, client name (linked to `/clients/:id`)
- **Edit** button: expands inline fields (time, service, client) — same logic as current table edit
- **Delete** button: only shown if `status = 'available'`; confirm dialog
- **Trigger Outreach** button: only shown if `status = 'pending-outreach'` and no conversation yet
- **View conversation** link: only shown if a conversation exists for this appointment

### 3. Add slot form
- Time field (pre-filled from click, or `09:00` default)
- Service type text field
- Client assignment dropdown (lazy-loaded)
- Hint: assigning a client sets status to `pending-outreach`
- Submit / Cancel

---

## Phases

### Phase 1 — Timeline grid + static blocks
- Render hourly grid with time labels
- Render appointment blocks at correct positions with status colors
- Derive time range from appointments
- No interactions yet — read-only view

### Phase 2 — Selection + right panel
- Click block → highlight selection + show detail panel
- Right panel: slot info, status badge, client link
- Click empty timeline → snap to 15-min grid → open add panel with pre-filled time

### Phase 3 — Full actions in right panel
- Edit slot inline (time, service, client)
- Delete slot (available only)
- Add slot form (submit → POST /schedules/:id/appointments)
- Overlap column layout for simultaneous slots
- Outreach banner + trigger outreach button

---

## Open Questions

1. Should clicking an `ai-active`, `confirmed`, or `cancelled` slot also show a "View conversation" link? (Yes — if `conversation` exists for that appointment.)
2. Should the timeline auto-scroll to the first appointment on load, rather than starting at the top?
3. Duration: since we don't track slot duration, all blocks are fixed 60px. Should we add a `duration_minutes` field to `appointment` so blocks can reflect actual length?
