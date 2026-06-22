# F007 — Staff Dashboard: Conversations & Appointments UI

**Status:** Spec Ready  
**Date:** 2026-05-06  
**Author:** Claude  

---

## Goal

Give staff and admins a usable web interface for their daily work: see live AI conversations, take over or return control, manage appointments on a calendar view, and work the waitlist. This turns the backend (F003 + F004) into a product a real human operator can use today.

---

## Scope

| Area | What |
|---|---|
| Conversation list | See all active conversations with status and last message |
| Conversation detail | Read full message thread; take over from AI / return to AI |
| Appointment calendar | Day/week calendar view of all appointments |
| Appointment management | Confirm, cancel, reschedule from the UI |
| Waitlist panel | See waitlisted clients; manually promote to a slot |
| Notification badge | Real-time count of escalated / pending-approval conversations |

Out of scope: client-facing web portal (different product), analytics/reporting, bulk messaging, staff mobile app.

---

## Existing Foundation

- Staff web app (`apps/staff-web`) exists from F001 — Next.js, Tailwind, shadcn/ui
- Auth UI (login, invite accept, Google SSO) built in F002
- All API routes exist in F003 + F004
- Socket.io server emits real-time events (`conversation:updated`, `message:new`, `booking:pending`)

---

## 1. Conversation List Page — `/conversations`

### Layout

Left sidebar with filters; main area shows conversation cards sorted by urgency.

### Conversation card shows

- Client name + phone
- Current state badge (`AWAITING_REPLY`, `ESCALATED`, `BOOKING_PENDING_APPROVAL`, etc.)
- Last message preview + timestamp
- Staff takeover indicator if a staff member has control

### Filters

- Status: All | Needs Attention | AI Active | Staff Active | Closed
- "Needs Attention" = `ESCALATED` or `BOOKING_PENDING_APPROVAL` — shown first always

### Real-time

- Socket.io listener on `conversation:updated` — update card in-place without full reload
- New escalation: show toast + increment badge in nav

### API used

```
GET /api/v1/conversations?status=...&limit=50&before=<cursor>
```

(Existing route from F003 — confirm it returns `lastMessage` preview field; add if not present)

---

## 2. Conversation Detail Page — `/conversations/:id`

### Layout

Full-height message thread on the left; client info + appointment summary on the right.

### Message thread

- Each message: direction (`inbound` / `outbound`), sender label (`AI` / `Staff: Jane` / `Client`), body, timestamp
- Load newest 50 messages; "load earlier" button for pagination
- Real-time: Socket.io `message:new` appends to bottom

### Right panel

- Client: name, phone, email, `opted_out` status
- Current appointment (if any): service, date/time, status
- Conversation state badge

### Staff actions

| Action | Condition | API |
|---|---|---|
| Take over | AI has control | `POST /api/v1/conversations/:id/takeover` |
| Return to AI | Staff has control | `POST /api/v1/conversations/:id/return` |
| Send message | Staff has control | `POST /api/v1/conversations/:id/messages` |
| Approve booking | State = `BOOKING_PENDING_APPROVAL` | `POST /api/v1/conversations/:id/approve-booking` |
| Reject booking | State = `BOOKING_PENDING_APPROVAL` | `POST /api/v1/conversations/:id/reject-booking` |
| Close conversation | Any open state | `POST /api/v1/conversations/:id/close` |

All buttons disabled with tooltip when staff lacks permission.

### Send message input

- Shown only when staff has taken over
- Textarea + send button; Enter submits, Shift+Enter newline
- Optimistic UI: append message immediately, revert on error

---

## 3. Appointment Calendar Page — `/calendar`

### View modes

- **Day view** (default): timeline from business open to close; appointments as blocks
- **Week view**: 7-column grid, same block layout

### Appointment block shows

- Client name
- Time range
- Status color: `confirmed` (green), `pending` (yellow), `cancelled` (gray), `no_show` (red)

### Interactions

- Click appointment block → opens appointment detail drawer (see §4)
- Day/week nav arrows + "Today" button
- Staff filter dropdown (admin only): "All Staff" or select one staff member

### API used

```
GET /api/v1/appointments?from=YYYY-MM-DD&to=YYYY-MM-DD&staffUserId=...
```

(Existing route from F004 — confirm it accepts date range params)

### Real-time

Socket.io `appointment:updated` — re-fetch affected day on event

---

## 4. Appointment Detail Drawer

Slides in from the right when an appointment block is clicked.

### Shows

- Client name, phone, email
- Service, date, time, assigned staff
- Status badge
- Notes (editable inline)
- Link to the related conversation

### Staff actions

| Action | Condition | API |
|---|---|---|
| Confirm | Status = `pending` | `PATCH /api/v1/appointments/:id` `{ status: 'confirmed' }` |
| Cancel | Status = `pending` or `confirmed` | `PATCH /api/v1/appointments/:id` `{ status: 'cancelled' }` |
| Mark no-show | Status = `confirmed`, past start time | `PATCH /api/v1/appointments/:id` `{ status: 'no_show' }` |
| Reschedule | Status = `confirmed` or `pending` | Opens reschedule modal (see §5) |

---

## 5. Reschedule Modal

- Date picker + time slot selector
- Slot selector calls `GET /api/v1/schedules/:id/available-slots?date=...` and shows open slots only
- Confirm → `PATCH /api/v1/appointments/:id` `{ scheduledAt: newDatetime }`
- On success: close modal, refresh calendar, show success toast

---

## 6. Waitlist Panel — `/waitlist`

### Layout

Table of waitlisted clients sorted by `created_at` ascending (longest-waiting first).

### Row shows

- Client name + phone
- Requested service / schedule
- Wait time (e.g. "waiting 3 days")
- Notes from conversation

### Actions

| Action | API |
|---|---|
| View conversation | Link to `/conversations/:id` |
| Manually assign slot | Opens slot picker → `POST /api/v1/waitlist/:id/assign` (new route — see below) |
| Remove from waitlist | `DELETE /api/v1/waitlist/:id` (or `PATCH` to set status cancelled) |

### New route: `POST /api/v1/waitlist/:id/assign`

- **Auth:** `requireAuth`, `requireRole('admin', 'staff')` with `can_edit_schedule`
- **Body:** `{ appointmentSlotId: string }`
- **Behavior:** Promote waitlist entry → create `appointment` row (confirmed), fire confirmation message to client, remove from waitlist
- **Response:** `{ appointmentId }`

---

## 7. Navigation & Layout

### Nav items (all roles)

- Conversations (with escalation badge)
- Calendar
- Waitlist

### Nav items (admin only)

- Staff Management (existing, from F004)
- Client Management (existing, from F004)
- Settings (existing, from F004)

### Notification badge

- Red dot + count on "Conversations" nav item
- Count = open conversations in `ESCALATED` or `BOOKING_PENDING_APPROVAL` state
- Fetched on mount + updated via Socket.io

---

## 8. Real-Time Infrastructure

All real-time uses the existing Socket.io server. New rooms needed:

| Room | Who joins | Events |
|---|---|---|
| `business:{businessId}` | All staff on login | `conversation:updated`, `appointment:updated`, `booking:pending` |

Staff join the room on auth. No per-conversation rooms needed for the dashboard — broadcast to all staff in the business.

---

## State Management

Use React Query (already in staff-web from F002 auth):

- `useConversations(filters)` — paginated + socket-invalidated
- `useConversation(id)` — detail + socket-invalidated
- `useAppointments(dateRange, staffId)` — calendar data
- `useWaitlist()` — waitlist table

Avoid global state (Redux/Zustand) — React Query cache is sufficient.

---

## Phases (proposed)

| Phase | Scope |
|---|---|
| 1 | Navigation shell + conversation list page + real-time badge |
| 2 | Conversation detail page + staff take-over / send message |
| 3 | Appointment calendar (day + week view) + detail drawer |
| 4 | Waitlist panel + manual slot assignment route |

---

## Open Questions

1. Should staff see conversations from all staff members by default, or only their own? (Admin sees all, staff sees own?)
2. Is there a preferred date-picker component, or use shadcn's `Calendar`?
3. Do we need a "staff is typing" indicator in conversations, or is that scope creep?
4. Should the reschedule modal send a new AI message to the client confirming the change, or is that handled by the existing F003 reschedule flow?
