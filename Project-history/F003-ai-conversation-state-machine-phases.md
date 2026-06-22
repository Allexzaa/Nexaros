# F003 — AI Engine: Conversation State Machine — Phases

**Linked spec:** [F003-ai-conversation-state-machine-spec.md](F003-ai-conversation-state-machine-spec.md)
**Depends on:** F001 all phases complete · F002 all phases complete
**Total phases:** 6
**Purpose:** Implement the full AI conversation engine — state machine, LLM intent detection, follow-up sequence, rescheduling, waitlist, escalation, and booking approval. At the end of Phase 6 the AI can autonomously manage the full lifecycle of an appointment confirmation conversation with no staff intervention required on the happy path.

**Scaffold already in place (do not rebuild):**

| What | Where |
|---|---|
| Conversation table + all F003 fields | `migrations/20260505000007_create_conversation.js` |
| All job types, data shapes, job ID helpers | `src/jobs/types.ts` |
| Processor stubs (all 7 jobs) | `src/jobs/processors/` |
| LLMClient (OpenAI-compatible) | `src/ai/client.ts` |
| `isDistressMessage()` | `src/ai/keywords.ts` |
| `getConversationContext()` / `regenerateSummary()` | `src/ai/contextWindow.ts` |
| `buildSystemPrompt()` | `src/ai/prompts.ts` |
| AI types (`LLMIntent`, `LLMResponse`, errors) | `src/ai/types.ts` |
| Conversation route stubs (list, detail, takeover, return) | `src/routes/api/conversations.ts` |
| Schedule outreach trigger stub | `src/routes/api/schedules.ts` |
| WebSocket emitters | `src/realtime/emitters.ts` |

---

## Client-Initiated Booking — Resolved (2026-05-06)

Standard client-initiated bookings use a **UI slot picker** in the client mobile app — not chat. Client selects an available slot, taps Book → `POST /api/v1/client/bookings` creates the Appointment + Conversation → AI confirms via the same flow as outreach-triggered. The `conversation.appointment_id NOT NULL` constraint is unchanged.

The `awaiting_approval` state fires **only for edge-case in-chat requests** (e.g. client asks for a custom duration or service type the AI cannot auto-confirm). It is not triggered by standard slot selection.

---

## Phase 1 — State Machine Core

**Goal:** A StateEngine class that validates and persists every state transition from the spec. All other phases call this; nothing else transitions state directly.

**Deliverables:**

**Backend:**
- `src/ai/types.ts` additions:
  - `ConversationState` union type (all 14 states from spec)
  - `ConversationEvent` union type (all events from spec)
  - `InvalidTransitionError` class
- `src/ai/stateEngine.ts` — `StateEngine` class:
  - `applyTransition(conversationId: string, event: ConversationEvent, extras?: TransitionExtras): Promise<ConversationState>` — reads current state from DB, validates against the spec transition table, writes new state + extras (escalation_reason, offered_slot_id, consecutive_ambiguous_count reset) in a single `UPDATE`, returns new state
  - Throws `InvalidTransitionError` for undefined event→state combinations (guards against logic bugs)
  - Resets `consecutive_ambiguous_count = 0` on any event that produces a clear intent outcome (confirm, decline, question, slot_accept, slot_decline, opt_out, human_requested)
  - Exported singleton: `stateEngine` from `src/ai/index.ts`
- All 14 states and all transitions from the spec table implemented (including `awaiting_approval` path)

**Tests (`backend/src/__tests__/stateEngine.test.ts`):**
- All valid transitions (one test per row in the spec transition table)
- Blocked invalid transitions throw `InvalidTransitionError`
- `consecutive_ambiguous_count` resets correctly on clear intent
- DB state is persisted (use test DB or mock `db.query`)

**Dependencies:** F001 migrations applied (Conversation table exists with all fields).

**Done when:** Every transition from the spec table passes a test; invalid transitions are rejected; DB is updated on every valid transition.

---

## Phase 2 — Message Processing Pipeline

**Goal:** Incoming client message → distress check → LLM intent detection → confidence routing → event dispatched to StateEngine. The core processing loop all flows converge on.

**Deliverables:**

**Backend:**
- `src/ai/types.ts` additions:
  - Add `'booking_request'` to `LLMIntent` (client-initiated booking detected by LLM)
  - `ProcessingResult` interface: `{ event: ConversationEvent; newState: ConversationState; responseText: string; extractedPreferences: string | null }`
- `src/ai/messageProcessor.ts` — `processIncomingMessage(conversationId: string, messageText: string): Promise<ProcessingResult>`:
  - **Concurrency guard**: Redis key `lock:conversation:<id>` with 30s TTL using `SET NX EX`. If locked, enqueue message to a per-conversation Redis list and return; a completion handler drains the queue after each call.
  - Loads Conversation (state, context_summary, consecutive_ambiguous_count, appointment_id, business_id) from DB
  - Loads last 10 messages from `message` table ordered by `created_at DESC`
  - **Distress check first**: `isDistressMessage(messageText)` → if true, skip LLM, fire `human_requested` event → `escalated` state; escalation_reason = `'distress_keyword'`
  - Builds prompt via `buildSystemPrompt({ businessName, state, appointmentDetails, availableSlots, contextSummary })`
  - Calls `llmClient.chat()` — on `LLMTimeoutError` or `LLMParseError` → fire LLM failure event → `escalated`; escalation_reason = `'llm_api_failure'`
  - **Confidence routing**:
    - `≥ 0.75`: use detected intent
    - `0.50–0.74`: override to `ambiguous`
    - `< 0.50`: override to `ambiguous`
  - **Ambiguous/off-topic counter**: for `ambiguous` or `off_topic` intents, read current `consecutive_ambiguous_count`:
    - Count = 0 (first occurrence): fire appropriate 1st-occurrence event; increment count in DB
    - Count ≥ 1 (second+ occurrence): fire escalation regardless of current state
  - Maps resolved intent to `ConversationEvent` and calls `stateEngine.applyTransition()`
  - Stores AI `response_text` as a `message` row (sender: `'ai'`, conversation_id, content)
  - **Context window**: after storing message, if total message count > 10, call `regenerateSummary()` and update `Conversation.context_summary`
  - Returns `ProcessingResult`
- `src/ai/index.ts`: export `processIncomingMessage` and `stateEngine`

**Tests (`backend/src/__tests__/messageProcessor.test.ts`):**
- High-confidence intent → correct event dispatched
- Confidence 0.60 → intent overridden to ambiguous
- First ambiguous → clarification; second ambiguous → escalation
- Distress keyword → escalation bypasses LLM
- `LLMTimeoutError` → escalation with reason `llm_api_failure`
- `LLMParseError` → escalation
- Context summary regenerated when message count exceeds 10
- Concurrency: second call while first is active is queued (integration-level test)

**Dependencies:** Phase 1 (StateEngine), `src/ai/client.ts`, `src/ai/keywords.ts`, `src/ai/contextWindow.ts`, `src/ai/prompts.ts`.

**Done when:** A simulated message flow through all confidence bands produces the correct events and state transitions; distress and LLM failure paths escalate correctly.

---

## Phase 3 — Happy Path + Follow-Up Sequence

**Goal:** Full outreach-triggered flow works end-to-end: idle → awaiting_reply → confirmed. Follow-up jobs fire on schedule. Auto-pickup watcher handles unattended appointments. Staff can trigger outreach manually.

**Deliverables:**

**Backend:**
- `POST /api/v1/schedules/:id/outreach` (`src/routes/api/schedules.ts`) — stub → real:
  - Finds all `appointment` rows for the schedule where `status = 'pending-outreach'` and no `conversation` row exists
  - Creates `conversation` rows (state: `idle`) for each
  - Enqueues `send-outreach` job for each via `queue.add()`
  - Returns `{ queued: N }` count
- `src/jobs/processors/sendOutreach.ts` — stub → real:
  - `idle` → `awaiting_reply` via StateEngine
  - Loads Appointment + Client from DB; builds first message text
  - Stores Message row (sender: `'ai'`) + pushes to client via `emitToClient()`
  - Schedules 3 follow-up jobs using deterministic IDs from `jobId.followup()`:
    - Job 1: `delay = 5 * 60 * 1000` (5 min)
    - Job 2: `delay = 65 * 60 * 1000` (1 hr + 5 min to run after job 1)
    - Job 3: fires at `outreach_time + outreach_response_window_hours * 3600000 - 5 * 60 * 1000` (5 min before deadline)
  - Schedules deadline-check job via `jobId.deadlineCheck()` at `delay = outreach_response_window_hours * 3600000`
- `src/jobs/processors/sendFollowup.ts` — stub → real:
  - Sends urgency message per `follow_up_count` (1 = first urgency, 2 = check-in, 3 = last chance)
  - Stores Message row, increments `conversation.follow_up_count`
  - State stays `awaiting_reply`
- `src/jobs/processors/deadlineCheck.ts` — stub → real:
  - Validates conversation still in `awaiting_reply` or `confirming` (guard: skip if already terminal)
  - `awaiting_reply`/`confirming` → `no_response` via StateEngine
  - Sets `appointment.status = 'no_response'`
  - Notifies staff via WebSocket emitter (new `emitDeadlineReached()` in `src/realtime/emitters.ts`)
  - Enqueues `waitlist-check` job with `slotId` and `businessId`
- `POST /api/v1/client/messages` (`src/routes/api/clientAuth.ts`) — wire to real processing:
  - Validates client JWT (already in clientMiddleware)
  - Stores Message row (sender: `'client'`)
  - If Conversation state is `awaiting_reply`: cancel all pending follow-up + deadline jobs via `scheduler.cancelJobsByConversationId()`; call `processIncomingMessage()`
  - If state is `processing`: enqueue message to per-conversation Redis queue (handled by concurrency guard in Phase 2)
  - Other states: log + respond per spec edge cases (e.g. `confirmed` → friendly acknowledge)
- confirming → confirmed in `messageProcessor`: when `confirmation_intent` fires from `confirming`:
  - StateEngine: `confirming` → `confirmed`
  - Sets `appointment.status = 'confirmed'`
  - Sends confirmation message to client
  - Cancels any remaining follow-up + deadline jobs
- `src/jobs/processors/autoPickup.ts` — stub → real:
  - Reads `Business.settings.outreach_hours_start` and `outreach_hours_end`
  - If current time is outside window: reschedule job to fire at next window start; return early
  - Queries all `appointment` rows with `status = 'pending-outreach'` that have no `conversation`
  - Creates Conversations + enqueues `send-outreach` jobs for each found
  - Reads `auto_pickup_interval_minutes` from `Business.settings` (default 5)
- `GET /api/v1/conversations` + `GET /api/v1/conversations/:id` — real DB queries:
  - List: paginated, filtered by `business_id` from token, sorted by `updated_at DESC` (escalated first — Phase 5)
  - Detail: includes messages, client name, appointment details, current state

**Tests (`backend/src/__tests__/`):**
- `outreach.test.ts`: outreach trigger creates conversations + enqueues jobs
- `followup.test.ts`: follow-up sequence fires in order; deadline fires at correct time
- `happyPath.integration.test.ts`: outreach → client replies → confirming → confirmed (full round trip using test DB)
- `autoPickup.test.ts`: inside window → picks up; outside window → reschedules job; manual trigger ignores window

**Dependencies:** Phase 2 (messageProcessor), Phase 1 (StateEngine). Redis + BullMQ running (F001 Phase 3).

**Done when:** Staff can trigger outreach manually; Auto-pickup watcher finds unattended appointments; a client can reply and confirm; the conversation reaches `confirmed` with the appointment locked; follow-up jobs fire and are cancelled on client reply.

---

## Phase 4 — Rescheduling + Slot Management

**Goal:** Client declines → AI gathers preferences → Slot Manager finds best match → client offered one slot → accepts (confirmed) or declines (waitlisted).

**Deliverables:**

**Backend:**
- `src/services/slotManager.ts`:
  - `findBestSlot(businessId: string, preferences: string, excludeAppointmentId: string): Promise<Appointment | null>`:
    - Queries `appointment` rows where `business_id = businessId`, `status = 'available'`, `id != excludeAppointmentId`
    - Calls LLM with preferences + slot list to rank/select best match
    - Returns top-ranked slot or `null` if no match
  - `freeSlot(appointmentId: string, businessId: string): Promise<void>`:
    - Sets `appointment.status = 'available'`, clears `client_id` if set
    - Enqueues `waitlist-check` job immediately
  - `lockSlot(appointmentId: string, clientId: string): Promise<void>`:
    - Sets `appointment.status = 'confirmed'`, sets `client_id`
    - Throws `SlotConflictError` if already taken (guard against race conditions)
- `src/ai/messageProcessor.ts` — rescheduling additions:
  - `decline_intent` from any state → `rescheduling`: AI sends "No problem. What days or times generally work better for you?"
  - `reschedule_preference_given` in `rescheduling`:
    - Calls `slotManager.findBestSlot()`
    - **Match found**: `rescheduling` → `slot_offered` via StateEngine; store `offered_slot_id`; AI sends slot details: "This is the only option I have — [date] at [time]. Would that work?"
    - **No match**: `rescheduling` → `waitlisted` via StateEngine; create `waitlist_entry` row; AI sends "I'll reach out if something matching your preferences opens up."
  - `slot_accepted` in `slot_offered`:
    - `slot_offered` → `confirmed` via StateEngine
    - `slotManager.lockSlot(offered_slot_id, clientId)` — if `SlotConflictError`: AI apologizes, returns to `rescheduling`
    - `slotManager.freeSlot(original_appointment_id)` — frees old slot + triggers waitlist check
    - Sends confirmation message
  - `slot_declined` in `slot_offered`: → `waitlisted`; create `waitlist_entry` row
- `src/db/`: add typed query helpers for available appointment lookup, appointment status update, waitlist_entry creation

**Tests (`backend/src/__tests__/rescheduling.test.ts`):**
- Full rescheduling path: decline → preferences given → slot found → offered → accepted → confirmed
- Rescheduling no match → waitlisted
- Slot conflict on accept → recovery to rescheduling
- Old slot freed after accept → waitlist-check job enqueued

**Dependencies:** Phase 3 (messageProcessor wired), Phase 1 (StateEngine), `slotManager` is new.

**Done when:** Client can decline, give preferences, receive a slot offer, and either confirm or be placed on the waitlist. Freed slot immediately triggers a waitlist check.

---

## Phase 5 — Escalation + Staff Control

**Goal:** AI hands off when it can't handle a conversation. Staff can take over, return control to AI, and close conversations. Escalated conversations surface immediately on the dashboard.

**Deliverables:**

**Backend:**
- `src/ai/messageProcessor.ts` — escalation:
  - All 6 escalation triggers produce `escalated` via StateEngine with correct `escalation_reason`:
    - `human_requested` → reason: `'client_requested_human'`
    - `opt_out` → `cancelled` (not escalated); AI confirms stop
    - ambiguous 2nd+ → reason: `'repeated_ambiguous_message'`
    - off_topic 2nd+ → reason: `'repeated_off_topic_message'`
    - `LLMTimeoutError` / `LLMParseError` → reason: `'llm_api_failure'`
    - distress keyword → reason: `'distress_keyword'`
- `src/realtime/emitters.ts` — new emitters:
  - `emitEscalation(businessId, payload: EscalationPayload)`: pushes `ai_escalation` event to `staff/<businessId>` channel
  - `emitBookingRequestPending(businessId, payload)`: pushes `booking_request_pending` event (used in Phase 6)
- `PATCH /api/v1/conversations/:id/takeover` — real implementation:
  - Sets `conversation.taken_over_by = req.staff.id`
  - StateEngine: current state → `staff_active`
  - Cancels any active follow-up, deadline, and booking-approval-timeout jobs for the conversation
  - Returns updated conversation
- `PATCH /api/v1/conversations/:id/return` — real implementation:
  - Clears `conversation.taken_over_by = null`
  - StateEngine: `staff_active` → `awaiting_reply`
  - AI re-engagement: load last `message` row for conversation:
    - If sender = `'client'`: call `processIncomingMessage()` immediately (unanswered client message)
    - If sender = `'staff'` or `'ai'`: do nothing (AI waits for next client message)
- `PATCH /api/v1/conversations/:id/close` — new endpoint (`requireAuth`, `requireRole('admin', 'staff')`):
  - StateEngine: current state → `resolved`
  - Returns updated conversation
- `GET /api/v1/conversations` sort update: escalated conversations (state = `'escalated'`) sorted to top; secondary sort by `updated_at DESC`

**Staff web (`staff-web/src/`):**
- Conversation list page: real API call replacing stub; conversation cards showing client name, state badge, last message preview
- Escalated cards: red border, sorted to top
- "Take Over" button on escalated cards → `PATCH /conversations/:id/takeover`
- "Return to AI" button on `staff_active` cards → `PATCH /conversations/:id/return`
- "Close" button (admin/staff role) → `PATCH /conversations/:id/close`
- WebSocket: subscribe to `staff/<businessId>` channel; on `ai_escalation` event — add card to top of list with red highlight (no page reload needed)

**Tests (`backend/src/__tests__/escalation.test.ts`):**
- All 6 escalation triggers → `escalated` with correct reason
- `opt_out` → `cancelled` (not escalated)
- Takeover: state → `staff_active`, pending jobs cancelled
- Return: last sender = client → AI processes message; last sender = staff → AI silent
- Force-close → `resolved`
- WebSocket push fires on escalation (spy on emitter)

**Dependencies:** Phase 3 (follow-up jobs to cancel), Phase 2 (messageProcessor), Phase 1 (StateEngine), WebSocket layer (F001 Phase 2).

**Done when:** Every escalation trigger hands off to staff within one event cycle; staff can take over, hand back, and close conversations; escalated cards appear immediately on the dashboard without refresh.

---

## Phase 6 — Waitlist Engine + Client Booking UI + Edge-Case Approval

**Goal:** Freed slots automatically re-engage waitlisted clients with a timed offer. Clients can self-initiate a booking through a slot-picker screen in the mobile app (UI-first, not chat). Edge-case in-chat booking requests (custom service/duration) route through staff approval.

**Deliverables:**

**Backend — Waitlist Engine:**
- `src/jobs/processors/waitlistCheck.ts` — stub → real:
  - Loads `waitlist_entry` rows for the business where `status = 'waiting'`, ordered by `created_at ASC` (oldest first)
  - For each entry: calls LLM to score entry's `preferences` against the freed slot's details
  - First match found:
    - Creates Conversation (idle → awaiting_reply via StateEngine)
    - Stores Message row + emits slot offer to client via `emitToClient()`
    - Sets `waitlist_entry.status = 'notified'`
    - Schedules `waitlist-reminder` job at T+25 min via `jobId.waitlistReminder()`
    - Schedules a 30-min timeout job (re-uses `waitlist-reminder` processor with `final: true` flag)
    - Stops processing further entries
  - No match: logs; slot stays `available` for manual booking
  - Skips entries where `waitlist_entry.status = 'scheduled'` or `'expired'`
- `src/jobs/processors/waitlistReminder.ts` — stub → real:
  - `final: false` (T+25 min): sends reminder "Just a reminder — this slot is available until [T+30 min]. Would you like to take it?"
  - `final: true` (T+30 min): marks `waitlist_entry.status = 'expired'`; enqueues `waitlist-check` job again for the same slot to move to next entry
- WaitlistEntry on slot_accept: `waitlist_entry.status = 'scheduled'` (set in Phase 4's `slotManager.lockSlot`)

**Backend — Client Booking UI endpoints:**
- `GET /api/v1/client/slots` — new endpoint (client JWT):
  - Returns available `appointment` rows for the client's `business_id` where `status = 'available'`, sorted by `starts_at ASC`
  - Response: `{ slots: [{ id, startsAt, serviceType, durationMinutes }] }`
- `POST /api/v1/client/bookings` — new endpoint (client JWT):
  - Body: `{ slotId: string }`
  - Calls `slotManager.lockSlot(slotId, clientId)` — throws `SlotConflictError` if taken (race condition guard)
  - Creates `conversation` row (state: `idle`, linked to the now-locked appointment)
  - Immediately transitions idle → `awaiting_reply` via StateEngine
  - Stores first AI message: "Got it — I've reserved [date] at [time] for you. I'll send a confirmation shortly."
  - Returns `{ conversationId, appointmentId }`
  - On `SlotConflictError`: returns `409` with `{ code: 'SLOT_TAKEN' }` — client app refreshes slot list

**Backend — Edge-case booking approval (in-chat only):**
- Add `'booking_request'` to `LLMIntent` in `src/ai/types.ts`
- `messageProcessor.ts` — `booking_request` intent handling:
  - Fires when LLM detects client is requesting a booking *in chat* that the AI cannot auto-confirm (unusual service, custom duration, ambiguous request)
  - `booking_routed_to_staff` event → `awaiting_approval` via StateEngine
  - AI sends: "I've passed your request to the office for review. I'll get back to you shortly — usually within a couple of hours."
  - Emits `booking_request_pending` to staff channel via `emitBookingRequestPending()`
  - Enqueues `booking-approval-timeout` job at `booking_approval_timeout_hours` (Business.settings, default 2)
- While in `awaiting_approval`, additional `message_received` → holding reply, no LLM call
- `PATCH /api/v1/conversations/:id/booking` (`requireAuth`, `requireRole('admin', 'staff')`):
  - Body: `{ action: 'approve' | 'reject' }`
  - Both: cancel `booking-approval-timeout` job via `jobId.bookingApprovalTimeout()`
  - Approve: → `slot_offered`; AI calls `slotManager.findBestSlot()`, sends slot to client (or → `waitlisted` if none)
  - Reject: AI sends "Unfortunately the office isn't able to accommodate that request. Let me check what's available."; → `slot_offered` or `waitlisted`
- `src/jobs/processors/bookingApprovalTimeout.ts` — stub → real:
  - Same outcome as reject: AI informs client, checks for alternatives
- `Business.settings`: add `booking_approval_timeout_hours` (default `2`)
- `GET /api/v1/conversations`: add `?state=awaiting_approval` filter to surface pending approvals

**Client mobile app (`client-mobile/`):**
- New **Book** tab (or screen accessible from the Tab Navigator):
  - Calls `GET /api/v1/client/slots` on mount
  - Displays available slots in a list (date, time, service type)
  - "Book" button on each slot → calls `POST /api/v1/client/bookings`
  - On `409 SLOT_TAKEN`: show "That slot was just taken — refreshing..." and reload list
  - On success: navigate to Chat tab (the new conversation is now visible)

**Staff web (`staff-web/src/`):**
- ApproveBooking page wired to real `PATCH /api/v1/conversations/:id/booking`
- WebSocket: on `booking_request_pending` event → highlight pending approval conversations on list page

**Tests (`backend/src/__tests__/`):**
- `waitlist.test.ts`: slot freed → waitlist checked → oldest matching entry offered → reminder at T+25 → timeout at T+30 → move to next entry; skip `scheduled` entries
- `clientBooking.test.ts`: client calls POST /bookings → appointment locked → conversation created in awaiting_reply; race condition (two clients book same slot) → 409 on second
- `bookingApproval.test.ts`: in-chat booking_request → awaiting_approval → approve → slot offered; reject → slot offered or waitlisted; timeout → same as reject
- `waitlist.integration.test.ts`: full re-engagement path — slot released → offer sent → client accepts → `confirmed`

**Dependencies:** Phase 4 (slotManager, WaitlistEntry), Phase 5 (emitters, staff endpoints), Phase 3 (Conversation creation pattern), Phase 1 (StateEngine).

**Done when:** Freed slots automatically surface to the best-matched waitlisted client; client can pick a slot in the mobile app and receive an AI confirmation; edge-case in-chat requests route through staff approval; all three paths tested end-to-end.

---

## Phase Summary

| Phase | Name | Key Output | Depends On |
|---|---|---|---|
| 1 | State Machine Core | All 14 states + transition guards enforced in DB | F001, F002 complete |
| 2 | Message Processing Pipeline | LLM intent → event → state in one call | Phase 1 |
| 3 | Happy Path + Follow-Up Sequence | Full outreach-to-confirmed flow; auto-pickup watcher | Phase 2 |
| 4 | Rescheduling + Slot Management | Decline → preferences → slot offered → confirmed or waitlisted | Phase 3 |
| 5 | Escalation + Staff Control | AI handoff; staff takeover/return/close; dashboard live updates | Phase 3 |
| 6 | Waitlist Engine + Booking Approval | Released slots re-engage waitlist; client booking routes through staff | Phases 4 + 5 |

Phases 1–3 are strictly sequential. Phase 4 and Phase 5 are independent of each other (both depend on Phase 3) and can be built in parallel. Phase 6 requires both Phase 4 and Phase 5.
