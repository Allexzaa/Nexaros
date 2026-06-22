# F009 — Client Booking Portal

**Status:** Spec Ready  
**Date:** 2026-05-06  
**Author:** Claude  

---

## Goal

Give clients a web interface to self-book, view, reschedule, and cancel their appointments without going through the AI conversation. This is the primary booking surface the AI conversation leads clients to, and allows clients to act independently without staff involvement.

---

## Scope

| Area | What |
|---|---|
| Business landing page | Branded page with service list and "Book Now" CTA |
| Slot picker | Date/time picker showing real available slots |
| Booking flow | Service select → date/time → confirm → confirmation screen |
| Client auth | Phone-number-based OTP login (no password) |
| Appointment management | View upcoming + past appointments; reschedule; cancel |
| Waitlist join | Join waitlist if no slots available |

Out of scope: payment at booking (F011), multi-service bookings, group bookings, client mobile native app.

---

## Existing Foundation

- `client-mobile` was removed from root npm workspaces — managed independently. This spec targets a **web portal** (Next.js), not a native app.
- All booking APIs exist: slot availability, appointment create, reschedule, cancel (F003/F004)
- Client sessions exist: `client_session` table with `session_token` (F002)
- F003 AI conversation can hand off to the portal via a link in the SMS

---

## New App: `apps/client-web`

Next.js 14 app with Tailwind + shadcn/ui (same stack as `apps/staff-web`). Served at a subdomain (e.g. `book.yourbusiness.com`) or path (`/book`).

No authentication complexity — clients use phone-number OTP only.

---

## 1. Client Authentication — Phone OTP

### Flow

1. Client enters phone number
2. Server sends OTP via SMS (6-digit code, 10-minute expiry)
3. Client enters OTP
4. Server issues `client_session` token (cookie, 30-day expiry)

### New routes (backend)

#### `POST /api/v1/client-auth/send-otp`
- **Body:** `{ phone: string }`
- **Behavior:**
  - Normalize phone to E.164
  - Look up or create `client` row for this phone + business
  - Generate 6-digit OTP, store hash + expiry in `client.otp_hash` + `client.otp_expires_at` (new columns)
  - Send OTP via `smsService`
  - Rate limit: max 3 requests per phone per 10 minutes
- **Response:** `{ ok: true }`

#### `POST /api/v1/client-auth/verify-otp`
- **Body:** `{ phone: string, otp: string }`
- **Behavior:**
  - Validate OTP hash + expiry
  - Clear OTP fields
  - Create or refresh `client_session` token
  - Set `HttpOnly` cookie `client_session`
- **Response:** `{ clientId, name }`

#### `POST /api/v1/client-auth/logout`
- Deletes `client_session` row, clears cookie

### New columns on `client`

```sql
ALTER TABLE client
  ADD COLUMN otp_hash        TEXT,
  ADD COLUMN otp_expires_at  TIMESTAMPTZ;
```

---

## 2. Business Landing Page — `/`

- Business name, logo (from `business.settings`), tagline
- List of services (from `schedule` table — each schedule is a service type)
- "Book Now" CTA per service → goes to slot picker
- If client is logged in: link to "My Appointments"

---

## 3. Slot Picker & Booking Flow

### Step 1 — Service Selection
- Cards for each active schedule
- Shows service name, duration (from slot length), description if set

### Step 2 — Date Picker
- Calendar component showing next 60 days
- Dates with no available slots shown as disabled
- Calls `GET /api/v1/schedules/:id/available-slots?date=YYYY-MM-DD` per selected date

### Step 3 — Time Slot Selection
- List of available time slots for the chosen date
- If no slots: "Join waitlist for this date" option

### Step 4 — Confirm
- Summary: service, date, time, business address (from settings)
- "Notes" text field (optional)
- Requires client to be logged in — if not, OTP modal appears inline before confirm
- Submit → `POST /api/v1/appointments` (existing route)

### Step 5 — Confirmation Screen
- "You're booked!" with appointment details
- Add to Calendar button (generates iCal file)
- Link to "My Appointments"
- Confirmation SMS sent automatically by F008 reminder system

### New backend route: `GET /api/v1/public/schedules`
- **Auth:** none (public)
- **Query:** `businessId` (or derived from subdomain/slug)
- **Response:** list of active schedules with name, slot duration, available date range

---

## 4. Waitlist Join (Portal)

### Step — No Slots Available Screen
- "No slots available for this date. Join the waitlist?"
- CTA → same OTP flow if not logged in
- Submit → `POST /api/v1/waitlist` (existing F003 endpoint, adapt for portal use)
- Confirmation: "You're on the waitlist. We'll text you when a slot opens."

---

## 5. My Appointments Page — `/appointments`

### Layout
- Two tabs: **Upcoming** | **Past**
- Each appointment card shows: service, date/time, status badge, actions

### Actions

| Action | Condition | Behavior |
|---|---|---|
| Reschedule | Status `confirmed`, > 24h before | Opens slot picker pre-filled with same service |
| Cancel | Status `confirmed`, > 24h before | Confirmation dialog → `PATCH /api/v1/appointments/:id { status: 'cancelled' }` |

Cancellation/reschedule window (24h) is configurable via `business.settings.client_cancel_window_hours`.

### New `business.settings` key

```json
{ "client_cancel_window_hours": 24 }
```

---

## 6. Public Business Slug

Each business needs a stable public URL. Two options:

**Option A (simpler):** `book.app.com/:businessSlug` — add `slug` column to `business` table, set on business creation  
**Option B:** Custom subdomain per business (DNS complexity, deferred)

**Decision: Option A.** Add `slug` column to `business`:

```sql
ALTER TABLE business
  ADD COLUMN slug TEXT UNIQUE NOT NULL DEFAULT gen_random_uuid()::text;
```

Admin can update slug via `PATCH /api/v1/business/settings { slug: 'my-salon' }`.

---

## 7. Business Branding Settings

### New `business.settings` keys

```json
{
  "logo_url": null,
  "tagline": null,
  "address": null,
  "booking_instructions": null,
  "client_cancel_window_hours": 24
}
```

These are set via the existing `PATCH /api/v1/business/settings` endpoint.

---

## Phases (proposed)

| Phase | Scope |
|---|---|
| 1 | `apps/client-web` scaffold + OTP auth flow + client-auth backend routes |
| 2 | Business landing page + slot picker + booking flow (steps 1–5) |
| 3 | My Appointments page (view + cancel + reschedule) |
| 4 | Waitlist join + business slug + branding settings |

---

## Open Questions

1. Should the portal be a separate Next.js app or an additional route group in `staff-web`? (Separate app recommended — different auth, different audience, could be on a different domain.)
2. Does the business want to allow guests to browse slots without logging in first, only requiring login at confirm?
3. Should "Add to Calendar" generate an iCal download or deep-link to Google Calendar?
4. Is there a need for a business-level "pause bookings" toggle (e.g. staff is on vacation)?
