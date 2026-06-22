# F001 — Core System Architecture — Phases

**Linked spec:** [F001-core-architecture-spec.md](F001-core-architecture-spec.md)
**Approved:** 2026-05-05
**Total phases:** 6
**Purpose:** Build the foundational infrastructure layers that all feature specs (F002, F003, F004, …) build on. No product features are delivered in these phases — only the scaffold, database, real-time layer, job queue, AI engine abstraction, and both app shells.

---

## Phase 1 — Backend Foundation

**Goal:** A running Node.js/TypeScript backend with the full database schema, CORS, error middleware, and the two bootstrap mechanisms.

**Deliverables:**

- Monorepo scaffold: `/backend`, `/staff-web`, `/client-mobile` directories with TypeScript configs and linting
- Express (or Fastify) app with:
  - CORS middleware — `ALLOWED_ORIGINS` env var; `Access-Control-Allow-Credentials: true`
  - Global error handler returning `{ "error": { "code": "...", "message": "..." } }` envelope
  - Rate limiting on all `/api/v1/auth/*` endpoints
  - Health check: `GET /health` → `{ status: "ok" }`
- PostgreSQL + `node-pg-migrate` wired up; `DATABASE_URL` consumed from env
- All 13 entity migrations in order:
  1. `business` (id, name, plan, timezone, settings JSONB)
  2. `staff_user` (id, business_id, email, role, can_trigger_outreach, can_edit_schedule, password_hash, google_id, refresh_token_hash, refresh_token_expires_at)
  3. `client` (id, business_id, name, phone, email, app_registered, opted_out)
  4. `schedule` (id, business_id, date, created_by)
  5. `appointment` (id, schedule_id, client_id nullable, starts_at TIMESTAMPTZ, service_type, status)
  6. `conversation` (id, business_id, client_id, appointment_id, taken_over_by, follow_up_count, next_follow_up_at, state, offered_slot_id, escalation_reason, consecutive_ambiguous_count, context_summary)
  7. `message` (id, conversation_id, sender, content, timestamp)
  8. `waitlist_entry` (id, client_id, business_id, preferences, status, created_at)
  9. `client_invite` (id, client_id, business_id, short_code, expires_at, used_at)
  10. `device_token` (id, client_id, business_id, token, platform, updated_at)
- All indexes from spec applied:
  - `conversation(appointment_id)` — unique constraint
  - `appointment(business_id, status)` — index
  - `appointment(schedule_id)` — index
  - `message(conversation_id)` — index
  - `waitlist_entry(business_id, status, created_at)` — index
  - `device_token(client_id, platform)` — unique constraint
  - `client_invite(short_code)` — index
- `.env.example` with all 17 variables (including `ALLOWED_ORIGINS`)
- Dev seed script: `npm run seed:admin` — reads `SEED_BUSINESS_NAME`, `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`; no-op on `NODE_ENV=production`
- Bootstrap endpoint: `POST /internal/bootstrap` — protected by `x-bootstrap-secret` header; creates first Business + Admin; returns 409 if Business already exists
- API base path convention enforced: all routes under `/api/v1/`

**Dependencies:** None — this is the foundation everything else builds on.

**Done when:** `npm run migrate` runs cleanly, seed script creates a Business + Admin row, and `POST /internal/bootstrap` returns 200 on first call and 409 on second.

---

## Phase 2 — Real-Time Layer (WebSocket Server)

**Goal:** A working WebSocket server with authenticated channels and the full 7-event schema wired up.

**Deliverables:**

- `ws` library integrated with the Express/Fastify HTTP server
- WebSocket upgrade handler:
  - Reads `Authorization: Bearer <token>` from upgrade request headers
  - Validates JWT — rejects with 401 and closes connection if missing or invalid
  - On valid auth: registers connection into the appropriate channel (`/staff/{business_id}` or `/client/{client_id}`) based on token claims
- Channel registry: in-memory map of `business_id → Set<WebSocket>` (staff) and `client_id → Set<WebSocket>` (client)
- Typed emit helpers for all 7 event types (enforces the `{ event, payload }` envelope):
  - `emitNewMessage(conversationId, message)`
  - `emitConversationStateChanged(conversationId, state, clientName)`
  - `emitStaffAlert(alertType, conversationId, clientName, reason)`
  - `emitAppointmentConfirmed(appointmentId, clientName, time, serviceType)`
  - `emitBookingApprovalRequested(conversationId, clientName, serviceType, preferredTime)`
  - `emitMessageDelivered(messageId)`
  - `emitTakeoverStarted(conversationId)`
- Connection cleanup on disconnect (remove from channel registry)
- Basic smoke test: two clients connect to different channels, emit `new_message` to one, confirm the other does not receive it

**Dependencies:** Phase 1 (needs JWT validation, which uses the JWT_SECRET from env and the StaffUser/Client tables for token claims).

**Done when:** Authenticated staff and client WebSocket connections land in the correct channels and typed emit helpers deliver events to the right connections only.

---

## Phase 3 — Job Scheduler Infrastructure (Bull)

**Goal:** A working Bull queue with concurrency controls, Bull Board monitoring, and registered job processor shells for every job type the system will use.

**Deliverables:**

- Redis connected; `BULL_CONCURRENCY` env var consumed (default 10)
- Bull queue `ai-scheduler` created with concurrency ceiling applied
- Bull Board mounted at `/admin/queues` (protected — accessible only with Admin role once auth is built; for now, IP-restricted or open in dev)
- Job processor shells registered (no business logic yet — stubs that log and complete):
  - `send-outreach` — initial AI message to client
  - `send-followup` — timed follow-up message (keyed by conversation_id)
  - `deadline-check` — fires at appointment deadline
  - `waitlist-check` — triggered on slot release; iterates waitlist entries
  - `waitlist-reminder` — T+25min reminder for waitlist slot offer (keyed by conversation_id)
  - `auto-pickup` — recurring scan for `pending-outreach` appointments; respects `Business.settings.outreach_hours_start/end` using `Business.timezone` via Node.js `Intl` API
  - `booking-approval-timeout` — fires after `booking_approval_timeout_hours`; keyed by conversation_id
- Job cancellation utility: `cancelJobsByConversationId(conversationId)` — cancels all pending follow-up and reminder jobs for a conversation
- Auto-pickup watcher: repeating Bull job every `auto_pickup_interval_minutes` (default 5); checks `Business.settings.outreach_hours_start/end` against current local time (using `Business.timezone`) before queuing outreach

**Dependencies:** Phase 1 (database, env vars). Redis must be added to the environment.

**Done when:** Bull Board is accessible, all job types appear in the queue UI, and the auto-pickup repeating job fires on schedule (verifiable in Bull Board).

---

## Phase 4 — AI Engine Scaffold (Provider Abstraction)

**Goal:** A working LLM client with the provider abstraction layer, Ollama integration for dev, JSON response parsing, and context window management — ready to accept conversation state machine integration in F003.

**Deliverables:**

- `LLMClient` class with:
  - Constructor takes: `baseUrl`, `apiKey`, `model` (all from env vars `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`)
  - `complete(systemPrompt: string, messages: Message[]): Promise<LLMResponse>` — sends request to OpenAI-compatible `/chat/completions` endpoint
  - Returns typed `LLMResponse`: `{ intent, confidence, response_text, extracted_preferences }`
  - JSON parse failure → throws `LLMParseError` (caller treats as `llm_api_failure` → escalation)
  - Timeout handling → throws `LLMTimeoutError`
- Confidence threshold logic:
  - ≥ 0.75 → use detected intent
  - 0.50–0.74 → override to `ambiguous`
  - < 0.50 → override to `ambiguous`
- Context window manager:
  - Fetches last 10 messages for a conversation from DB
  - If conversation has > 10 messages: prepends `Conversation.context_summary` to system prompt
  - Summary regeneration: separate `LLMClient.summarize(messages[])` call; result stored in `Conversation.context_summary`
- Distress keyword detector: checks message text against hardcoded base list (`["emergency", "urgent help", "threatening", "lawyer", "lawsuit"]`) + `Business.settings.escalation_keywords` before any LLM call — immediate escalation signal if matched
- Prompt template: base system prompt with `{businessName}`, `{state}`, `{appointmentDetails}`, `{availableSlots}` interpolation slots
- Ollama smoke test: `LLM_BASE_URL=http://localhost:11434/v1`, send a test prompt, verify typed JSON response

**Dependencies:** Phase 1 (database for message fetch, Business.settings for escalation keywords). Ollama must be running locally for dev.

**Done when:** `LLMClient.complete()` returns a valid typed `LLMResponse` against a running Ollama instance, and the distress keyword check fires before the LLM call.

---

## Phase 5 — Staff Web App Scaffold

**Goal:** A running React/TypeScript staff web app with all 10 routes defined, auth context wired, protected route guards, login page, base layout, and desktop-only enforcement.

**Deliverables:**

- React + TypeScript + Vite project in `/staff-web`
- React Router v6 with all 10 routes registered:
  - `/login` — Login page (unprotected)
  - `/` — Dashboard (protected)
  - `/schedules` — Schedule Builder (protected)
  - `/schedules/:id` — Schedule Detail (protected)
  - `/conversations/:id` — Conversation View (protected)
  - `/clients` — Clients list (protected)
  - `/clients/:id` — Client Detail (protected)
  - `/settings` — Settings (Admin only)
  - `/staff` — Staff Management (Admin only)
  - `/bookings/pending` — Approve Booking (Admin + Staff with `can_edit_schedule` to act; read-only otherwise)
- Auth context:
  - Access token stored in memory (not localStorage)
  - Refresh via `POST /api/v1/auth/refresh` using httpOnly cookie
  - `credentials: 'include'` on all API calls
- Protected route wrapper — redirects to `/login` if unauthenticated
- Role-based route guard — renders read-only or hides nav items based on role/permissions
- Login page: email/password form + "Sign in with Google" button (placeholder — functional in F002)
- Base layout: sidebar navigation with all 10 page links; active state; role-aware visibility
- Desktop-only guard: `useEffect` checks `window.innerWidth < 768` on mount and resize → renders banner: "Please use a desktop browser for the best experience" instead of content
- Each page renders a placeholder heading and "Coming soon" — no feature logic yet
- API client utility (`/lib/api.ts`): base `fetch` wrapper with `/api/v1/` prefix, `Authorization: Bearer` header, `credentials: 'include'`, and error envelope parsing

**Dependencies:** Phase 1 (API base path, CORS config). Auth endpoints implemented in F002.

**Done when:** All 10 routes render their placeholder pages, the desktop banner fires below 768px, and the auth context correctly redirects unauthenticated users to `/login`.

---

## Phase 6 — Client Mobile App Scaffold

**Goal:** A running React Native app with navigation structure, FCM push setup, universal link configuration, offline cache layer, and the outgoing message queue — ready for feature implementation.

**Deliverables:**

- React Native + TypeScript project in `/client-mobile` (bare workflow)
- Minimum targets set: iOS 16, Android API 26
- Navigation:
  - Stack navigator root: `ShortCodeEntry` (pre-auth, shown only before `app_registered = true`)
  - Bottom Tab navigator (post-auth): Chat, Appointments, Notifications, Settings
  - Each tab renders a placeholder screen
- FCM push notification setup:
  - iOS: APNs key configured, notification permissions requested on first launch
  - Android: notification channel created (`importance: HIGH`) — required for API 26+
  - Device token registration: on app launch, `POST /api/v1/device-tokens` upserts token by (client_id, platform)
  - On logout: `DELETE /api/v1/device-tokens/{platform}`
  - Push tap handler: navigates to Chat screen for all client notification types
- Universal link / deep link configuration:
  - iOS: `associated-domains` entitlement with `applinks:app.[domain]`
  - Android: intent filter for `https://app.[domain]/redeem`
  - Deep link handler: on `app.[domain]/redeem?code=XXXXXX` open → navigates to `ShortCodeEntry` with code pre-filled
  - Deferred deep link: stores code before install via React Native branch or Firebase Dynamic Links; redeems on first launch
- Short Code Entry screen:
  - Input pre-filled from deep link param
  - Submit calls `POST /api/v1/auth/redeem`
  - Error states rendered: `INVITE_EXPIRED`, `INVITE_USED`, `INVITE_INVALID` (with 5-attempt lockout display)
- Offline cache layer:
  - MMKV (or AsyncStorage) stores last-fetched messages per conversation
  - Messages render from cache when `NetInfo.isConnected = false`
  - "No connection" banner shown at top of Chat screen when offline
- Outgoing message queue:
  - Messages written to local queue on send
  - Displayed with "Sending…" indicator
  - Flushed to `POST /api/v1/messages` when connection restores
- API client utility: base `fetch` wrapper with JWT access token from secure storage, token refresh on 401

**Dependencies:** Phase 1 (API), Phase 2 (WebSocket — client connects after auth), Phase 5 (auth flow understanding). FCM project and App Store / Google Play developer accounts required.

**Done when:** App launches, navigates to Short Code Entry pre-auth, handles a deep link with pre-filled code, shows offline banner when disconnected, and FCM token is registered on launch.

---

## Phase Summary

| Phase | Name | Depends On | Key Output |
|---|---|---|---|
| 1 | Backend Foundation | — | Running API, full DB schema, seed + bootstrap |
| 2 | Real-Time Layer | 1 | Authenticated WebSocket channels, 7-event schema |
| 3 | Job Scheduler | 1 | Bull queue, all job types registered, auto-pickup watcher |
| 4 | AI Engine Scaffold | 1 | LLMClient with provider abstraction, Ollama integration |
| 5 | Staff Web App Scaffold | 1 | All 10 routes, auth context, role guards, desktop enforcement |
| 6 | Client Mobile App Scaffold | 1, 2 | Navigation, FCM, universal links, offline cache, message queue |

Phases 2–6 can run in parallel once Phase 1 is complete. Feature specs (F002 auth, F003 state machine, F004 onboarding) build on top of this scaffold.
