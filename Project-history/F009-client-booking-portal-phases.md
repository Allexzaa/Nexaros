# F009 — Client Booking Portal: Phases

**Spec:** [F009-client-booking-portal-spec.md](F009-client-booking-portal-spec.md)  
**Depends on:** F001–F004 complete · F007 staff web live  
**Total phases:** 4  

---

## Overview

A separate Next.js web app (`apps/client-web`) served alongside the staff web. Clients access it via a public URL (`/book/:slug`), browse available slots, log in with their phone number (OTP), and book or manage appointments — all without staff involvement.

**Stack:** Next.js 14 (App Router) · Tailwind CSS · same API backend (port 3001) · Vite proxy for dev

---

## Phase 1 — App Scaffold + OTP Auth + Backend Routes

**Goal:** A running Next.js app that a client can reach at `http://localhost:3002`, enter their phone number, receive an OTP (console-logged in dev), and land on a logged-in home screen.

### Backend deliverables

#### New DB migration
```sql
ALTER TABLE client
  ADD COLUMN otp_hash       TEXT,
  ADD COLUMN otp_expires_at TIMESTAMPTZ;

ALTER TABLE business
  ADD COLUMN slug TEXT UNIQUE;

UPDATE business SET slug = LOWER(REPLACE(name, ' ', '-')) || '-' || SUBSTRING(id::text, 1, 6)
  WHERE slug IS NULL;

ALTER TABLE business ALTER COLUMN slug SET NOT NULL;
```

#### `POST /api/v1/client-auth/send-otp`
- **Auth:** none
- **Body:** `{ phone: string, businessSlug: string }`
- **Behavior:**
  - Normalize phone to E.164
  - Look up business by `slug` — 404 if not found
  - Look up or create `client` row for `phone + business_id`
  - Check `opted_out` — if true, return 403
  - Rate limit: max 3 OTP requests per phone per 10 minutes (Redis key `otp:rate:{phone}`)
  - Generate 6-digit code, store `bcrypt(code)` as `otp_hash`, set `otp_expires_at = NOW() + 10 min`
  - Dev: console-log the OTP; prod: send via SMS (F005)
- **Response:** `{ ok: true }`

#### `POST /api/v1/client-auth/verify-otp`
- **Auth:** none
- **Body:** `{ phone: string, businessSlug: string, otp: string }`
- **Behavior:**
  - Look up client by phone + business slug
  - Validate `otp_hash` match + `otp_expires_at > NOW()`
  - Clear OTP fields
  - Create `client_session` row (`token`, `expires_at = NOW() + 30 days`)
  - Set `HttpOnly; SameSite=Strict` cookie `client_session`
- **Response:** `{ clientId, name }`

#### `POST /api/v1/client-auth/logout`
- **Auth:** client session cookie
- **Behavior:** delete `client_session` row, clear cookie
- **Response:** `{ ok: true }`

#### `GET /api/v1/public/business/:slug`
- **Auth:** none
- **Response:** `{ name, settings: { tagline, address, booking_instructions } }`
- Used by the landing page to display business branding

### Frontend deliverables (`apps/client-web`)

- **Scaffold:** `npx create-next-app@14 apps/client-web` with Tailwind
- **Vite/Next dev port:** 3002
- **`/[slug]` route** — public landing page skeleton (business name + "Book Now" placeholder)
- **`/[slug]/login` route** — phone entry → OTP code entry → redirects to `/[slug]`
- **Auth context** — reads `client_session` cookie, exposes `client` object + `logout()`
- **API client** — thin `fetch` wrapper scoped to `/api/v1`, attaches cookie automatically

**Done when:** Client can navigate to `http://localhost:3002/test-office`, enter a valid phone number, see the OTP in the backend terminal, enter it, and land on the home page showing "Test Office".

---

## Phase 2 — Business Landing Page + Slot Picker + Booking Flow

**Goal:** A client can complete a full booking from the landing page to the confirmation screen.

### Backend deliverables

#### `GET /api/v1/public/schedules`
- **Auth:** none
- **Query:** `businessSlug`
- **Response:** list of distinct `service_type` values from future available slots — these are the "services" the client can book
  ```json
  { "services": ["Haircut", "Color Treatment", "Blowout"] }
  ```

#### `GET /api/v1/public/slots`
- **Auth:** none
- **Query:** `businessSlug`, `serviceType` (optional), `date` (YYYY-MM-DD)
- **Response:** all `available` appointment slots for that date
  ```json
  { "slots": [{ "id": "uuid", "starts_at": "...", "service_type": "Haircut" }] }
  ```

#### `POST /api/v1/client/appointments`
- **Auth:** client session cookie
- **Body:** `{ slotId: string, notes?: string }`
- **Behavior:**
  - Validate slot is still `available`
  - Update `appointment`: `status = 'confirmed'`, `client_id = session.clientId`
  - Create `conversation` row in `confirmed` state
  - Return appointment details
- **Response:** `{ appointmentId, startsAt, serviceType }`

### Frontend deliverables

- **`/[slug]` — Landing page**
  - Business name, tagline, address from settings
  - Service cards — one per distinct service type
  - "Book Now" on each card → goes to slot picker for that service
  - If logged in: "My Appointments" link in header

- **`/[slug]/book` — Slot picker**
  - Step 1: Service selection (if not pre-selected from landing)
  - Step 2: Date picker — calendar grid showing only dates that have at least one `available` slot (queried from DB); dates with no slots are hidden or disabled. Natural language shortcut ("early next week") resolves via `timeParser` + `findSlotsForDate`.
  - Step 3: Time slot list for selected date — each slot shows time + service
  - Step 4: Confirm screen — summary of booking, optional notes field, "Confirm Booking" button
    - If not logged in: OTP modal slides in inline
  - Step 5: Confirmation screen — "You're booked!", appointment details, two calendar buttons: **Download .ics** (works with any calendar app) and **Add to Google Calendar** (opens Google Calendar pre-filled with event details — no backend needed, generated client-side)

**Done when:** A client can pick a service, choose a date and time slot, log in via OTP if needed, confirm, and see the confirmation screen. The appointment appears as `confirmed` in the staff dashboard.

---

## Phase 3 — My Appointments (View + Cancel + Reschedule)

**Goal:** Logged-in clients can see all their appointments and manage upcoming ones.

### Backend deliverables

#### `GET /api/v1/client/appointments`
- **Auth:** client session cookie
- **Query:** `status=upcoming|past` (optional)
- **Response:** client's appointments scoped to this business, ordered by `starts_at DESC`
  ```json
  { "data": [{ "id": "...", "starts_at": "...", "service_type": "Haircut", "status": "confirmed" }] }
  ```

#### `PATCH /api/v1/client/appointments/:id/cancel`
- **Auth:** client session cookie
- **Rules:**
  - Appointment must belong to this client + business
  - Status must be `confirmed`
  - `starts_at - NOW() > client_cancel_window_hours` (from `business.settings`, default 24h)
- **Behavior:** set `status = 'cancelled'`; update conversation state if exists
- **Response:** `{ ok: true }`

#### `GET /api/v1/client/appointments/:id/reschedule-slots`
- **Auth:** client session cookie
- **Query:** `date` (YYYY-MM-DD)
- **Response:** available slots for the same service type on the given date (excluding original slot)

#### `PATCH /api/v1/client/appointments/:id/reschedule`
- **Auth:** client session cookie
- **Body:** `{ newSlotId: string }`
- **Rules:** same cancellation window applies
- **Behavior:** cancel original slot (set `available`), confirm new slot
- **Response:** `{ appointmentId, startsAt }`

### Frontend deliverables

- **`/[slug]/appointments` — My Appointments**
  - Tabs: Upcoming | Past
  - Each card: service, formatted date/time, status badge
  - **Cancel** button — confirmation modal → calls cancel API → card updates
  - **Reschedule** button → opens date picker → time slot list → confirm → updates card

**Done when:** A logged-in client can view all their appointments, cancel an upcoming one within the window, and reschedule to a new time.

---

## Phase 4 — Waitlist Join + Business Slug + Branding Settings

**Goal:** Clients can join the waitlist when no slots are available, businesses have a stable shareable URL, and admins can set basic branding from the settings page.

### Backend deliverables

#### `POST /api/v1/client/waitlist`
- **Auth:** client session cookie
- **Body:** `{ serviceType?: string, preferences?: string }`
- **Behavior:** insert `waitlist_entry` row; return `{ waitlistId }`
- **Response:** `{ ok: true }`

#### `PATCH /api/v1/business/settings` — extend with new keys
- `slug`: URL-safe string, unique across businesses, max 60 chars
- `logo_url`: string or null
- `tagline`: string or null, max 200 chars
- `address`: string or null
- `booking_instructions`: string or null, max 500 chars
- `client_cancel_window_hours`: integer 1–168
- `bookings_paused`: boolean (default false) — when true, client portal shows a pause message and disables new bookings

### Frontend deliverables

- **Waitlist join** — shown on date picker when no slots exist for selected date
  - "No availability for this date. Join the waitlist?" CTA
  - One-tap join (OTP modal if not logged in)
  - Confirmation: "You're on the waitlist. We'll text you when something opens up."

- **Branding on landing page** — display `logo_url`, `tagline`, `address`, `booking_instructions` from settings

- **Staff Settings page** — add branding fields (logo URL, tagline, address, booking instructions, cancel window, slug, **pause bookings toggle**) to the existing Settings page in `apps/staff-web`
- **Pause bookings** — when enabled: client portal shows "We're not accepting new bookings right now — check back soon" and the booking flow is disabled; existing confirmed appointments unaffected

**Done when:** A client can join the waitlist from the booking flow; the admin can set a custom slug (`/test-office`) and branding fields; the landing page reflects those changes.

---

## Phase Summary

| Phase | Name | Key output |
|---|---|---|
| 1 | Scaffold + OTP Auth | Running app, client can log in at `localhost:3002/[slug]` |
| 2 | Landing + Slot Picker + Booking | Full booking flow end-to-end |
| 3 | My Appointments | View, cancel, reschedule |
| 4 | Waitlist + Slug + Branding | Shareable URL, waitlist, admin branding |

**Phase dependencies:** 1 → 2 → 3 (sequential). Phase 4 is mostly independent and can overlap with Phase 3.

---

## Decisions Made

1. **Separate Next.js app** (`apps/client-web`) — different auth, different audience, could be on a different domain later
2. **Phone OTP only** — no passwords, no email magic links; simplest friction-free auth for clients
3. **Guest browsing allowed** — clients can browse services and dates without logging in; OTP appears inline at the Confirm step
4. **Slug-based routing** — `/:slug/` so multiple businesses can share one deployment
5. **OTP console-logged in dev** — no Twilio needed to test; real SMS delivery is F005

## Resolved Decisions

1. **Slot picker date range** — use actual schedule dates from the DB, not a fixed 60-day window. The date picker shows only dates that have at least one `available` slot. Natural language input ("early next week", "any morning next month") uses the same `timeParser` + `findSlotsForDate` logic already built for the AI conversation flow.

2. **Add to Calendar** — both: a `.ics` file download (works for any calendar app) AND a Google Calendar deep-link (pre-fills event details in a browser tab). Both generated client-side from the appointment data — no backend needed.

3. **Pause bookings toggle** — yes. Admins can enable "vacation mode" from the Settings page. When enabled, the client booking portal shows a message ("We're not accepting new bookings right now — check back soon") and the Book Now flow is disabled. New `business.settings` key: `bookings_paused: boolean`. Existing confirmed appointments are unaffected.
