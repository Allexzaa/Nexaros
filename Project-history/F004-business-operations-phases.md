# F004 — Business Operations: Phases

**Spec:** [F004-business-operations-spec.md](F004-business-operations-spec.md)

---

## Phase 1 — Business Settings + Staff Role/Deactivate

**Goal:** Admin can read/update business settings and manage staff roles and deactivation.

**Deliverables:**
- `GET /api/v1/business/settings` — new
- `PATCH /api/v1/business/settings` — stub → real (JSONB merge-patch)
- `PATCH /api/v1/staff/:id/role` — new; viewer role clears permissions; cannot change own role
- `DELETE /api/v1/staff/:id` — soft-delete: role=deactivated, clear tokens; cannot deactivate self
- Login route guard: reject login if `role = 'deactivated'`
- Migration: add `'deactivated'` to `staff_user.role` check constraint
- Tests: `businessSettings.test.ts`, `staffManagement.test.ts`

**Done when:** All tests pass; `npx tsc --noEmit` clean.

---

## Phase 2 — Client Management

**Goal:** Staff can create, view, and manage client records.

**Deliverables:**
- `GET /api/v1/clients` — list with optional search
- `POST /api/v1/clients` — create + invite (name+email dedup)
- `GET /api/v1/clients/:id` — detail + last 5 appointments
- `PATCH /api/v1/clients/:id` — edit; opted_out=true cancels active conversations
- Tests: `clientManagement.test.ts`

**Done when:** All tests pass; TypeScript clean.

---

## Phase 3 — Schedule & Appointment Management

**Goal:** Staff can build and manage appointment schedules.

**Deliverables:**
- `GET /api/v1/schedules` — stub → real (with appointment count)
- `POST /api/v1/schedules` — stub → real (PST date validation, no duplicate)
- `GET /api/v1/schedules/:id` — stub → real (with appointments + client names)
- `POST /api/v1/schedules/:id/appointments` — new (PST date match validation)
- `DELETE /api/v1/schedules/:id/appointments/:apptId` — new (available-only guard)
- `PUT /api/v1/appointments/:id` — stub → real (status auto-update on client_id change)
- Tests: `scheduleManagement.test.ts`

**Done when:** All tests pass; TypeScript clean.

---

## Phase Summary

| Phase | Name | Depends On |
|---|---|---|
| 1 | Business Settings + Staff Role/Deactivate | F002 complete |
| 2 | Client Management | Phase 1 (none technically, but logical order) |
| 3 | Schedule & Appointment Management | F003 complete (outreach already wired) |

Phases 2 and 3 are independent and can be built in parallel.
