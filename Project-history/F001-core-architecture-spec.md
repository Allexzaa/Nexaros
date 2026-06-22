# F001 — Core System Architecture — Spec

**Feature code:** F001
**Slug:** core-architecture
**Status:** Approved
**Created:** 2026-05-05
**Approved:** 2026-05-05
**Phases file:** [F001-core-architecture-phases.md](F001-core-architecture-phases.md)
**Review:** [F001-core-architecture-review.md](F001-core-architecture-review.md)
**Spawned specs:** [F002 — Auth](F002-auth-spec.md) · [F003 — AI State Machine](F003-ai-conversation-state-machine-spec.md) · F004 — Business Onboarding (not yet written)

---

## Problem

The AI Scheduler is a two-sided platform — offices manage schedules and trigger AI outreach; clients receive and respond to AI messages via a native mobile app. The platform is designed for any appointment-based business (salons, clinics, gyms, consultants, etc.) — generic by design, with free-text service types and no vertical-specific compliance in V1. Before any feature is built, the overall system structure, component relationships, data flow, and technology choices must be defined so that all future features are built consistently and without rework.

## Proposed Approach

A service-oriented backend exposes a single API consumed by both the staff web app and the client mobile app. An AI Conversation Engine sits alongside the backend, powered by an LLM, and handles all client-facing messaging. Real-time delivery uses WebSockets with push notifications as the fallback. The database is the single source of truth for schedule state.

## Architecture

### Components

```
┌─────────────────────────────────────────────────────────┐
│                      STAFF SIDE                         │
│              Web Browser App (React)                    │
│   Schedule Builder · Slot Manager · Conversation View   │
└──────────────┬──────────────────────────┬───────────────┘
               │ HTTPS / REST             │ WebSocket ↕
               ▼                          ▼
┌──────────────────────────────┐   ┌────────────────────────────┐
│          BACKEND API         │   │       Real-time Layer      │
│  (Node.js / TypeScript)      │──►│      (WebSocket Server)    │
│                              │   │  /staff/{business_id}      │
│  Auth · Schedules            │   │  /client/{client_id}       │
│  Appointments · Conversations│   └────────────┬───────────────┘
│  Slot Management             │                │ WebSocket ↕
│  Outreach Trigger            │                │ + Push Notifications
└───┬──────────────────────────┘                ▼
    │                              ┌────────────────────────────┐
    ├──► Database (PostgreSQL)     │         CLIENT SIDE        │
    │                              │   Native Mobile App        │
    ├──► AI Engine (LLM-powered)   │   (React Native)           │
    │    Ollama (dev) → provider   │   Chat UI · Push Alerts    │
    │    abstraction layer         │   Account Setup            │
    │    sends via Backend         └────────────────────────────┘
    │    ──► Real-time Layer
    │
    └──► Calendar Sync Service
         (Google + Outlook)
```

### Data Flow — Core Scheduling Loop

1. Staff logs in to web app → manually builds schedule (client name, phone number, appointment time)
2. Staff marks specific slots as **Available** (AI can offer these as alternatives)
3. Staff clicks **Trigger Outreach** → backend queues outreach jobs for each client
4. Backend checks `app_registered` flag on each Client record:
   - `false` (new client) → send one-time email (SendGrid) containing a universal link: `https://app.[domain]/redeem?code=XXXXXX`
   - `true` (returning client) → skip onboarding, proceed directly to step 6
5. Client opens the universal link:
   - **Mobile, app installed:** opens app directly to Short Code screen with code pre-filled → one tap to redeem
   - **Mobile, app not installed:** redirects to App Store (iOS) or Google Play (Android) → after install, deferred deep link opens Short Code screen with code pre-filled
   - **Desktop:** static landing page — "Please open this link on your mobile device" with the code shown in large text
   - On successful redemption: `ClientInvite.used_at` set, `Client.app_registered` set to `true`, long-lived JWT issued
6. AI Conversation Engine initiates a real conversation with each client via the app
7. Messages delivered in real-time via WebSocket; push notification wakes the app if closed
8. Client responds → AI reads response via LLM, determines intent (confirm / can't make it / question)
9. If confirming → AI locks the slot in the database, sends confirmation message
10. If can't make it → AI presents available slots (staff-approved only), client picks one
11. New slot booked → old slot freed back to available pool
12. All messages logged per client in the database — staff can read any thread, take over any time

### No-Response Follow-Up Schedule

If a client does not respond, the Job Scheduler fires three follow-ups before the office-set deadline:

| Trigger | Message intent |
|---|---|
| T+5 min after initial message | "We only have until [deadline]. After that, your slot goes to someone else." |
| T+1 hour after first follow-up | "Following up — we're getting close. Do you want to confirm?" |
| T−5 min before deadline | "Last chance — 5 minutes left. After [deadline] your slot is released." |
| Deadline reached, no response | Slot status → `available`. Waitlist check triggered. Staff notified. |

The deadline window is office-configurable via `Business.settings.outreach_response_window_hours` (default: 2 hours).

**Cancellation rule:** If the client responds at any point, the Job Scheduler cancels all pending follow-up jobs for that conversation immediately. Follow-up jobs are keyed by `conversation_id` to enable targeted cancellation.

### Waitlist Flow

When a client cannot be scheduled (no available slots match their needs):
1. AI informs them no slots are currently available
2. AI asks: "What days or times generally work for you? I'll reach out as soon as something opens up."
3. Client states preferences → stored as a WaitlistEntry
4. When a slot is released (deadline missed or client cancels):
   - AI checks the waitlist in order (first in, first served)
   - For each entry: LLM checks if the open slot matches that person's stated preferences
   - First match → AI reaches out with a **fixed 30-minute response window**:
     - **T+0 (slot offer):** "A slot just opened at [time]. If we don't hear back within 30 minutes it will be assigned to someone else."
     - **T+25 min (reminder):** "5 minutes left — are you confirming this slot or not?"
   - Client replies **Yes** → booked, WaitlistEntry marked `scheduled`
   - Client replies **No** → AI moves to next person on the list immediately
   - **No response at T+30 min** → AI moves to next person on the list
   - Reminder job is keyed by `conversation_id` and cancelled if client replies before T+25 min

### Client-Initiated Booking Flow

Registered clients (already in the system) can message the office directly through the app to request an appointment. The AI handles the request within the client's existing persistent conversation thread.

1. Client sends a message requesting an appointment (e.g. "I'd like to book a general dentist appointment")
2. AI asks for any missing details (service type, preferred time)
3. AI searches for pre-existing available slots (Appointment rows with status=`available` and client_id=null) matching the request. **The AI never creates Schedule or Appointment records** — staff are solely responsible for creating schedules and marking slots available.
4. AI evaluates confidence on the match:
   - **Confident** (routine request, known service type, available slot found) → AI presents the slot, books on confirmation — no staff notification
   - **Uncertain** (unusual request, ambiguous service, or no clear match) → AI sends staff a notification: "Client [name] has requested [appointment type] — please approve or reject." AI immediately sends client a holding message: "I've passed your request to the office for review. I'll get back to you as soon as they confirm — usually within a couple of hours." Conversation moves to `awaiting_approval` state. Any client follow-up messages during the wait receive: "We're still waiting on confirmation from the office — I'll update you shortly." Terminal conditions:
     - **Staff approves within window:** AI finds available slot and presents it to client
     - **Staff rejects:** AI sends "Unfortunately the office isn't able to accommodate that request. Let me check what's available for you." — then checks slots or adds to waitlist
     - **Timeout (no staff response after `booking_approval_timeout_hours`):** Same outcome as rejection
     - Approval-wait job is keyed by `conversation_id` and cancelled if staff responds before timeout
   - **No available slots** → AI informs client, asks for preferences, adds to waitlist
5. Once a slot is confirmed, it is booked. AI write permissions are limited to: updating `Appointment.status`, `Appointment.client_id`, `Appointment.service_type` (AI writes the value it captured from the client's message), and Conversation state. AI never creates Schedule or Appointment records.
6. **Concurrency protection:** All slot-claiming writes use a conditional UPDATE: `UPDATE Appointment SET status='confirmed', client_id=? WHERE id=? AND status='ai-active' AND client_id IS NULL`. If 0 rows affected, the slot was taken concurrently — AI informs client and offers alternatives or waitlist.
7. Only one booking request is active at a time within the thread. If a client starts a second request while one is in progress, the AI acknowledges it and finishes the current booking first: "Once we finish your current booking, I'll help you with that."

### Key Modules

| Module | Responsibility |
|---|---|
| Auth Service | Staff login (email/password + Google SSO); three roles (Admin, Staff, Viewer); client login via short code redemption → long-lived JWT. Full auth model defined in [F002-auth-spec.md](F002-auth-spec.md) |
| Schedule Manager | CRUD for schedules, appointments, clients |
| Slot Manager | Tracks available vs. booked slots; enforces AI offer rules |
| AI Engine | LLM integration, conversation state per client, intent detection, schedule writes; full state machine (13 states, transitions, escalation rules) defined in [F003-ai-conversation-state-machine-spec.md](F003-ai-conversation-state-machine-spec.md). Uses Ollama for dev/testing; production provider TBD. Built against a provider abstraction layer (base URL + API key in config) so switching providers requires no code changes. F003 update required to add client-initiated booking path. |
| Conversation Logger | Stores every message per client thread; exposes to staff view |
| Real-time Layer | WebSocket server for live message delivery. **Authentication:** the WebSocket upgrade request must include `Authorization: Bearer <token>` in HTTP headers. Server validates the JWT on the handshake — connections with missing or invalid tokens are rejected with 401. All messages use the envelope: `{ "event": "<event_type>", "payload": { ... } }`. Event schema below. |
| Push Notification Service | FCM (covers both iOS and Android via Firebase). On client app launch: upsert device token into DeviceToken table by (client_id, platform). On logout: delete token. When sending a push: query `DeviceToken WHERE client_id = ?` to get all active tokens for that client. |
| Calendar Sync | Google Calendar API + Microsoft Graph API import |
| First Contact Bootstrap | One-time email (SendGrid) for new client onboarding — V1. SMS via Twilio deferred to next phase. |
| Job Scheduler | Background queue (Bull) for time-based events: follow-up messages, deadline monitors, waitlist triggers, waitlist reminder jobs; auto-pickup watcher scans for unprocessed appointments every 5 minutes (respects office outreach hours window). All follow-up and reminder jobs are keyed by `conversation_id` and cancelled immediately on client reply. Concurrency ceiling: `BULL_CONCURRENCY` env var (default 10) — max concurrent LLM jobs at any time; tuned per production provider's rate limits. |
| Staff Dashboard | Real-time conversation overview with color-coded status; surfaces conversations needing attention |
| Staff Alert System | In-app notifications to staff triggered by: (1) client explicitly requests a human, (2) ambiguous client message on 2nd consecutive occurrence, (3) off-topic message on 2nd consecutive occurrence, (4) distress keyword detected, (5) LLM API failure, (6) deadline missed, (7) slot released, (8) appointment confirmed by client, (9) client booking request needs approval — see F003 for full escalation rules |

### WebSocket Event Schema

All WebSocket messages use the envelope: `{ "event": "<event_type>", "payload": { ... } }`

| Event | Channel | Payload |
|---|---|---|
| `new_message` | Both | `{ conversation_id, message: { id, sender, content, timestamp } }` |
| `conversation_state_changed` | Staff | `{ conversation_id, state, client_name }` |
| `staff_alert` | Staff | `{ alert_type, conversation_id, client_name, reason }` |
| `appointment_confirmed` | Staff | `{ appointment_id, client_name, time, service_type }` |
| `booking_approval_requested` | Staff | `{ conversation_id, client_name, service_type, preferred_time }` |
| `message_delivered` | Client | `{ message_id }` — server acknowledgement of outgoing message |
| `takeover_started` | Client | `{ conversation_id }` — triggers "Office" sender label in chat UI |

### Staff Web App — Scope

The staff web app targets **desktop browsers only** in V1. On screens narrower than 768px, a banner is shown: "Please use a desktop browser for the best experience." Mobile browser support is deferred to a future phase.

### Staff Web App — Pages

| Page | Route | Purpose | Key Actions |
|---|---|---|---|
| Login | `/login` | Staff sign-in | Email/password login, Google SSO, forgot password |
| Dashboard | `/` | Live conversation overview, color-coded by status | Take over conversation, view thread, acknowledge alerts |
| Schedule Builder | `/schedules` | List and create daily schedules | Create new schedule, view existing |
| Schedule Detail | `/schedules/:id` | View/edit one schedule; trigger outreach | Add/edit/remove appointments, assign clients, edit service_type (requires can_edit_schedule; change logged as system note), trigger outreach |
| Conversation View | `/conversations/:id` | Full message thread for one client | Send message, take over, return to AI |
| Clients | `/clients` | Client list for this business | Add client, view history, opt out, resend invite |
| Client Detail | `/clients/:id` | One client's profile and appointment history | Edit details, opt out, expire session, resend invite (disabled if `app_registered = true` — use Expire Session for force re-registration instead) |
| Settings | `/settings` | Business settings (Admin only) | Edit outreach hours, escalation keywords, response window |
| Staff Management | `/staff` | Manage staff accounts (Admin only) | Invite staff, assign roles/permissions, remove staff |
| Approve Booking | `/bookings/pending` | Client-initiated booking requests awaiting approval | Approve or reject each request — **Admin and Staff with `can_edit_schedule` only**; Viewer and Staff without permission see page read-only with buttons disabled; nav item hidden for Viewers |

**Resend invite lifecycle:** When staff triggers "resend invite" — all existing `ClientInvite` rows for that client are marked `used_at = now()` before a new row is created (only one active invite at a time). A fresh `ClientInvite` row is generated with a new `short_code` and a new 48-hour `expires_at`. New universal link emailed via SendGrid. Resend button is disabled when `app_registered = true` — staff must use "Expire Session" (F002) to force re-registration.

### Client App — Screens

Navigation: bottom tab bar (Chat, Appointments, Notifications, Settings). Short Code Entry is a one-time pre-auth screen shown only on first launch before account activation.

**Minimum OS versions:** iOS 16 minimum; Android API level 26 (Android 8.0 Oreo) minimum. Both cover ~95%+ of active devices and ensure stable universal link, deferred deep link, FCM notification channel, and WebSocket support.

**Offline behavior:** Previously received messages are cached locally and visible when offline. Outgoing messages queue with a "Sending…" indicator and send automatically when connection restores. A "No connection" banner is shown at the top of the Chat screen when offline. FCM handles push notification delivery retries natively.

**Message pagination:** Chat screen fetches the most recent 50 messages on load (newest at bottom). User scrolling to the top triggers a cursor-based "load more" fetch of the previous 50 messages (`?cursor=<value>&limit=50`) until `next_cursor` is null (start of history). New messages arrive via WebSocket `new_message` event and are appended in real time — no re-fetch required.

| Screen | Purpose | Key Actions |
|---|---|---|
| Short Code Entry | First launch — redeem invite and activate account | Pre-filled code from deep link, submit to activate. Error states: expired code (`INVITE_EXPIRED`) → "This invite link has expired. Please contact your office to request a new one."; already used (`INVITE_USED`) → "This invite has already been redeemed. If you're having trouble signing in, contact your office."; wrong code (`INVITE_INVALID`) → 5 attempts allowed, then 15-minute lockout with "Too many incorrect attempts. Please try again in 15 minutes." |
| Chat | Persistent conversation thread with the office | Read messages, send reply |
| Appointment List | View all upcoming and past appointments | View status (confirmed, pending, cancelled, etc.) |
| Notifications | In-app notification history | View past alerts — slot offers, follow-ups, confirmations |
| Settings | Account preferences | Opt out of outreach, view contact info |

### Database — Core Entities

| Entity | Key Fields |
|---|---|
| Business | id, name, plan, timezone (IANA string, e.g. "America/New_York", default "UTC" — required at setup; F004 must enforce during onboarding wizard), settings — schema: `outreach_response_window_hours` (int, default 2), `outreach_hours_start` (time, default 09:00), `outreach_hours_end` (time, default 19:00), `auto_pickup_interval_minutes` (int, default 5), `escalation_keywords` (string[], default []), `booking_approval_timeout_hours` (int, default 2) |
| Staff User | id, business_id, email, role (admin/staff/viewer), can_trigger_outreach, can_edit_schedule, password_hash, google_id, refresh_token_hash, refresh_token_expires_at — see F002 |
| Client | id, business_id, name, phone, email, app_registered, opted_out (bool, default false — set by client self-service or staff; Job Scheduler checks before firing any outreach) |
| Schedule | id, business_id, date, created_by |
| Appointment | id, schedule_id, client_id (nullable — null means slot is available), starts_at (TIMESTAMPTZ — full UTC timestamp computed from Schedule.date + slot time + Business.timezone at creation; all deadline and follow-up calculations use this field directly), service_type (text — e.g. "general dentist", "massage"; set by AI from client request or by staff), status (available/pending-outreach/ai-active/confirmed/rescheduled/cancelled/no-response) |
| Conversation | id, business_id, client_id, appointment_id — **one record per booking episode** (not per thread). Each booking creates a new Conversation linked to its Appointment. taken_over_by (null = AI active; staff_user_id = AI paused), follow_up_count, next_follow_up_at, state, offered_slot_id, escalation_reason, consecutive_ambiguous_count, context_summary — see F003. Terminal states are final. The client's Chat screen fetches all Messages across all their Conversations for that business (`WHERE client_id = ? AND business_id = ?` ordered by timestamp) to show a seamless continuous chat. |
| Message | id, conversation_id, sender (ai/client/staff), content, timestamp |
| WaitlistEntry | id, client_id, business_id, preferences (text), status (waiting/notified/scheduled), created_at |
| ClientInvite | id, client_id, business_id, short_code, expires_at, used_at (null until redeemed) |
| DeviceToken | id, client_id, business_id, token (FCM device token), platform (ios/android), updated_at — upserted on app launch per (client_id, platform); deleted on logout |

### Database — Indexes

| Table | Columns | Type | Reason |
|---|---|---|---|
| `Conversation` | `(appointment_id)` | Unique constraint | Enforces one conversation per booking episode |
| `Appointment` | `(business_id, status)` | Index | Slot availability queries |
| `Appointment` | `(schedule_id)` | Index | Loading all appointments for a schedule |
| `Message` | `(conversation_id)` | Index | Loading message history |
| `WaitlistEntry` | `(business_id, status, created_at)` | Index | Ordered waitlist queries |
| `DeviceToken` | `(client_id, platform)` | Unique constraint | One token per device type per client |
| `ClientInvite` | `(short_code)` | Index | Short code redemption lookup |

## Open Questions

- Self-hosted backend vs. managed cloud (AWS, GCP, Railway) — affects infrastructure setup
- Production LLM provider (Claude API vs. OpenAI) — deferred until after core loop is built and tested; provider abstraction layer makes this a config change when ready

## Push Notification Tap Behavior

When a push notification is tapped, the app navigates to the relevant screen. Deep linking must be implemented in React Native to handle background and killed app states.

**Client app:**

| Notification | Destination |
|---|---|
| Any follow-up message | Chat screen |
| Waitlist slot offer | Chat screen |
| Appointment confirmed | Chat screen |

**Staff app:**

| Notification | Destination |
|---|---|
| Appointment confirmed | Conversation View (`/conversations/:id`) |
| Client requests human / escalation | Conversation View (`/conversations/:id`) |
| Ambiguous / off-topic (2nd occurrence) | Conversation View (`/conversations/:id`) |
| Distress keyword detected | Conversation View (`/conversations/:id`) |
| Deadline missed / slot released | Schedule Detail (`/schedules/:id`) |
| Client booking request needs approval | Approve Booking (`/bookings/pending`) |
| LLM API failure | Dashboard (`/`) |

## Non-Functional Requirements (V1)

| Area | V1 Baseline |
|---|---|
| **Performance** | API responses < 500ms (p95); WebSocket message delivery < 1s end-to-end; V1 target capacity: 50 concurrent staff sessions, 500 concurrent client connections |
| **Security** | HTTPS/TLS required in transit; data at rest encrypted via managed database provider (AWS RDS, Railway, or equivalent); rate limiting on all auth endpoints (prevent brute force); all client input sanitized before passing to LLM (prompt injection prevention); JWT validated on every request |
| **Scalability** | Bull queue max concurrency: 10 concurrent LLM jobs (configurable via env var); single-instance V1; no auto-scaling required at launch |
| **Compliance** | No client data shared with third parties; client opt-out implemented (Client.opted_out); collect only data required for scheduling; GDPR/CCPA: honor opt-out requests; HIPAA deferred (see Out of Scope) |
| **Observability** | Structured logging on all API requests and errors; Sentry (or equivalent) for error tracking and alerting; Bull Board for job queue monitoring; no custom metrics dashboard required for V1 |

## API Conventions

All future feature specs must follow these conventions when defining endpoints.

- **Base path:** `/api/v1/` for all protected endpoints (e.g. `/api/v1/appointments`, `/api/v1/conversations`). Internal/admin endpoints use `/internal/`.
- **Auth header:** `Authorization: Bearer <access_token>` on all protected endpoints.
- **Error envelope:** All error responses use:
  ```json
  { "error": { "code": "SLOT_TAKEN", "message": "This slot is no longer available." } }
  ```
  `code` is screaming snake case (machine-readable); `message` is human-readable. HTTP status codes: 400 bad input, 401 unauthorized, 403 forbidden, 404 not found, 409 conflict, 500 server error.
- **Pagination:** Cursor-based. Response: `{ "data": [...], "next_cursor": "opaque_string_or_null" }`. Request: `?cursor=<value>&limit=<n>` (default limit: 50). Applies to message history, conversation list, and client list.

## Architecture Principles

- **Error handling:** Every module must define its failure behavior in its own feature spec. This spec defines the happy path; failure modes (LLM down, push notification failure, calendar sync error, job failure) are owned by the relevant module spec.
- **Provider abstraction:** The AI Engine is built against a provider abstraction layer. LLM provider, base URL, and API key are config values — no provider-specific code in business logic. Enables local (Ollama) → production (TBD) swap without code changes.
- **Row-level multi-tenancy:** Every entity carries `business_id`. All queries filter by it. No cross-business data leakage.
- **Single source of truth:** The database is authoritative for all schedule state. No module maintains its own state cache.
- **CORS policy:** Allowed origins are explicitly whitelisted via `ALLOWED_ORIGINS` env var (comma-separated). Production: `https://staff.app.[domain]`; development: `http://localhost:3000`. `Access-Control-Allow-Credentials: true` required (httpOnly refresh token cookie). Allowed methods: `GET, POST, PUT, PATCH, DELETE, OPTIONS`. Allowed headers: `Authorization, Content-Type`. Wildcard `*` is prohibited — incompatible with credentialed requests.

## Multi-Tenancy

Data isolation between businesses is enforced at the row level. Every database entity carries a `business_id` field. All queries must filter by `business_id` — no query should ever return data across business boundaries. Schema-per-tenant is deferred unless enterprise requirements demand it.

## System Bootstrap

Before any feature can be used, a Business record and first Admin account must exist. Two mechanisms handle this:

**Development — seed script:**
```
npm run seed:admin
```
Reads `SEED_BUSINESS_NAME`, `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` from environment variables. Creates a Business and Admin account. No-op (exits silently) when `NODE_ENV=production`.

**Production — bootstrap endpoint:**
```
POST /internal/bootstrap
Header: x-bootstrap-secret: <BOOTSTRAP_SECRET env var>
Body: { businessName, adminEmail, adminPassword }
```
Creates the first Business + Admin. Returns `409 Conflict` if a Business already exists — enforces one-time use. F004 will build a customer-facing onboarding UI that calls this endpoint under the hood.

## Dependencies on Future Specs

- **F002** — Authentication & Authorization: staff login, roles, permissions, client session lifecycle
- **F003** — AI Engine: Conversation State Machine: full state machine, LLM protocol, escalation rules
- **F004** — Business Onboarding: customer-facing setup UI built on top of the bootstrap endpoint; settings wizard; billing integration

---

## Operational Considerations

**In scope for V1:**
- Database schema versioned with a migration tool (e.g. `node-pg-migrate`) — migrations run on every deploy
- Three environments: `development` (local), `staging` (pre-production), `production`
- Error monitoring: Sentry (see NFR section)
- Queue monitoring: Bull Board (see NFR section)
- App store: React Native app submitted to App Store (iOS) and Google Play (Android) before first client onboarding

**Staging environment configuration:**
- **Database:** separate staging database, never shared with production — same schema, independent data
- **SendGrid:** sandbox mode — emails processed but never delivered to real inboxes
- **Firebase/FCM:** separate Firebase project for staging — push notifications go to test devices only
- **Seed data:** `npm run seed:admin` available (`NODE_ENV=staging`); blocked only on `NODE_ENV=production`
- **`NODE_ENV`:** set to `staging` — production-like behavior with no dev shortcuts; seed script not blocked
- All staging credentials are separate env vars with no values shared with production config

**Out of scope for V1:**
- CI/CD pipeline — manual deploys acceptable at launch
- Automated database backups — deferred to managed cloud provider defaults
- Auto-scaling / horizontal scaling
- Feature flags / phased rollouts
- On-call alerting (PagerDuty or equivalent)

## Environment Variables

All configuration is provided via environment variables. A `.env.example` file must be maintained at the project root with placeholder values for all variables below.

| Variable | Module | Example Value |
|---|---|---|
| `DATABASE_URL` | Database | `postgresql://user:pass@localhost:5432/aischeduler` |
| `JWT_SECRET` | Auth | `a-long-random-secret` |
| `LLM_BASE_URL` | AI Engine | `http://localhost:11434/v1` |
| `LLM_API_KEY` | AI Engine | `ollama` |
| `LLM_MODEL` | AI Engine | `llama3` |
| `SENDGRID_API_KEY` | First Contact Bootstrap | `SG.xxxx` |
| `APP_DOMAIN` | First Contact Bootstrap | `app.myscheduler.com` |
| `FIREBASE_SERVICE_ACCOUNT` | Push Notifications | `{ ...JSON... }` |
| `GOOGLE_OAUTH_CLIENT_ID` | Auth (Google SSO) | `xxxx.apps.googleusercontent.com` |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Auth (Google SSO) | `xxxx` |
| `BOOTSTRAP_SECRET` | System Bootstrap | `a-long-random-secret` |
| `NODE_ENV` | All | `development` / `production` |
| `SEED_BUSINESS_NAME` | Dev seed script | `Test Office` |
| `SEED_ADMIN_EMAIL` | Dev seed script | `admin@test.com` |
| `SEED_ADMIN_PASSWORD` | Dev seed script | `changeme` |
| `BULL_CONCURRENCY` | Job Scheduler | `10` |
| `ALLOWED_ORIGINS` | CORS | `https://staff.app.myscheduler.com` (comma-separated; use `http://localhost:3000` for dev) |

## Out of Scope

- HIPAA / healthcare compliance (deferred to future phase)
- Apple Calendar sync (removed by user decision)
- Calendar sync write-back to Google/Outlook (on hold — direction not yet decided)
- Payment confirmation and cancellation flows (future phase)
- AI proactive follow-ups beyond appointment confirmation (future phase)
- Multi-location / enterprise org management (future phase)
- SMS first-contact bootstrap via Twilio (deferred to next phase — V1 uses email only)
