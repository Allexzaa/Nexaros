# F004 — Business Operations: Settings, Staff, Clients & Schedules

**Status:** Approved  
**Date:** 2026-05-06  
**Author:** Claude  

---

## Goal

Give admins and staff the full CRUD layer to run the business day-to-day: configure settings, manage staff accounts, manage client records, and build appointment schedules. This is the operational backbone that the AI engine (F003) acts on.

---

## Scope

| Area | What | Who |
|---|---|---|
| Business Settings | GET + PATCH `/business/settings` (stub → real) | Admin only |
| Staff Management | Role change, soft-delete (invite already done in F002) | Admin only |
| Client Management | List, create + invite, detail, edit | Admin + Staff |
| Schedule Management | List, create, detail, add/remove appointment slots, edit | Admin + Staff with `can_edit_schedule` |

Out of scope: calendar import (Google/Outlook), billing/plan management, multi-business support.

---

## Already Implemented — Do Not Re-implement

The following are **real, working code** from F002:

- `POST /api/v1/staff/invite` — creates `staff_user` row with `invite_token_hash` + `invite_token_expires_at` on the `staff_user` table (migration `20260505000013`); sends invite email; returns `{ staffId }`
- `POST /api/v1/auth/accept-invite` — validates token, sets password, clears token fields
- `GET /api/v1/staff` — lists all staff for business (admin only)
- `PATCH /api/v1/staff/:id/permissions` — updates `can_trigger_outreach`, `can_edit_schedule`
- `POST /api/v1/schedules/:id/outreach` — triggers AI outreach (F003)

---

## 1. Business Settings

### `GET /api/v1/business/settings` — new endpoint
- **Auth:** `requireAuth` (any role)
- **Response:**

```json
{
  "name": "Test Salon",
  "settings": {
    "outreach_response_window_hours": 24,
    "outreach_hours_start": "09:00",
    "outreach_hours_end": "18:00",
    "auto_pickup_interval_minutes": 5,
    "escalation_keywords": [],
    "booking_approval_timeout_hours": 2
  }
}
```

### `PATCH /api/v1/business/settings` — stub → real
- **Auth:** `requireAuth`, `requireRole('admin')`
- **Body:** partial object — any subset of the fields above, including `name`
- **Validation:**
  - `outreach_response_window_hours`: integer 1–168
  - `outreach_hours_start` / `outreach_hours_end`: `HH:MM` 24h format; start must be before end
  - `auto_pickup_interval_minutes`: integer 1–60
  - `escalation_keywords`: array of non-empty strings, max 50 items
  - `booking_approval_timeout_hours`: integer 1–48
  - `name`: non-empty string, max 100 chars
- **Behavior:** UPDATE `business.name` (if provided) and merge-patch `business.settings` via `jsonb_strip_nulls($1::jsonb || settings)` pattern — partial update, not full replace
- **Response:** `{ ok: true }`

---

## 2. Staff Management

### `PATCH /api/v1/staff/:id/role` — new
- **Auth:** `requireAuth`, `requireRole('admin')`
- **Body:** `{ role: 'admin' | 'staff' | 'viewer' }`
- **Rules:**
  - Cannot change own role
  - Setting role to `'viewer'` clears permissions: set `can_trigger_outreach = false`, `can_edit_schedule = false`
- **Response:** `{ ok: true }`

### `DELETE /api/v1/staff/:id` — new (soft-delete)
- **Auth:** `requireAuth`, `requireRole('admin')`
- **Rules:**
  - Cannot deactivate self
  - Cannot deactivate a user who is not in the same business
- **Behavior:**
  1. Set `role = 'deactivated'` on `staff_user`
  2. Clear `refresh_token_hash` and `refresh_token_expires_at` (invalidates active sessions immediately)
  3. Clear `invite_token_hash` and `invite_token_expires_at` (cancels any pending invite)
- **Response:** `{ ok: true }`
- **Migration needed:** add `'deactivated'` to the `staff_user.role` check constraint

---

## 3. Client Management

### `GET /api/v1/clients` — new
- **Auth:** `requireAuth` (any role)
- **Query params:** `limit` (default 50, max 100), `offset` (default 0), `search` (optional — case-insensitive partial match on name OR email)
- **Response:**
```json
{
  "data": [
    {
      "id": "...", "name": "Alice", "phone": "+1...", "email": "alice@...",
      "app_registered": true, "opted_out": false, "created_at": "..."
    }
  ],
  "limit": 50, "offset": 0
}
```

### `POST /api/v1/clients` — new
- **Auth:** `requireAuth` (any role)
- **Body:** `{ name: string, phone?: string, email?: string }`
- **Validation:** `name` required (non-empty, max 100 chars); at least one of `phone` or `email` required; email valid format if provided
- **Deduplication:** if a client with the same `name` + `email` already exists for this business → 409 `{ code: 'CLIENT_EXISTS', clientId }`
- **Behavior:**
  1. Insert `client` row
  2. Generate 6-char uppercase hex short code; insert `client_invite` row (`expires_at = now()+48h`)
  3. If `email` provided: send invite email via `sendClientInvite(email, inviteUrl)`
  4. Return `{ clientId, shortCode }` — short code is always returned so staff can relay it if no email
- **Note:** short code is the client's entry point to the mobile app — same mechanism as F002/F003

### `GET /api/v1/clients/:id` — new
- **Auth:** `requireAuth` (any role)
- **Response:** client fields + last 5 appointments (ordered by `starts_at DESC`)
```json
{
  "id": "...", "name": "...", "phone": "...", "email": "...",
  "app_registered": true, "opted_out": false, "created_at": "...",
  "appointments": [
    { "id": "...", "starts_at": "...", "service_type": "Haircut", "status": "confirmed" }
  ]
}
```

### `PATCH /api/v1/clients/:id` — new
- **Auth:** `requireAuth` (any role)
- **Body:** any subset of `{ name, phone, email, opted_out }`
- **Rules:** setting `opted_out = true` must also cancel all active (non-terminal) AI conversations for this client by updating their state to `'cancelled'` directly via DB (no StateEngine — bulk cancellation, no events emitted)
- **Terminal states (do not cancel):** `confirmed`, `cancelled`, `resolved`, `no_response`
- **Response:** `{ ok: true }`

---

## 4. Schedule & Appointment Management

### `GET /api/v1/schedules` — stub → real
- **Auth:** `requireAuth` (any role)
- **Query:** `limit` (default 20, max 100), `offset` (default 0)
- **Response:**
```json
{
  "data": [
    { "id": "...", "date": "2026-07-01", "appointment_count": 8, "created_at": "..." }
  ],
  "limit": 20, "offset": 0
}
```

### `POST /api/v1/schedules` — stub → real
- **Auth:** `requireAuth`, `requirePermission('canEditSchedule')`
- **Body:** `{ date: string }` — ISO date `YYYY-MM-DD`
- **Validation:** date must not be in the past (compared in PST — `America/Los_Angeles`); no duplicate schedule for same `business_id + date`
- **Behavior:** insert schedule with `created_by = req.staff.id`
- **Response:** `{ id, date, created_at }`

### `GET /api/v1/schedules/:id` — stub → real
- **Auth:** `requireAuth` (any role)
- **Response:** schedule + all appointments, with client name where assigned
```json
{
  "id": "...", "date": "2026-07-01", "created_at": "...",
  "appointments": [
    {
      "id": "...", "starts_at": "2026-07-01T10:00:00Z", "service_type": "Haircut",
      "status": "available", "client_id": null, "client_name": null
    }
  ]
}
```

### `POST /api/v1/schedules/:id/appointments` — new
- **Auth:** `requireAuth`, `requirePermission('canEditSchedule')`
- **Body:** `{ starts_at: string (ISO datetime), service_type?: string, client_id?: string }`
- **Validation:**
  - `starts_at` must be in the future (PST)
  - `starts_at` must fall on the same calendar date as the schedule's `date` field (compared in PST / `America/Los_Angeles`)
  - If `client_id` provided, client must belong to same business
- **Behavior:** insert appointment with `status = 'available'` (or `'pending-outreach'` if `client_id` is provided)
- **Response:** `{ id, starts_at, service_type, status, client_id }`

### `DELETE /api/v1/schedules/:id/appointments/:apptId` — new
- **Auth:** `requireAuth`, `requirePermission('canEditSchedule')`
- **Rules:** only deletable if `status = 'available'`; return 409 with `{ code: 'APPOINTMENT_ACTIVE' }` if any other status
- **Response:** `{ ok: true }`

### `PUT /api/v1/appointments/:id` — stub → real
- **Auth:** `requireAuth`, `requirePermission('canEditSchedule')`
- **Body:** any subset of `{ starts_at, service_type, client_id }` (client_id may be null to un-assign)
- **Rules:** can only update if `status = 'available'` or `'pending-outreach'`; return 409 otherwise
- **Behavior:**
  - Setting `client_id` to a non-null value → `status = 'pending-outreach'`
  - Setting `client_id = null` → `status = 'available'`
  - Updating `starts_at` only (no client change) → no status change
- **Response:** `{ ok: true }`

---

## Data Model Additions

### Migration: add `'deactivated'` to `staff_user.role` check constraint
```sql
ALTER TABLE staff_user DROP CONSTRAINT staff_user_role_check;
ALTER TABLE staff_user ADD CONSTRAINT staff_user_role_check
  CHECK (role IN ('admin', 'staff', 'viewer', 'deactivated'));
```

No new tables needed — the invite mechanism already lives on `staff_user` (F002).

---

## Phases

### Phase 1 — Business Settings + Staff Role/Deactivate
- `GET /business/settings` (new)
- `PATCH /business/settings` (stub → real)
- `PATCH /staff/:id/role` (new)
- `DELETE /staff/:id` (soft-delete, new)
- Migration: add `'deactivated'` to `staff_user.role`
- Tests: `src/__tests__/businessSettings.test.ts`, `src/__tests__/staffManagement.test.ts`

### Phase 2 — Client Management
- `GET /clients`, `POST /clients`, `GET /clients/:id`, `PATCH /clients/:id`
- Opt-out bulk conversation cancel
- Tests: `src/__tests__/clientManagement.test.ts`

### Phase 3 — Schedule & Appointment Management
- `GET /schedules`, `POST /schedules`, `GET /schedules/:id` (stubs → real)
- `POST /schedules/:id/appointments` (new)
- `DELETE /schedules/:id/appointments/:apptId` (new)
- `PUT /appointments/:id` (stub → real)
- Tests: `src/__tests__/scheduleManagement.test.ts`

**Phase dependencies:** all three phases are independent. Phases 2 and 3 can be built in parallel.

---

## Resolved Decisions

1. **Staff invite storage:** F002 already implemented invite token storage directly on `staff_user` (`invite_token_hash`, `invite_token_expires_at`). No new table needed. `DELETE /staff/:id` clears these columns.
2. **Timezone:** PST (`America/Los_Angeles`) for all date comparisons (schedule date validation, `starts_at` validation).
3. **Client deduplication:** `name + email` uniqueness within the business (409 on match).
