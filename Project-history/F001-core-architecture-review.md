# F001 — Core Architecture — Review & Decisions

**Linked spec:** [F001-core-architecture-spec.md](F001-core-architecture-spec.md)
**Specs spawned here:** [F002-auth-spec.md](F002-auth-spec.md) (C4) · [F003-ai-conversation-state-machine-spec.md](F003-ai-conversation-state-machine-spec.md) (C6) · F004-business-onboarding-spec.md (G3, not yet written)
**Created:** 2026-05-05
**Purpose:** Track issues found in the spec, discuss solutions, record decisions, then update the spec accordingly.

**Issue status:** `Open` | `Decided` | `Applied`

---

## Critical Issues

---

### C1 — Diagram shows AI talking directly to client

**Status:** Decided · Applied

**Issue:** The diagram draws a direct line from the AI Engine to the client app. In reality the AI generates a message, hands it to the backend, and the backend delivers it. If a developer follows the diagram as drawn, they'll wire it wrong.

**Options:**

- A: AI Engine → Backend → WebSocket → Client *(correct separation)*
- B: AI Engine owns its own WebSocket connection to clients *(bad — mixes concerns)*

**Recommendation: Option A.**
The backend owns all connections. The AI is just a service the backend calls. This is the standard pattern and keeps the AI engine swappable later.

**Decision:** Option A — AI Engine hands message to Backend → Real-time Layer → Client.
**Notes:** Diagram updated in spec. Real-time Layer added as an explicit node between AI Engine and Client.

---

### C2 — Staff real-time connection not in diagram or modules

**Status:** Decided · Applied

**Issue:** Staff need to see live conversations too — to monitor and take over. The diagram only shows the client receiving via WebSocket. The staff web app is missing from the real-time layer entirely.

**Options:**

- A: Same WebSocket server handles both staff and client, separated by role-based rooms/channels
- B: Separate WebSocket server for staff only

**Recommendation: Option A.**
One server, two channel types. Simpler infrastructure, half the cost, no sync issues between servers.

**Decision:** Option A — one WebSocket server, role-based channels (/staff/{business_id} and /client/{client_id}).
**Notes:** Diagram updated — staff web app now shows both REST and WebSocket connections to backend. Real-time Layer updated with channel structure.

---

### C3 — No takeover state: AI and staff could reply simultaneously

**Status:** Decided · Applied

**Issue:** The spec says staff can take over a conversation but never defines how the system knows to pause the AI. Without a state flag, the AI and a staff member could both reply to the same client at the same time.

**Options:**

- A: Add a `conversation_status` field: `ai_active | staff_takeover | resolved`
- B: Use the existing `taken_over_by` field — if not null, AI is paused; if cleared, AI resumes

**Recommendation: Option B.**
The field already exists in the database. No new field needed. Null = AI active. Set = AI paused. Simple rule, easy to implement.

**Decision:** Option B — `taken_over_by` null = AI active; set to staff_user_id = AI paused. Staff clicks "Return to AI" to clear it.
**Notes:** Conversation entity updated in spec — removed messages[], clarified taken_over_by behavior inline.

---

### C4 — No authentication or authorization model defined

**Status:** Decided · Applied

**Issue:** The Auth Service module is listed but never specified. There is no description of:

- How staff accounts are created (who creates the first admin? Can staff invite other staff?)
- What roles exist and what each role can do (e.g. can a receptionist take over AI conversations? Can they delete appointments?)
- How the client short code auth flow works end-to-end (token issued? session persisted how?)
- How sessions are managed and revoked

A developer cannot build auth without this. It touches every other module.

**Options:**

- A: Define auth in this spec — roles, session model, token lifecycle
- B: Defer to a dedicated auth spec (F002), reference it from here

**Recommendation: Option B.**
Auth is complex enough to deserve its own spec. Reference it from F001 so the dependency is clear, but keep the detail in one place.

**Decision:** Option B — full auth spec created as F002. Auth Service module in F001 now references F002.
**Notes:** See [F002-auth-spec.md](F002-auth-spec.md) for complete auth model including roles, session lifecycle, and token design.

---

### C5 — Diagram has a broken WebSocket line for staff

**Status:** Decided · Applied

**Issue:** The staff web app shows a WebSocket arrow but it points nowhere — it goes into the Backend API box and stops. The Real-time Layer (WebSocket Server) is below the backend, connected only to the AI Engine output. There is no line from the backend or Real-time Layer back up to the staff web app. A developer reading this diagram would not know how staff receives live updates. The diagram contradicts the text.

**Options:**

- A: Fix the diagram — draw the line from Real-time Layer back up to the staff web app
- B: Redraw diagram with clearer layout

**Recommendation: Option A.**
The decision (C2) was correct — just the diagram render is broken. Fix the arrow.

**Decision:** Option A — diagram restructured. Staff now shows two explicit arrows: REST to Backend API, WebSocket directly to Real-time Layer. Real-time Layer connects down to Client only.
**Notes:** Diagram redrawn in spec to side-by-side layout — Backend API left, Real-time Layer right, Client below Real-time Layer.

---

### C6 — AI Engine has no defined conversation state machine

**Status:** Decided · Applied

**Issue:** The spec says the AI "determines intent" and handles confirm / can't make it / question — but there is no defined state machine for a conversation. What states can a conversation be in? What triggers transitions? What happens if the AI receives an ambiguous message? What happens if a client replies with something completely off-topic (e.g. "who is this?")? Without a state machine, every developer will build this differently.

**Options:**

- A: Define the state machine inline in this spec
- B: Define it in the AI Engine module spec (future feature spec)

**Recommendation: Option B.**
A full state machine belongs in the AI Engine feature spec. This spec should note that a state machine is required and reference the future spec.

**Decision:** Option B — full state machine defined and approved in F003. F001 AI Engine module and Conversation entity updated to reference F003.
**Notes:** See [F003-ai-conversation-state-machine-spec.md](F003-ai-conversation-state-machine-spec.md). 13 states, full transition table, LLM protocol, escalation rules, edge cases, and all data model additions documented and approved.

---

### C7 — "AI unable to handle response" trigger is undefined

**Status:** Decided · Applied

**Issue:** The Staff Alert System says staff are notified when "AI is unable to handle response" — but there is no definition of what that means technically. How does the AI know it can't handle something? Is there a confidence threshold? Does it always escalate certain message types? This is a critical product behavior with no implementation guidance.

**Options:**

- A: Define escalation rules in this spec (e.g. specific message types always escalate)
- B: Defer to AI Engine spec — list this as a required output of that spec

**Recommendation: Option B.**
The escalation logic lives inside the AI Engine. This spec should state that the AI Engine must emit an "escalate" signal and that the backend routes it to staff alerts, without defining the AI-side rules here.

**Decision:** Option A — Staff Alert System module updated with the exact escalation triggers from F003. Reference to F003 added for full detail.
**Notes:** Escalation triggers: client requests human, ambiguous intent on 2nd occurrence, off-topic on 2nd occurrence, distress keyword detected, LLM API failure. Defined in F003 Section: Escalation Rules.

---

### C8 — Conversation entity missing business_id

**Status:** Decided · Applied

**Issue:** Every other entity has `business_id` for row-level isolation (G2 decision). The Conversation entity is missing it. A query for all conversations belonging to a business has no direct filter — it would require a join through Appointment → Schedule → Business. This is a data model gap that will cause performance and isolation bugs.

**Options:**

- A: Add `business_id` directly to the Conversation entity — consistent with G2 convention, enables direct filtering with no joins, single field addition with no structural impact
- B: Leave it as-is and query via join — avoids a schema change but every conversation query pays a multi-table join cost, and any mistake in the join logic risks leaking data across businesses

**Recommendation: Option A.**
Consistent with the G2 convention. Every entity carries `business_id`. The fix is a single field addition with no downside.

**Decision:** Option A — `business_id` added to Conversation entity.
**Notes:** Consistent with row-level isolation convention applied to all other entities.

---

## Missing Flows

---

### M1 — Returning clients have no defined path

**Status:** Decided · Applied

**Issue:** Step 4 of the data flow says "for new clients: send download link + short code." There is no step for a returning client who already has the app installed.

**Options:**

- A: Check `app_registered` flag on the Client record — if true, skip onboarding and message directly via the app
- B: Always resend the download link regardless

**Recommendation: Option A.**
The `app_registered` flag already exists in the database. Use it. Sending a download link to someone who already has the app is unnecessary friction.

**Decision:** Option A — check app_registered flag; new clients get onboarding, returning clients go straight to AI outreach.
**Notes:** Data flow in spec updated — step 4 now branches on app_registered. Step 5 also sets the flag to true after successful install.

---

### M2 — No plan for clients who never respond

**Status:** Decided · Applied

**Issue:** If a client ignores the AI's initial message, the spec gives no instruction. The slot stays in limbo indefinitely.

**Options:**

- A: AI sends one follow-up after a configurable time window (e.g. 24 hours), then flags the conversation for staff
- B: AI does nothing; appointment is automatically flagged as `no-response` after 24 hours and staff is notified
- C: Staff configures follow-up behavior per office

**Recommendation: Option B for V1.**
Simple, no extra AI logic needed. The system marks it `no-response`, staff decides what to do. Option C is a good future enhancement once offices start using it and have preferences.

**Decision:** Custom approach combining Options A + C. Three timed follow-ups (T+5min, T+1hr, T−5min before deadline), all office-configurable. Slot auto-released at deadline. Waitlist triggered on release. See M5 for waitlist detail.
**Notes:** Follow-up schedule, waitlist flow, Job Scheduler module, and updated database entities all added to spec.

---

### M3 — Staff has no alert system

**Status:** Decided · Applied

**Issue:** Staff can "take over any time" but the spec doesn't describe how they know when to. If a client says something the AI can't handle, staff has no way to know without manually browsing all conversations.

**Options:**

- A: Conversation dashboard with color-coded status (needs attention / AI active / confirmed / no-response)
- B: Push or in-app notification to staff when a conversation is flagged
- C: Both — dashboard as the base, notifications as alerts

**Recommendation: Option A first, Option C later.**
A status dashboard is foundational — staff need it regardless. Notifications are a layer on top. Build the dashboard in V1; add notification triggers in V2.

**Decision:** Option C in two steps — dashboard first, notifications second. Alert triggers: AI can't handle response, deadline missed, client requests human, slot released.
**Notes:** Staff Dashboard and Staff Alert System added as modules in spec.

---

### M4 — Short code lifecycle not defined

**Status:** Decided · Applied

**Issue:** The spec mentions a short code for new client onboarding but doesn't define how long it's valid, what happens when it expires, or what to do if a client never downloads the app.

**Options:**

- A: Short code never expires, permanently tied to the client record
- B: Short code expires after 48 hours, staff can manually resend
- C: One-time use only — expires on first use OR after 48 hours, whichever comes first; staff resends if needed

**Recommendation: Option C.**
Most secure. A short code that never expires is a security risk. One-time use + 48-hour window is the standard approach. Staff resend is a simple button.

**Decision:** Option C — one-time use, expires on redemption or after 48 hours. Staff can resend via a button.
**Notes:** ClientInvite table already accounts for this with expires_at and used_at fields.

---

### M5 — Waitlist system not in spec

**Status:** Decided · Applied

**Issue:** When no available slots match a client's needs, there was no system to track them and reach out when a slot opens up. This was identified during the M2 discussion.

**Full flow decided:**

1. Client cannot be scheduled → AI asks for their day/time preferences → stored as a WaitlistEntry
2. When a slot is released (deadline missed, cancellation, no-response):
   - AI checks waitlist in order (first in, first served)
   - LLM compares each person's preferences against the open slot
   - First match → AI reaches out immediately with the slot offer
   - Confirms → booked, WaitlistEntry marked `scheduled`
   - Declines or no response → AI moves to next person on list

**New database entity added:**

| Field | Purpose |
| --- | ---|
| id | primary key |
| client_id | who is waiting |
| business_id | which office |
| preferences | stated day/time preferences (text) |
| status | `waiting` / `notified` / `scheduled` |
| created_at | determines waitlist order |

**Decision:** Waitlist system built into core architecture. LLM handles preference matching — no separate algorithm needed.
**Notes:** WaitlistEntry table added to spec. Waitlist flow added to data flow section. Waitlist trigger added to Job Scheduler module description.

---

## Data Model Issues

---

### D1 — `messages[]` inside Conversation entity is incorrect

**Status:** Decided · Applied (resolved under C3)

**Issue:** In a relational database like Postgres, you cannot store an array of messages inside a table row. The Message table already handles this correctly as a separate entity. The `messages[]` field in Conversation is contradictory and will confuse developers.

**Options:**

- A: Remove `messages[]` from the Conversation entity — the relationship is implied by the Message table
- B: Keep it as a note but mark it as a "relationship, not a field"

**Recommendation: Option A.**
Remove it. The Message table already defines the relationship. No annotation needed.

**Decision:** —
**Notes:** —

---

### D2 — Appointment statuses are incomplete

**Status:** Decided · Applied (resolved under M2)

**Issue:** Current statuses (`booked / available / confirmed / rescheduled`) are missing states that will definitely occur during normal operation.

**Options:**

- Full status set: `pending-outreach | ai-active | confirmed | rescheduled | cancelled | no-response`

**Recommendation:** Adopt the full set above.

- `pending-outreach` — slot assigned, AI hasn't messaged yet
- `ai-active` — conversation in progress
- `confirmed` — client confirmed
- `rescheduled` — moved to a different slot
- `cancelled` — client or staff cancelled
- `no-response` — no reply after timeout window

**Decision:** —
**Notes:** —

---

### D3 — Available slots have no clear home in the database

**Status:** Decided · Applied

**Issue:** The spec describes the Slot Manager handling available slots, but the database has no clear definition of what an "available slot" looks like as a row.

**Options:**

- A: Available slots are Appointment rows with `status = available` and no `client_id` (null)
- B: Separate `AvailableSlot` table independent of Appointment

**Recommendation: Option A.**
An Appointment row with `status = available` and null `client_id` IS the available slot. No extra table needed. When a client picks it, the `client_id` is filled and the status updates. Simple.

**Decision:** Option A — available slots are Appointment rows with status=available and client_id=null. `available` also restored to the full status list (was accidentally dropped in M2).
**Notes:** Appointment entity updated — client_id marked nullable, `available` added back as first status in the set.

---

### D4 — Short code has no database table

**Status:** Decided · Applied

**Issue:** The spec describes generating and validating short codes for client onboarding but there is no entity in the database to store them.

**Recommendation:** Add a `ClientInvite` table:

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid | primary key |
| client_id | uuid | links to Client |
| business_id | uuid | links to Business |
| short_code | string | 6-digit or alphanumeric |
| expires_at | timestamp | 48 hours from creation |
| used_at | timestamp | null until redeemed |

**Decision:** ClientInvite table added to spec as described.
**Notes:** Consistent with M4 decision — one-time use, 48hr expiry enforced via expires_at and used_at fields.

---

## Important Gaps

---

### G3 — No onboarding flow for the business (office) itself

**Status:** Decided · Applied

**Issue:** The spec defines the client onboarding flow (short code, download link) but never defines how a new office signs up, creates their account, adds staff members, or configures their settings. There is no Business creation flow anywhere.

**Options:**

- A: Add a business onboarding section to this spec — keeps everything in one place but bloats F001, which is scoped to core architecture, not individual feature flows
- B: Defer to a dedicated business onboarding spec (F004) — keeps F001 focused, and onboarding is a distinct surface (signup UI, billing, settings wizard) that warrants its own spec

**Recommendation: Option B.**
Business onboarding touches billing, admin account creation, settings configuration, and potentially a wizard UI — all distinct from core architecture. F001 notes the dependency; F004 carries the detail.

**Decision:** Option B — deferred to F004 (business onboarding spec). F001 Out of Scope section updated to note this dependency.
**Notes:** F004 will cover: first admin account creation, business settings wizard, staff invitation flow at setup, and billing integration.

---

### G4 — Staff roles and permissions not specified

**Status:** Decided · Applied

**Issue:** Staff User has a `role` field but no roles are defined. Can all staff trigger outreach? Take over conversations? Invite other staff? Delete clients? Without role definitions, access control cannot be built.

**Options:**

- A: Define roles in this spec
- B: Define roles in the auth spec (deferred under C4)

**Recommendation: Option B.**
Roles belong in the auth spec alongside the permission model. Reference from here.

**Decision:** Option B — roles fully defined in F002. Three roles: Admin (full access), Staff (operational + designatable permissions: can_trigger_outreach, can_edit_schedule), Viewer (read-only). F001 StaffUser entity references F002 for detail.
**Notes:** See [F002-auth-spec.md](F002-auth-spec.md) for complete role and permission definitions.

---

### G5 — No error states defined anywhere

**Status:** Decided · Applied

**Issue:** What happens when:

- The LLM API is down?
- A push notification fails to deliver?
- The calendar sync fails mid-import?
- A job in the scheduler fails to fire?

None of these are addressed. The spec describes happy paths only.

**Options:**

- A: Add error handling notes per module in this spec
- B: Defer to individual feature specs — each module handles its own failure modes

**Recommendation: Option B.**
Error handling detail belongs at the module level. This spec should note that each module must define its failure behavior; individual specs carry the implementation.

**Decision:** Option B — F001 adds a blanket requirement that every module must define its failure behavior in its own spec. LLM failure is already handled in F003 (escalation trigger). Remaining modules (Calendar Sync, Job Scheduler, Push Notifications) cover error states in their own future specs.
**Notes:** Blanket error handling requirement added to F001 Architecture Principles section.

---

### G6 — Follow-up schedule has no cancellation logic

**Status:** Decided · Applied

**Issue:** The schedule states T+5min sends the first follow-up, then T+1hr after first follow-up sends the second. But if the client responds between T+5min and T+1hr, does the scheduled job get cancelled? There is no cancellation logic for follow-up jobs when a client responds mid-sequence.

**Options:**

- A: When a client responds, the Job Scheduler cancels all pending follow-up jobs for that conversation
- B: Follow-ups always fire regardless; AI detects the response and skips the follow-up message

**Recommendation: Option A.**
Cancelling pending jobs is the correct behavior. Sending a follow-up to a client who already replied is bad UX.

**Decision:** Option A — any incoming client message cancels all pending follow-up jobs for that conversation ID. Job Scheduler must store job IDs per conversation to enable cancellation.
**Notes:** Job Scheduler module updated in spec — conversation follow-up jobs are keyed by conversation_id and cancelled on client reply.

---

### G7 — Waitlist response timeout not defined

**Status:** Decided · Applied

**Issue:** The waitlist flow says if the notified client "declines or no response → AI moves to next person." But there is no defined timeout for "no response." How long does the AI wait before moving to the next person?

**Options:**

- A: Fixed 30-minute timeout — not configurable; AI sends two messages within the window
- B: Office-configurable timeout per business settings

**Recommendation: Option A.**
Fixed window keeps the behavior predictable and removes a config decision from offices. Two-message sequence enforces urgency clearly.

**Decision:** Option A — fixed 30-minute window. Two-message sequence:
1. **Slot offer (T+0):** "This slot is available for you — if we don't hear back within 30 minutes it will be assigned to someone else."
2. **Reminder (T+25min):** "5 minutes left — are you confirming this slot or not?"
- Yes → booked, WaitlistEntry marked `scheduled`
- No → move to next person on waitlist
- No response at T+30min → move to next person on waitlist

**Notes:** Waitlist flow and WaitlistEntry status transitions updated in spec. Reminder job keyed by conversation_id and cancelled on client reply (same pattern as G6).

---

### G8 — Client account deletion / offboarding not defined

**Status:** Decided · Applied

**Issue:** What happens when a client wants to stop receiving messages? Is there an opt-out mechanism? No offboarding or data deletion flow is described.

**Options:**

- A: Client can opt out via the app — sets a flag that stops all AI outreach
- B: Staff manually deactivates the client record
- C: Both — client self-service + staff override

**Recommendation: Option A for V1.**
Self-service opt-out is the minimum. Staff override is useful but secondary. Flag on the Client entity stops the Job Scheduler from triggering outreach.

**Decision:** Option C — both client self-service opt-out and staff manual deactivation. Client taps opt-out in app → sets `opted_out` flag on Client record. Staff can also set the same flag from the dashboard. Job Scheduler checks `opted_out` before firing any outreach job for that client.
**Notes:** `opted_out` field added to Client entity. Both surfaces (client app + staff dashboard) must expose the control.

---

### G9 — Business settings field is a black box

**Status:** Decided · Applied

**Issue:** The Business entity has a `settings` field but it is never defined. This is where follow-up timing configuration, deadline defaults, office preferences, and waitlist timeout would live — but it is completely unspecified.

**Options:**

- A: Define the settings schema in this spec (list of known keys and types)
- B: Defer to business onboarding spec (deferred under G3)

**Recommendation: Option A.**
The keys are already known from decisions in this review and F003. Define them here with defaults. F004 references F001 for the schema when building the settings UI.

**Decision:** Option A — settings schema defined in F001 Business entity. Full schema:

| Key | Type | Default | Source |
| --- | --- | --- | --- |
| `outreach_response_window_hours` | integer | 2 | M2 |
| `outreach_hours_start` | time | 09:00 | F003 |
| `outreach_hours_end` | time | 19:00 | F003 |
| `auto_pickup_interval_minutes` | integer | 5 | F003 |
| `escalation_keywords` | string[] | [] | F003 |

**Notes:** Business entity updated in spec with settings schema. F004 will reference this schema for the configuration UI.

---

### G10 — No definition of what "confirmed" means to the office

**Status:** Decided · Applied

**Issue:** When a slot is confirmed by a client, what does the office see? Does the appointment status update in real-time on the staff dashboard? Does the staff member who built the schedule get a notification? The post-confirmation state from the staff perspective is never described.

**Options:**

- A: Confirmed appointment updates on the dashboard in real-time (via WebSocket) with no separate notification
- B: Confirmed appointment triggers both a dashboard update and a staff notification

**Recommendation: Option B.**
A confirmation is actionable — staff shouldn't need to be watching the dashboard to know about it. The Staff Alert System already exists; "appointment confirmed" is one more trigger.

**Decision:** Option B — confirmed appointment triggers a real-time dashboard update (WebSocket) AND an in-app staff notification. "Appointment confirmed" added to the Staff Alert System trigger list.
**Notes:** Staff Alert System module updated in spec — confirmation trigger added alongside the existing escalation triggers.

---

## Minor Gaps

---

### G1 — Calendar sync direction not defined

**Status:** On Hold

**Issue:** The spec describes importing schedules from Google/Outlook into the app but doesn't say whether confirmed appointments should write back to the office's calendar.

**Options:**

- A: One-way only — import into app, nothing written back
- B: Two-way — import in, write confirmed appointments back to office calendar

**Recommendation: Option A for V1.**
Two-way sync adds significant complexity (conflict handling, permission scopes, error states). Get the core loop working first. Two-way is a strong V2 feature.

**Decision:** —
**Notes:** —

---

### G2 — Multi-tenancy isolation not addressed

**Status:** Decided · Applied

**Issue:** The Business entity exists but the spec doesn't describe how data is isolated between businesses. One office must never see another's clients or schedules.

**Options:**

- A: Row-level isolation — every database query filters by `business_id`
- B: Schema-per-tenant — each business gets its own database schema

**Recommendation: Option A.**
Standard for early-stage SaaS. Simpler to build and maintain. `business_id` is already on every entity. Can migrate to schema-per-tenant later if scale demands it.

**Decision:** Option A — row-level isolation, every query filters by business_id. Convention documented in spec.
**Notes:** Already reflected in reference_arch.md conventions. No schema change needed.

---

## Clarifications Needed

---

### CL1 — React Native vs. Flutter — decision deferred but blocking

**Status:** Decided · Applied

**Issue:** Listed as an open question but not minor. The choice affects the entire mobile development toolchain, library ecosystem, and developer hiring. Must be decided before any mobile code is written.

**Decision:** React Native — same language as the staff web app (TypeScript/JavaScript), shared patterns and potentially shared logic, larger talent pool, extensive ecosystem.
**Notes:** Architecture reference updated — client mobile app is React Native.

---

### CL2 — Backend language — Node.js or Python — not decided

**Status:** Decided · Applied

**Issue:** Listed as TBD. Affects the Job Scheduler library choice (Bull vs. Celery), the LLM SDK used, and team composition. Cannot be left open at build time.

**Decision:** Node.js (TypeScript) — same language as React and React Native; one language across the full stack; Bull for job queue; Ollama JS SDK for local model testing; OpenAI-compatible endpoint means the same AI Engine code works with local model, Claude, or OpenAI by swapping config only.
**Notes:** Architecture reference updated — backend is Node.js, job queue is Bull. AI Engine must use a provider abstraction layer (base URL + API key in config) to enable local → production swap without code changes.

---

### CL3 — First-contact channel — SMS or email or both

**Status:** Decided · Applied

**Issue:** The spec says "one-time SMS (Twilio) or email (SendGrid)" in multiple places but never decides which. Developers cannot build the First Contact Bootstrap module without knowing which to implement.

**Options:**

- A: SMS only — higher open rate, more immediate
- B: Email only — lower cost, no carrier dependencies
- C: Both — SMS first, email fallback

**Recommendation: Option B for V1.**
Email only keeps V1 simple and cost-free at the provider level. SMS added in next phase once the core loop is proven.

**Decision:** Option B for V1 — email only via SendGrid. Twilio/SMS deferred to next phase. First Contact Bootstrap module built for email; SMS slot reserved in the architecture.
**Notes:** First Contact Bootstrap module updated in spec — V1 is email only (SendGrid). Twilio removed from V1 dependencies. SMS added as a planned next-phase enhancement.

---

### CL4 — What does "staff takes over" look like to the client?

**Status:** Decided · Applied

**Issue:** When staff takes over a conversation, does the client know? Does the sender name change? Does the client see "Office Staff" instead of the AI name? This UX detail has downstream implications for the messaging UI on both sides.

**Options:**

- A: Seamless handoff — no visual change to the client; staff replies look identical to AI replies
- B: Transparent handoff — sender name changes to a staff label (e.g. "Office")

**Recommendation: Option B.**
Transparent handoff is more honest and sets correct client expectations — they know a human is now responding.

**Decision:** Option B — when staff takes over, sender label changes to "Office" (or the business name) in the client app. AI messages show as the AI persona; staff messages show as "Office." Message entity already has `sender` field (ai/client/staff) — client app renders label based on this.
**Notes:** Client app messaging UI must differentiate sender labels. Message.sender field already supports this — no schema change needed.

---

### CL5 — Can a client have multiple active appointments?

**Status:** Decided · Applied

**Issue:** If a client has two upcoming appointments with the same office, can they have two concurrent AI conversations? The data model allows it (Conversation links to Appointment, not just Client) but the behavior is never described.

**Options:**

- A: Allow multiple concurrent conversations — each Appointment has its own thread
- B: One active conversation per client at a time — new outreach waits until current one resolves

**Decision:** Neither — superseded by a persistent thread model. One conversation thread per client-business pair (1:1 client_id + business_id). Multiple appointment requests are handled concurrently within the same thread. AI tracks each in-flight request independently and reports back as each resolves. No separate threads, no queuing.

**Additional decision — client-initiated booking:**
Established clients can message in to request an appointment. AI asks for details if needed, then routes:
- **AI confident** (routine request, known service type) → schedules directly, no staff notification
- **AI uncertain** (unusual or ambiguous request) → sends staff a notification with request details → staff approves → AI proceeds to schedule

**Data model changes:**
- `Conversation.appointment_id` removed — Conversation is now per (client_id, business_id)
- `Appointment.service_type` field added — captures what the appointment is for (e.g. "general dentist", "massage")
- Staff Alert System gains a new trigger: "Client booking request needs approval"

**Notes:** F003 state machine requires a new inbound booking path (auto-schedule branch + staff-approval branch). F001 data model updated with above changes.

---

### CL6 — Who can trigger outreach — any staff or only admins?

**Status:** Decided · Applied

**Issue:** "Trigger Outreach" is a high-stakes action — it sends messages to every client simultaneously. The spec doesn't say whether any staff member can do this or if it's restricted to specific roles.

**Options:**

- A: Any staff member can trigger outreach
- B: Admins and staff explicitly designated by an admin can trigger outreach

**Recommendation: Option B.**
High-blast actions must be role-restricted. Admin always has permission; Staff only if Admin has granted the designatable permission.

**Decision:** Option B — Admins can always trigger outreach. Staff members can only trigger outreach if Admin has assigned them the `can_trigger_outreach` designatable permission (defined in F002). Viewer role cannot trigger outreach under any circumstance.
**Notes:** Already covered by F002 permission model. No additional spec change needed — reference to F002 confirmed.

---

### CL7 — LLM provider not decided

**Status:** Decided · Applied

**Issue:** Claude API vs. OpenAI is listed as open. The choice affects the AI Engine implementation, prompt engineering approach, rate limits, and cost structure. Needs a decision before the AI Engine is built.

**Decision:** Ollama (local model) for development and testing. Production provider TBD — deferred until after the core loop is built and tested. Provider abstraction layer (decided in CL2) ensures switching to Claude API or OpenAI requires only a config change (base URL + API key), no code rewrite.
**Notes:** AI Engine built against the OpenAI-compatible Ollama endpoint. Production provider decision deferred to a future phase decision point.

---

## Decision Log

| # | Issue | Decision | Date |
| --- | --- | --- | --- |
| C1 | AI talks directly to client in diagram | Option A — Backend + Real-time Layer owns delivery | 2026-05-05 |
| C2 | Staff real-time connection missing | Option A — one WebSocket server, role-based channels | 2026-05-05 |
| C3 | No takeover state defined | Option B — taken_over_by null/set controls AI pause | 2026-05-05 |
| M1 | Returning clients had no path | Option A — branch on app_registered flag | 2026-05-05 |
| M2 | No plan for non-responding clients | Three timed follow-ups + deadline release + waitlist trigger | 2026-05-05 |
| M3 | Staff had no alert system | Option C — dashboard first, notification triggers second | 2026-05-05 |
| M4 | Short code lifecycle undefined | Option C — one-time use, 48hr expiry, staff resend button | 2026-05-05 |
| D1 | messages[] in Conversation entity | Removed — already fixed under C3 | 2026-05-05 |
| D2 | Appointment statuses incomplete | Full status set applied under M2 | 2026-05-05 |
| D3 | Available slots had no database home | Option A — Appointment row with status=available, client_id=null | 2026-05-05 |
| D4 | Short code had no database table | ClientInvite table added with expires_at and used_at | 2026-05-05 |
| G1 | Calendar sync direction | On Hold — decision deferred | 2026-05-05 |
| G2 | Multi-tenancy isolation | Option A — row-level isolation, business_id filter on all queries | 2026-05-05 |
| C4 | No auth/authorization model defined | Option B — deferred to F002 auth spec | 2026-05-05 |
| C5 | Broken WebSocket line for staff in diagram | Option A — diagram restructured; Staff WebSocket now connects directly to Real-time Layer | 2026-05-05 |
| C6 | AI Engine has no conversation state machine | Option B — full state machine defined in F003; F001 updated to reference it | 2026-05-05 |
| C7 | "AI unable to handle" trigger is undefined | Option A — Staff Alert System updated with 7 exact escalation triggers from F003 | 2026-05-05 |
| C8 | Conversation entity missing business_id | Option A — business_id added to Conversation entity | 2026-05-05 |
| G3 | No business onboarding flow | Option B — deferred to F004; Dependencies section added to F001 | 2026-05-05 |
| G4 | Staff roles and permissions not specified | Option B — defined in F002; three roles with designatable permissions | 2026-05-05 |
| G5 | No error states defined | Option B — each module defines failure behavior in its own spec; blanket requirement added to F001 | 2026-05-05 |
| G6 | Follow-up schedule has no cancellation logic | Option A — client reply cancels all pending follow-up jobs for that conversation | 2026-05-05 |
| G7 | Waitlist response timeout not defined | Option A — fixed 30-min window; slot offer at T+0, reminder at T+25min; no response = move to next | 2026-05-05 |
| G8 | Client offboarding not defined | Option C — client self-service opt-out + staff deactivation; opted_out flag on Client entity | 2026-05-05 |
| G9 | Business settings field is a black box | Option A — settings schema defined in F001 with 5 keys and defaults | 2026-05-05 |
| G10 | No definition of "confirmed" from staff perspective | Option B — dashboard update + staff notification; confirmation added to Staff Alert System | 2026-05-05 |
| CL1 | React Native vs. Flutter — blocking decision | React Native — same language as web staff app, larger ecosystem | 2026-05-05 |
| CL2 | Backend language — Node.js or Python | Node.js (TypeScript) — full-stack JS, Bull job queue, provider-agnostic AI Engine | 2026-05-05 |
| CL3 | First-contact channel — SMS or email or both | Option B for V1 — email only (SendGrid); SMS via Twilio deferred to next phase | 2026-05-05 |
| CL4 | Staff takeover UX — what does client see? | Option B — transparent handoff; sender label changes to "Office" when staff replies | 2026-05-05 |
| CL5 | Can a client have multiple active appointments? | Persistent thread per client-business pair; parallel requests handled in one thread; client-initiated booking with AI confidence routing | 2026-05-05 |
| CL6 | Who can trigger outreach — any staff or admins only? | Option B — Admins always; Staff only with can_trigger_outreach permission assigned by Admin | 2026-05-05 |
| CL7 | LLM provider not decided | Ollama (local) for dev/testing; production provider TBD via config swap | 2026-05-05 |
| M5 | Waitlist system missing | LLM-matched waitlist, first-in-first-served, triggered on slot release | 2026-05-05 |

---

## Applied to Spec

| # | Issue | Applied | Date |
| --- | --- | --- | --- |
| C1 | Diagram fixed — Real-time Layer node added between AI Engine and Client | Yes | 2026-05-05 |
| C2 | Diagram fixed — staff WebSocket connection added; channel structure added to Real-time Layer | Yes | 2026-05-05 |
| C3 | Conversation entity updated — messages[] removed, taken_over_by behavior documented | Yes | 2026-05-05 |
| M1 | Data flow updated — step 4 branches on app_registered; step 5 sets flag on install | Yes | 2026-05-05 |
| M2 | Follow-up schedule + waitlist flow added to data flow; Job Scheduler added to modules | Yes | 2026-05-05 |
| M3 | Staff Dashboard and Staff Alert System added to Key Modules | Yes | 2026-05-05 |
| M4 | No spec change needed — ClientInvite table fields already cover this | Yes | 2026-05-05 |
| M5 | WaitlistEntry table added to database entities; waitlist flow documented in data flow | Yes | 2026-05-05 |
| D3 | Appointment entity updated — client_id nullable, available added to status set | Yes | 2026-05-05 |
| D4 | ClientInvite table added to database entities | Yes | 2026-05-05 |
| G1 | Calendar sync write-back added to Out of Scope as On Hold | Yes | 2026-05-05 |
| G2 | Multi-tenancy section added to spec | Yes | 2026-05-05 |
| C4 | Auth Service module updated to reference F002; StaffUser entity expanded with role/permission fields | Yes | 2026-05-05 |
| C5 | Diagram restructured — Staff WebSocket now connects directly to Real-time Layer; Backend API and Real-time Layer shown side by side | Yes | 2026-05-05 |
| C6 | AI Engine module updated to reference F003; Conversation entity expanded with state machine fields | Yes | 2026-05-05 |
| C7 | Staff Alert System module updated with 7 exact escalation triggers; F003 referenced for full detail | Yes | 2026-05-05 |
| C8 | Conversation entity updated — business_id added as first field | Yes | 2026-05-05 |
| G3 | Dependencies on Future Specs section added to F001 — F004 noted as business onboarding owner | Yes | 2026-05-05 |

---

## Round 3 — Engineering Manager Audit (2026-05-05)

**Scope:** Full audit of F001-core-architecture-spec.md as it stands after Rounds 1 and 2. All prior issues are resolved. This round audits the document as a developer handoff artifact — can a team build from it without back-and-forth?

---

## Critical Issues

---

### R3-C1 — F003 state machine is incompatible with the persistent thread model

**Status:** Decided · Applied

**Issue:** The CL5 decision changed `Conversation` from a per-appointment thread to a persistent per-(client, business) thread that handles multiple concurrent booking requests. But the Conversation entity has a single `state` field, and F003's state machine is designed as a linear single-appointment flow.

If a client has appointment A in `confirming` and simultaneously initiates a new request for appointment B, `Conversation.state` cannot hold both states. The state machine breaks down entirely with concurrent in-flight requests.

This is the core product feature. The AI Engine cannot be built until this is resolved.

**Options:**

- A: Keep one `state` field on Conversation — restrict to one active booking discussion at a time. New requests are queued until current one resolves. Simpler state machine; clients may experience slight delay.
- B: Extract state to a per-request tracking model — Conversation holds the thread; a new `ConversationRequest` entity (or similar) holds the per-booking state. One record per active booking discussion. Complex but accurate.
- C: State field tracks the thread-level state (idle / active / escalated / staff_active); per-appointment states live on the Appointment record itself. Hybrid approach.

**Recommendation:** Option A for V1. One active booking discussion at a time is simpler, avoids a new entity, and still handles the use case correctly — the second request is acknowledged and queued. The CL5 decision said concurrent requests are tracked independently, but that was describing the UX intent, not necessarily requiring true parallel state machines.

**Decision:** Option A — AI handles one booking request at a time within the persistent thread. F003 state machine is unchanged. If a client starts a second request while one is active, the AI acknowledges it and completes the current booking first: "Once we finish your current booking, I'll help you with that." No new entities required. CL5 spec updated to reflect sequential (not parallel) handling.
**Notes:** F001 Client-Initiated Booking Flow section updated — step 5 now says "sequential" not "concurrent." F003 state machine requires no structural changes.

---

### R3-C2 — No FCM device token storage in the data model

**Status:** Decided · Applied

**Issue:** The Push Notification Service uses Firebase Cloud Messaging (FCM). FCM works by registering a unique device token when the client app is installed and first launched. This token must be stored server-side so the backend can send targeted push notifications.

The Client entity has no `device_token` field, and there is no DeviceToken table. A developer building the Push Notification Service has nowhere to store or retrieve the token. Without the token, no push notification can be sent.

**Options:**

- A: Add `device_token` (string, nullable) and `device_platform` (enum: ios/android, nullable) directly to the Client entity — simple, one device per client
- B: Add a separate `DeviceToken` table — id, client_id, token, platform, created_at — supports multiple devices per client (tablet + phone)

**Recommendation: Option B.** Clients commonly use more than one device (phone + tablet). A separate table is a small addition and avoids needing to migrate later. On new app install, insert a new row; on logout, delete the row.

**Decision:** Option B — `DeviceToken` table added to the data model: id, client_id, business_id, token, platform (ios/android), updated_at. On app launch: upsert token by (client_id, platform). On logout: delete row. Push Notification Service queries `DeviceToken WHERE client_id = ?` to get all active tokens for a client.
**Notes:** DeviceToken entity added to F001 database entities. Push Notification Service module updated to reference token lookup.

---

### R3-C3 — No path to create the first Business and Admin account

**Status:** Open

**Issue:** F004 (business onboarding) is referenced but not yet written. F002 says "when a Business is first created (see G3 — deferred to F004), the first staff account is automatically assigned the Admin role." But there is no API endpoint, no UI, and no CLI command defined for creating the first Business record or seeding the first Admin.

A developer starting the project today has no way to bootstrap the system. Every auth-dependent feature (which is all of them) requires an existing Business and Admin. Without F004, nothing can be tested end-to-end.

**Options:**

- A: Add a one-time seed script (e.g. `npm run seed:admin`) that creates a Business and Admin from environment variables — for dev/testing only; disabled in production
- B: Fast-track F004 with just the minimum: a superadmin endpoint (`POST /internal/bootstrap`) protected by a server secret that creates the first Business + Admin — for production use

**Recommendation: Option C.** Both surfaces serve different needs and together close the gap without waiting for F004.

**Decision:** Option C — both surfaces implemented:
- **Dev:** `npm run seed:admin` reads `SEED_BUSINESS_NAME`, `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` from env vars; creates Business + Admin; no-op when `NODE_ENV=production`
- **Production:** `POST /internal/bootstrap` protected by `BOOTSTRAP_SECRET` header (env var); creates first Business + Admin; returns 409 if a Business already exists (one-time use); F004 builds onboarding UI on top of this endpoint later

**Notes:** System Bootstrap section added to F001 spec. F004 dependency note updated — F004 builds the UI on top of the bootstrap endpoint, not from scratch.

---

### R3-C4 — Client app onboarding flow is undefined

**Status:** Decided · Applied

**Issue:** Step 4 of the data flow says "send one-time email (SendGrid) with app download link + short code." Step 5 says "new client installs app, enters short code → account linked." But none of the following are defined:

- What is the download link? (App Store URL? TestFlight during dev? Universal link?)
- How does the short code reach the app? (Typed manually? Pre-filled from a deep link URL parameter? Shown as a QR code?)
- What does the client see when they open the app for the first time — before entering the short code?
- What happens if the client opens the link on a desktop instead of a mobile device?
- What happens if the link is opened after the app is already installed?

A developer cannot build the First Contact Bootstrap module or the client app onboarding screen without answers to these questions.

**Options:**

- A: Universal link flow — email contains `https://app.[domain]/redeem?code=XXXXXX`. On mobile with app installed: opens app to short code screen with code pre-filled. On mobile without app: redirects to App Store / Google Play, then deep-links on first launch. On desktop: static "open this on your phone" page with code displayed. Dev: TestFlight / Firebase App Distribution with same mechanism.
- B: Manual entry — email contains App Store / Play link separately from the short code as plain text. Client types code manually. No deep linking required but more friction.

**Recommendation: Option A.** Universal links are standard on iOS/Android and are well-supported in React Native. Removes onboarding friction at the most critical moment.

**Decision:** Option A — universal link deep link flow:
- Email contains: `https://app.[domain]/redeem?code=XXXXXX`
- **Mobile, app installed:** universal link opens app → Short Code screen with code pre-filled → one tap to redeem
- **Mobile, app not installed:** redirects to App Store (iOS) or Google Play (Android) → after install, app opens to Short Code screen with code pre-filled via deferred deep link
- **Desktop:** static landing page — "Please open this link on your mobile device" with the code displayed in large text
- **Dev environment:** TestFlight (iOS) / Firebase App Distribution (Android) with same universal link mechanism

**Notes:** Data flow step 4 and step 5 updated in spec to reflect universal link mechanism. Client app onboarding screen added as a defined screen in R3-G3 when that item is resolved.

---

## Important Gaps

---

### R3-G1 — Non-functional requirements are entirely absent

**Status:** Decided · Applied

**Issue:** The spec has no performance targets, no security requirements, no scalability approach, no compliance posture, and no observability plan. A developer reading this document has no constraints to build against.

**Options:**

- A: Add a Non-Functional Requirements section to F001 with explicit V1 baselines
- B: Defer each to its own spec

**Recommendation: Option A for minimums.**

**Decision:** Option A — Non-Functional Requirements section added to F001 with the following V1 baselines:

| Area | V1 Minimum |
| --- | --- |
| Performance | API responses < 500ms (p95); WebSocket delivery < 1s end-to-end; V1 target: 50 concurrent staff, 500 concurrent clients |
| Security | HTTPS/TLS in transit required; data at rest encrypted via managed DB provider; rate limiting on auth endpoints; input sanitized before passing to LLM (prompt injection prevention) |
| Scalability | Bull queue max concurrency: 10 concurrent LLM jobs (configurable); single-instance V1; no auto-scaling required |
| Compliance | No data shared with third parties; client opt-out already implemented; collect only what's needed; HIPAA deferred (in Out of Scope) |
| Observability | Structured logging on all requests and errors; Sentry (or equivalent) for error tracking; Bull Board for queue monitoring; no custom metrics/alerting V1 |

**Notes:** Non-Functional Requirements section added to F001 spec.

---

### R3-G2 — Staff web app pages and screens are not defined

**Status:** Decided · Applied

**Issue:** The diagram lists "Schedule Builder · Slot Manager · Conversation View" in the staff web app box, and the Key Modules table describes backend modules. But there is no description of what the staff web app actually looks like as a set of pages.

**Options:**

- A: Add a Staff Web App Pages section to F001 — page name, route, purpose, key actions
- B: Defer to a dedicated Staff Web App spec (F005 or similar)

**Recommendation: Option A.**

**Decision:** Option A — Staff Web App Pages section added to F001:

| Page | Route | Purpose | Key Actions |
| --- | --- | --- | --- |
| Login | `/login` | Staff sign-in | Email/password login, Google SSO, forgot password |
| Dashboard | `/` | Live conversation overview, color-coded by status | Take over conversation, view thread, acknowledge alerts |
| Schedule Builder | `/schedules` | List and create daily schedules | Create new schedule, view existing |
| Schedule Detail | `/schedules/:id` | View/edit one schedule; trigger outreach | Add/edit/remove appointments, assign clients, trigger outreach |
| Conversation View | `/conversations/:id` | Full message thread for one client | Send message, take over, return to AI |
| Clients | `/clients` | Client list for this business | Add client, view history, opt out, resend invite |
| Client Detail | `/clients/:id` | One client's profile and appointment history | Edit details, opt out, expire session, resend invite |
| Settings | `/settings` | Business settings (Admin only) | Edit outreach hours, escalation keywords, response window |
| Staff Management | `/staff` | Manage staff accounts (Admin only) | Invite staff, assign roles/permissions, remove staff |
| Approve Booking | `/bookings/pending` | Client-initiated booking requests awaiting approval | Approve or reject each request |

**Notes:** Staff Web App Pages section added to F001 spec.

---

### R3-G3 — Client app screens and navigation are not defined

**Status:** Decided · Applied

**Issue:** The diagram shows "Chat UI · Push Alerts · Account Setup" in the client app box with no screen definitions.

**Options:**

- A: Add a Client App Screens section to F001 — screen name, purpose, key actions
- B: Defer to a dedicated Client App spec

**Recommendation: Option A.**

**Decision:** Option A — Client App Screens section added to F001:

| Screen | Purpose | Key Actions |
| --- | --- | --- |
| Short Code Entry | First launch — redeem invite and activate account | Pre-filled code from deep link, submit to activate |
| Chat | Persistent conversation thread with the office | Read messages, send reply |
| Appointment List | View all upcoming and past appointments | View status (confirmed, pending, cancelled, etc.) |
| Notifications | In-app notification history | View past alerts — slot offers, follow-ups, confirmations |
| Settings | Account preferences | Opt out of outreach, view contact info |

Navigation structure: bottom tab bar (Chat, Appointments, Notifications, Settings). Short Code Entry is a one-time pre-auth screen shown only on first launch before account activation.

**Notes:** Client App Screens section added to F001 spec.

---

### R3-G4 — Client app offline behavior is undefined

**Status:** Decided · Applied

**Issue:** React Native apps must handle offline states — what happens when a client has no internet connection.

**Options:**

- A: Minimal offline support — messages cached locally (visible offline); outgoing messages queue with "Sending…" indicator; "No connection" banner shown at top of chat
- B: No offline support — app shows error state; requires connectivity to function

**Recommendation: Option A.**

**Decision:** Option A — minimal offline behavior defined:
- Previously received messages cached locally and visible when offline
- Outgoing messages queued with "Sending…" indicator; sent automatically when connection restores
- "No connection" banner shown at top of the Chat screen when offline
- Push notification delivery retries are handled by FCM (built-in — no custom logic needed)

**Notes:** Offline behavior section added to Client App — Screens in F001 spec.

---

### R3-G5 — WebSocket message schema is undefined

**Status:** Decided · Applied

**Issue:** The spec defines the WebSocket channels but never defines the message format sent over them. Without a shared schema, the backend, staff app, and React Native app will each invent their own format.

**Options:**

- A: Define the WebSocket event schema in F001 — event types and payload shapes
- B: Defer to the Real-time Layer feature spec

**Recommendation: Option A.** Cross-cutting contract between three codebases — belongs at the architecture level.

**Decision:** Option A — WebSocket event schema defined:

All messages follow the envelope: `{ "event": "<event_type>", "payload": { ... } }`

| Event | Channel | Payload |
| --- | --- | --- |
| `new_message` | Both | `{ conversation_id, message: { id, sender, content, timestamp } }` |
| `conversation_state_changed` | Staff | `{ conversation_id, state, client_name }` |
| `staff_alert` | Staff | `{ alert_type, conversation_id, client_name, reason }` |
| `appointment_confirmed` | Staff | `{ appointment_id, client_name, time, service_type }` |
| `booking_approval_requested` | Staff | `{ conversation_id, client_name, service_type, preferred_time }` |
| `message_delivered` | Client | `{ message_id }` — acknowledges server received outgoing message |
| `takeover_started` | Client | `{ conversation_id }` — triggers "Office" sender label in chat UI |

**Notes:** WebSocket Event Schema section added to F001 spec under the Real-time Layer.

---

### R3-G6 — Environment configuration is undocumented

**Status:** Decided · Applied

**Issue:** No list of environment variables required to run the system. A developer cloning the repo has no idea what to configure.

**Options:**

- A: Add an Environment Variables section to F001 — variable name, module, example value
- B: Defer to a developer setup guide (README)

**Recommendation: Option A.**

**Decision:** Option A — Environment Variables section added to F001:

| Variable | Module | Example |
| --- | --- | --- |
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

**Notes:** Environment Variables section added to F001 spec. A `.env.example` file must be created at project root containing all variables with placeholder values.

---

### R3-G7 — LLM rate limiting under peak outreach not addressed

**Status:** Decided · Applied

**Issue:** Outreach trigger queues one LLM job per client simultaneously. At 50–200 clients, that's a burst of LLM calls that will hit provider rate limits in production.

**Options:**

- A: Bull queue concurrency limit via `BULL_CONCURRENCY` env var (default 10); all LLM jobs respect this ceiling
- B: Defer until a production LLM provider is chosen

**Recommendation: Option A.**

**Decision:** Option A — Job Scheduler enforces `BULL_CONCURRENCY` (default 10) as the maximum number of concurrent LLM jobs at any time. All outreach, follow-up, and waitlist jobs share this ceiling. Value is set via env var — no code change needed to tune for a specific provider's rate limits. During dev (Ollama), this can be raised freely.
**Notes:** Job Scheduler module description updated in F001 spec to document concurrency ceiling.

---

### R3-G8 — Database indexing strategy is absent

**Status:** Decided · Applied

**Issue:** No indexes defined. Every query filters by `business_id`; without indexes the database will do full table scans at scale. The unique constraint on `Conversation(client_id, business_id)` is especially critical — it enforces the persistent thread invariant at the database level.

**Options:**

- A: Add a Database Indexes section to F001 with the minimum required indexes
- B: Leave indexing to implementation

**Recommendation: Option A.**

**Decision:** Option A — Database Indexes section added to F001:

| Table | Columns | Type | Reason |
| --- | --- | --- | --- |
| `Conversation` | `(client_id, business_id)` | Unique constraint | Enforces one persistent thread per client per office |
| `Appointment` | `(business_id, status)` | Index | Slot availability queries |
| `Appointment` | `(schedule_id)` | Index | Loading all appointments for a schedule |
| `Message` | `(conversation_id)` | Index | Loading message history |
| `WaitlistEntry` | `(business_id, status, created_at)` | Index | Ordered waitlist queries |
| `DeviceToken` | `(client_id, platform)` | Unique constraint | One token per device type per client |
| `ClientInvite` | `(short_code)` | Index | Short code redemption lookup |

**Notes:** Database Indexes section added to F001 spec after the Database — Core Entities table.

---

### R3-G9 — Push notification tap destination is undefined

**Status:** Decided · Applied

**Issue:** No definition of where the app navigates when a push notification is tapped — required for deep linking from background/killed app states.

**Options:**

- A: Add a Push Notification Tap Behavior table to F001
- B: Defer to app screen specs (dependency on R3-G2 and R3-G3 — now resolved)

**Recommendation: Option A** — G2 and G3 are resolved; table writes itself.

**Decision:** Option A — Push Notification Tap Behavior defined:

**Client app (React Native):**

| Notification | Tap destination |
| --- | --- |
| Any follow-up message | Chat screen |
| Waitlist slot offer | Chat screen |
| Appointment confirmed | Chat screen |

**Staff app (React web):**

| Notification | Tap destination |
| --- | --- |
| Appointment confirmed | Conversation View (`/conversations/:id`) |
| Client requests human / escalation | Conversation View (`/conversations/:id`) |
| Ambiguous / off-topic (2nd) | Conversation View (`/conversations/:id`) |
| Distress keyword detected | Conversation View (`/conversations/:id`) |
| Deadline missed / slot released | Schedule Detail (`/schedules/:id`) |
| Client booking request needs approval | Approve Booking (`/bookings/pending`) |
| LLM API failure | Dashboard (`/`) |

**Notes:** Push Notification Tap Behavior section added to F001 spec.

---

### R3-G10 — Operational readiness is entirely absent

**Status:** Decided · Applied

**Issue:** The spec doesn't state which operational concerns are in vs. out of scope for V1, leaving developers to guess.

**Options:**

- A: Add an Operational Considerations section to F001 — in scope vs. out of scope for V1
- B: Extend the Out of Scope list only

**Recommendation: Option A.**

**Decision:** Option A — Operational Considerations section added to F001:

**In scope for V1:**
- Database schema versioned with a migration tool (e.g. `node-pg-migrate`) — migrations run on deploy
- Three environments: `development` (local), `staging` (pre-prod), `production`
- Error monitoring: Sentry (already in NFR)
- Queue monitoring: Bull Board (already in NFR)
- App store: React Native app submitted to App Store (iOS) and Google Play (Android) before first client onboarding

**Out of scope for V1:**
- CI/CD pipeline — manual deploys acceptable at launch
- Automated database backups — deferred to managed cloud provider defaults
- Auto-scaling / horizontal scaling
- Feature flags / phased rollouts
- On-call alerting (PagerDuty or equivalent)

**Notes:** Operational Considerations section added to F001 spec.

---

## Clarifications Needed

---

### R3-CL1 — Target industry: generic scheduling platform or vertical-specific?

**Status:** Decided · Applied

**Issue:** The spec uses examples like "general dentist" and "massage" as service types but never states whether this is a generic tool or vertical-specific.

**Decision:** Generic scheduling platform — any appointment-based business (salons, clinics, gyms, consultants, etc.). Service types are free-text, set by staff or captured by AI from client messages. No vertical-specific compliance (HIPAA, etc.) built in V1. Verticals served through configuration in future phases.
**Notes:** Problem statement in F001 spec updated to make the generic positioning explicit.

---

### R3-CL2 — Is the staff web app supported on mobile browsers?

**Status:** Decided · Applied

**Issue:** The spec defines the staff interface as a React web app but does not state whether mobile browsers are supported.

**Decision:** Desktop-only — V1 targets desktop browsers only. A "Please use a desktop browser for the best experience" message is shown on screens narrower than 768px. No responsive layout work required for V1. Mobile browser support deferred to a future phase.
**Notes:** Staff web app scope note added to F001 spec.

---

### R3-CL3 — Can staff edit Appointment.service_type after AI captures it?

**Status:** Decided · Applied

**Issue:** The Appointment entity has a `service_type` field set by AI, but the spec never defines how staff corrects it if the AI gets it wrong.

**Decision:** Yes — staff can edit `service_type` inline on the Schedule Detail page (`/schedules/:id`). Requires `can_edit_schedule` permission (Admin always; Staff only if designated). Change is logged as a system note in the conversation thread for auditability.
**Notes:** Schedule Detail page key actions updated in F001 spec to include service_type editing.

---

### R3-CL4 — For client-initiated bookings, who creates the Appointment and Schedule records?

**Status:** Decided · Applied

**Issue:** Client-initiated booking requires the AI to find a matching slot — but who creates the Schedule and Appointment records?

**Decision:** Option A — the AI never creates Schedule or Appointment records. Client-initiated booking only works against pre-existing available slots (Appointment rows with status=`available` and client_id=null). If no matching slot exists, the AI tells the client none are available and adds them to the waitlist. Staff are solely responsible for creating Schedules and marking slots as available.
**Notes:** Client-Initiated Booking Flow in F001 spec updated with this constraint. AI Engine write permissions are bounded to: updating Appointment.status, Appointment.client_id, and Conversation state only — never creating Schedules or Appointments.

---

### R3-CL5 — What is Conversation.state between active booking discussions?

**Status:** Decided · Applied

**Issue:** With the persistent thread model, a client's conversation exists continuously. After a booking reaches a terminal state (confirmed, cancelled, etc.), what state does the Conversation sit in while waiting for the next interaction?

**Decision:** Option C — terminal states are final per Conversation record. Each booking episode creates a new Conversation record linked to its Appointment. The client still sees one continuous chat: the Chat screen fetches all Messages for that client across all their Conversation records (`WHERE client_id = ? AND business_id = ?` ordered by timestamp). The UX is seamless; the state machine stays clean with no resting state needed.

**Implication:** Conversation is now scoped per booking episode, not per persistent thread. The "persistent thread" is a UI concept — the backend returns all messages across all the client's Conversations for that business.

**Notes:** Conversation entity description updated in F001 spec. F003 state machine requires no changes — terminal states remain terminal. Chat screen query updated in spec to reflect cross-conversation message fetch.

---

## What's Well-Defined

The following areas are clear, complete, and ready to build from without questions:

- **Two-sided architecture** — component diagram, role separation, and data flow are unambiguous
- **Full database entity model** — all entities, fields, types, nullability, and multi-tenancy conventions are defined
- **Staff-initiated outreach loop** — from trigger to confirmation, including follow-up schedule, cancellation logic, and deadline enforcement
- **Waitlist flow** — first-in-first-served, LLM preference matching, fixed 30-minute response window, two-message sequence
- **No-response handling** — three-timed follow-ups with cancellation on client reply
- **F002 auth model** — staff roles, designatable permissions, token lifecycle, client session model all fully specified
- **F003 state machine** (single-appointment flow) — 13 states, full transition table, LLM protocol, escalation rules, edge cases
- **Multi-tenancy convention** — every entity carries business_id, all queries filter by it
- **Real-time channels** — WebSocket channel structure (/staff/{business_id}, /client/{client_id}) and role separation
- **Technology stack** — React, React Native, Node.js/TypeScript, PostgreSQL, Bull, Ollama; all decided and documented
- **AI provider abstraction** — Ollama for dev; production provider deferred; config-only swap
- **Staff Alert System** — 9 defined triggers with clear escalation chain
- **Business.settings schema** — 5 keys with defaults, all defined
- **Client opt-out** — both self-service and staff-initiated, opted_out flag defined
- **Cross-document linking** — all four specs are linked to each other; review decisions traceable to spec changes

---

## Round 3 Decision Log

| # | Issue | Decision | Date |
| --- | --- | --- | --- |
| R3-C1 | F003 state machine incompatible with persistent thread model | Option A — sequential handling; one active booking at a time; F003 unchanged | 2026-05-05 |
| R3-C2 | FCM device token not in data model | Option B — DeviceToken table added; upsert on launch, delete on logout | 2026-05-05 |
| R3-C3 | No path to create first Business and Admin | Option C — dev seed script + production bootstrap endpoint; F004 builds UI on top | 2026-05-05 |
| R3-C4 | Client app onboarding flow undefined | Option A — universal link deep link; pre-filled code on mobile; static page on desktop; TestFlight for dev | 2026-05-05 |
| R3-G1 | Non-functional requirements absent | Option A — NFR section added with V1 baselines for performance, security, scalability, compliance, observability | 2026-05-05 |
| R3-G2 | Staff web app pages not defined | Option A — 10-page table with routes, purpose, and key actions added to F001 | 2026-05-05 |
| R3-G3 | Client app screens not defined | Option A — 5-screen table added; bottom tab navigation; Short Code Entry as pre-auth screen | 2026-05-05 |
| R3-G4 | Client app offline behavior undefined | Option A — cached messages, outgoing queue, "No connection" banner, FCM handles push retries | 2026-05-05 |
| R3-G5 | WebSocket message schema undefined | Option A — 7-event schema defined with envelope format and per-event payloads | 2026-05-05 |
| R3-G6 | Environment configuration undocumented | Option A — 16-variable table added; .env.example required at project root | 2026-05-05 |
| R3-G7 | LLM rate limiting under peak load not addressed | Option A — BULL_CONCURRENCY env var caps concurrent LLM jobs; default 10; tunable per provider | 2026-05-05 |
| R3-G8 | Database indexing strategy absent | Option A — 7-index table added; unique constraints on Conversation and DeviceToken | 2026-05-05 |
| R3-G9 | Push notification tap destination undefined | Option A — tap behavior table defined for client (3 types → Chat) and staff (7 types → specific routes) | 2026-05-05 |
| R3-G10 | Operational readiness absent | Option A — Operational Considerations section added; migrations, 3 envs, app store, Sentry in scope; CI/CD, backups, scaling out of scope | 2026-05-05 |
| R3-CL1 | Target industry — generic or vertical-specific? | Generic — any appointment-based business; free-text service types; no vertical compliance V1 | 2026-05-05 |
| R3-CL2 | Staff web app mobile browser support | Desktop-only V1; "use desktop browser" message below 768px; mobile deferred | 2026-05-05 |
| R3-CL3 | Appointment.service_type staff edit capability | Yes — editable on Schedule Detail; requires can_edit_schedule; logged as system note | 2026-05-05 |
| R3-CL4 | Client-initiated booking — who creates Appointment/Schedule? | Option A — AI never creates records; booking requires pre-existing available slots; no match → waitlist | 2026-05-05 |
| R3-CL5 | Conversation.state between active booking discussions | Option C — new Conversation per booking episode; chat screen fetches all messages across conversations; F003 unchanged | 2026-05-05 |

---

## Round 4 — Pre-Approval Engineering Manager Audit (2026-05-05)

**Scope:** Final audit of F001 after all 52 prior items resolved. Evaluating whether a developer team can build the system as written with no ambiguity, no security gaps, and no data integrity holes. Cross-checked against F002 and F003.

---

## Critical Issues

---

### R4-C1 — WebSocket connections have no defined authentication mechanism

**Status:** Decided

**Issue:** The NFR Security section states "JWT validated on every request." The WebSocket event schema and channel structure are defined. But nowhere in F001 or F002 is it specified how a WebSocket connection is authenticated.

HTTP REST requests carry JWTs in `Authorization: Bearer <token>` headers. WebSocket upgrade requests work differently — the handshake is an HTTP GET, but keeping the JWT in a query parameter exposes it in server logs. The two common alternatives (auth header on the upgrade request; first-frame auth message before any channel messages flow) are both valid but require a specific decision because the staff web app, React Native client app, and backend WebSocket server must all implement the same pattern.

Without this defined, either:
- The WebSocket server accepts unauthenticated connections (security hole — anyone can subscribe to any business's conversation channel)
- Three developers implement three incompatible auth patterns and the real-time layer fails at integration

**Options:**

- **Option A: JWT in upgrade request header** — pass `Authorization: Bearer <token>` in the HTTP headers of the WebSocket upgrade request. Supported in React Native and modern browsers. Clean, mirrors REST auth. — *Why you'd choose it:* consistent with REST auth pattern; no messages reach the server unauthenticated.
- **Option B: First-frame auth message** — after connecting, client immediately sends `{ "event": "auth", "payload": { "token": "<jwt>" } }`. Server validates before allowing channel subscription. — *Why you'd choose it:* compatible with every WebSocket library and older browser behavior; more explicit auth handshake.
- **Option C: Short-lived auth token in URL query param** — generate a one-time WebSocket auth token via a REST endpoint (`POST /auth/ws-token`), use it in the WebSocket URL (`wss://api.domain/ws?token=<one-time-token>`). — *Why you'd choose it:* avoids long-lived JWT in URL while staying compatible with environments that don't support custom upgrade headers. More infrastructure overhead.

**Recommendation: Option A.** Consistent with REST auth, well-supported in React Native's `ws` library and the browser WebSocket API. No extra infrastructure. Simplest implementation.

**Decision:** Option A — WebSocket upgrade request must include `Authorization: Bearer <token>` in the HTTP headers. The backend validates the JWT on the upgrade handshake before accepting the connection. If the token is missing or invalid, the server returns 401 and closes the connection. React Native's `ws` library and modern browsers both support custom headers on the upgrade request. No unauthenticated connections are ever established.
**Notes:** WebSocket authentication pattern added to F001 spec under the Real-time Layer. F002 session model is unchanged — the same access token used for REST requests is used here.

---

### R4-C2 — Booking approval timeout and rejection path have no terminal condition

**Status:** Decided

**Issue:** The Client-Initiated Booking Flow, Step 4 (Uncertain path): "AI sends staff a notification: 'Client [name] has requested [appointment type] — please approve or reject.' Staff approves → AI proceeds to offer a slot."

Three cases are entirely undefined:
1. **Staff never responds** — the client is in mid-conversation with no resolution. There is no timeout. Does the client wait indefinitely? Does the AI send a follow-up? Does the booking request auto-expire?
2. **Staff rejects** — what does the AI tell the client? "The office can't accommodate that request"? Does it add the client to the waitlist? Does it offer alternative slots?
3. **Staff approves but no slot is available at that point** — is this possible? What does the AI do?

Without terminal conditions, the booking approval path cannot be built to completion. The Conversation will be stuck with no exit.

**Options:**

- **Option A: Fixed approval window (e.g., 2 hours) — no response = auto-reject + client notification** — AI tells client "We weren't able to confirm at this time" and offers waitlist. — *Why you'd choose it:* mirrors the follow-up timeout pattern already established; no open-ended wait states; deterministic behavior.
- **Option B: No timeout — staff must always respond; AI waits indefinitely** — simpler implementation, no new jobs, but poor client UX and no guaranteed resolution. — *Why you'd choose it:* avoids adding another configurable timer; puts responsibility on staff.

**Recommendation: Option A.** Deterministic. Consistent with the timeout pattern used elsewhere (follow-up window, waitlist window). The approval timeout should be configurable via Business.settings (new key: `booking_approval_timeout_hours`).

For staff rejection: AI should apologize, offer waitlist if no alternative slots exist, or offer available slots if they exist. This matches the "no available slots" branch already defined.

**Decision:** Option A — fixed approval window, configurable via a new `booking_approval_timeout_hours` key added to `Business.settings` (default: 2 hours). Three terminal conditions:
1. **Timeout (no staff response):** Job Scheduler fires at T+`booking_approval_timeout_hours`. AI tells client: "We weren't able to confirm your request at this time." Then checks for available slots — if found, offers them; if not, adds client to waitlist. Same path as "no matching slot found."
2. **Staff rejects:** Same outcome as timeout — AI apologizes and offers slots or waitlist.
3. **Staff approves but slot is no longer available:** Treated as a booking conflict (same resolution as R4-C4) — AI informs client the slot is gone and offers alternatives or waitlist.

The approval-wait job is keyed by `conversation_id` and cancelled if staff responds before the window expires, following the same cancellation pattern as follow-up jobs (G6).

**Notes:** Client-Initiated Booking Flow updated in F001 spec with all three terminal conditions. `booking_approval_timeout_hours` added to `Business.settings` schema (default: 2). Job Scheduler module updated to include approval-wait job type.

---

### R4-C3 — Business timezone is not stored anywhere

**Status:** Decided

**Issue:** `Business.settings` defines `outreach_hours_start` (default 09:00) and `outreach_hours_end` (default 19:00) as `time` fields but there is no `timezone` field anywhere on the Business entity or in settings.

Every time-sensitive operation in the system depends on an undefined timezone:
- **Outreach hours window** — 09:00 in New York is 06:00 in Los Angeles. Without a stored timezone, a business's outreach hours are interpreted against the server clock, not the office's local time.
- **Follow-up timing** — T+5min, T+1hr, T−5min before deadline are anchored to `Appointment.time`. If that time is stored without timezone context, deadline calculations are wrong.
- **Auto-pickup watcher** — scans every 5 minutes "respecting outreach hours window." Which clock does it use?
- **Calendar sync import** — Google Calendar and Outlook events carry timezone information; the import must reconcile against the business's stored timezone.

Two businesses using the platform from different timezones will get broken scheduling behavior with no error, no warning, and no observable failure until appointments go wrong.

**Options:**

- **Option A: Add `timezone` field to Business entity** (IANA timezone string, e.g. `"America/New_York"`) — all time-based operations compute local time from this value. Required on business creation (default: UTC as a safe fallback). — *Why you'd choose it:* correct by construction; clean integration with calendar sync; one authoritative source.
- **Option B: Store all times as UTC; display in browser/app timezone** — no stored timezone field; clients handle local conversion. — *Why you'd choose it:* avoids timezone storage. But this breaks outreach_hours_start/end, which must be evaluated server-side on the Job Scheduler clock during follow-up and pickup checks. Server-side evaluation requires a stored timezone.

**Recommendation: Option A.** Outreach hours and follow-up timings are evaluated server-side. The server must know the business's local timezone to apply them correctly. Option B is not viable for server-side scheduling logic.

**Decision:** Option A — `timezone` field (IANA string, e.g. `"America/New_York"`) added to the Business entity. Required at business creation; defaults to `"UTC"` as a safe fallback. All Job Scheduler time operations (outreach window checks, follow-up timing, deadline calculations) convert to local time using this value via Node.js `Intl` API before evaluation. Calendar sync import reconciles incoming Google/Outlook event timezones against this field. F004 must mark `timezone` as a required field in the business setup wizard — a business left on UTC default will have outreach running on the wrong clock.
**Notes:** Business entity updated in F001 spec — `timezone` added as a required field with default `"UTC"`. Job Scheduler module updated to note that all time-window evaluations use `Business.timezone`. R4-CL1 (`Appointment.time` type) is directly linked — resolved there.

---

### R4-C4 — No concurrency protection against double-booking

**Status:** Decided

**Issue:** The spec defines AI write permissions as: "updating Appointment.status, Appointment.client_id, and Conversation state." But it defines no transactional or locking strategy for slot writes.

With Bull running up to 10 concurrent LLM jobs, this race condition is realistic:

1. Client A is in `confirming` state for slot X (via staff-triggered outreach)
2. Slot X is in status `ai-active`
3. Simultaneously, a waitlist job fires and the AI matches slot X to Client B (if status transitions are not atomic)
4. Both jobs write `client_id` and `status` to the same Appointment row — last write wins; one booking silently disappears

Even without concurrent waitlist jobs, two outreach conversations for the same slot (e.g., if triggered twice due to a bug) would produce the same race.

The spec relies on `Appointment.status` transitions to enforce slot state, but nowhere does it define how those writes are made atomic.

**Options:**

- **Option A: Optimistic locking** — booking write uses `UPDATE Appointment SET status='confirmed', client_id=? WHERE id=? AND status='ai-active' AND client_id IS NULL`. If 0 rows affected, the job knows the slot was taken and must handle the conflict (notify client, offer next available slot). — *Why you'd choose it:* no database-level locks needed; works cleanly with Bull; easy to implement in Node/PostgreSQL.
- **Option B: Pessimistic row lock** — `SELECT ... FOR UPDATE` on the Appointment row inside a transaction before writing. — *Why you'd choose it:* absolute guarantee; no retry logic needed. Adds transaction overhead; fine for low volume V1.

**Recommendation: Option A.** Fits naturally with Bull's job model. The conflict handler is a well-defined edge case: AI has already confirmed with the client, slot is taken — escalate to staff. Should be documented as an explicit error branch in the booking flow.

**Decision:** Option A — all slot-claiming writes use a conditional `UPDATE Appointment SET status='confirmed', client_id=? WHERE id=? AND status='ai-active' AND client_id IS NULL`. If 0 rows affected, the job treats the slot as taken and executes the conflict branch: AI informs the client the slot is no longer available, then checks for alternative slots — if found, offers them; if not, adds client to waitlist. This conflict branch is an explicit documented path, not an error state. No transactions, no held DB connections spanning an LLM call.
**Notes:** Booking flow in F001 spec updated with the conflict branch as an explicit step. AI Engine write permissions section updated to document the conditional UPDATE pattern.

---

## Contradiction

---

### R4-CONTRA-1 — AI write boundary vs. service_type capture are contradictory

**Status:** Decided

**Issue:** Two statements in the spec directly contradict each other:

- **R3-CL4 (applied to spec):** "AI Engine write permissions are bounded to: updating Appointment.status, Appointment.client_id, and Conversation state only — never creating Schedules or Appointments."
- **Client-Initiated Booking Flow, Step 5:** "Once a slot is confirmed, it is booked and labeled with the `service_type` on the Appointment record. AI write permissions are limited to: updating Appointment.status, Appointment.client_id, and Conversation state."

These two statements agree that AI writes `status` and `client_id`. But the first statement (in the flow prose) says the slot is "labeled with the service_type on the Appointment record" — and the AI is the one that captured the service_type from the client's message ("I'd like to book a general dentist appointment").

If the AI writes `service_type`, then the write boundary list is missing it. If the AI does not write `service_type`, then who does, and when? The flow has no "staff sets service_type" step.

**Options:**

- **Option A: Add `Appointment.service_type` to the AI write boundary list** — AI writes status, client_id, and service_type at booking time. R3-CL4 list updated accordingly. — *Why you'd choose it:* correct — the AI is the only actor who knows the service type at the moment of booking in the client-initiated flow; no extra staff step needed.
- **Option B: AI captures service_type into Conversation context only; staff confirms it on the Approve Booking page (for uncertain bookings) or on Schedule Detail (for confirmed bookings)** — AI never writes to Appointment.service_type directly. — *Why you'd choose it:* stricter write boundary; staff controls all appointment data. Adds friction for routine bookings.

**Recommendation: Option A.** The AI captured the service type from the client message. In the "Confident" booking path (no staff approval), there is no staff review step — the AI must write service_type or it never gets set. Simpler, correct.

**Decision:** Option A — `Appointment.service_type` added to the AI write boundary. Full AI write permissions are now: `Appointment.status`, `Appointment.client_id`, `Appointment.service_type`, and Conversation state. The AI writes `service_type` at the moment of booking confirmation using the value it captured from the client's message. For the uncertain path, staff sees the AI-captured `service_type` on the Approve Booking page and can correct it if needed (R3-CL3 already covers staff editing of this field). The spec contradiction is resolved — both statements now agree.
**Notes:** R3-CL4 write boundary list updated in F001 spec to include `Appointment.service_type`. Client-Initiated Booking Flow prose updated to be consistent with the boundary list.

---

## Important Gaps

---

### R4-G1 — Short code redemption error states not defined

**Status:** Decided

**Issue:** The Short Code Entry screen has a defined happy path (pre-filled code → submit → JWT issued). Three failure cases are undefined — no error message, no recovery path:

1. **Code expired** — `ClientInvite.expires_at` has passed. What does the client see? Is there a "contact your office" message? Can they request a new code from within the app?
2. **Code already used** — `ClientInvite.used_at` is not null. Same questions.
3. **Wrong code entered manually** — Client mistyped. Is there a retry limit? After N failures, what happens?

F002 defines the validation logic ("Backend validates: short code exists, used_at is null, expires_at has not passed") but does not define the client-facing error states.

**Decision:** Three error states defined, each with a distinct backend error code and client-facing message:
1. **Expired** (`INVITE_EXPIRED`) — *"This invite link has expired. Please contact your office to request a new one."* No in-app resend (client is unauthenticated); staff resends from the dashboard.
2. **Already used** (`INVITE_USED`) — *"This invite has already been redeemed. If you're having trouble signing in, contact your office."*
3. **Wrong code** (`INVITE_INVALID`) — 5 attempts allowed; on 5th failure the invite is locked for 15 minutes with message *"Too many incorrect attempts. Please try again in 15 minutes."* Mitigates brute force without requiring a CAPTCHA.

Backend returns these as distinct error codes so the client app renders the correct message per case.
**Notes:** Short Code Entry screen error states added to F001 spec. Auth endpoint for code redemption updated to return `INVITE_EXPIRED`, `INVITE_USED`, `INVITE_INVALID` codes. Rate-limiting (5 attempts, 15-min lockout) added to redemption endpoint spec.

---

### R4-G2 — Resend invite flow lifecycle not defined

**Status:** Decided

**Issue:** The Clients and Client Detail pages list "resend invite" as a key action. The spec does not define:

1. **Is the old ClientInvite record invalidated?** If not, a client could redeem either code — the old or the new.
2. **Is a new short code generated?** Or is the same code re-sent?
3. **Can staff resend to a client who is already registered** (`app_registered = true`)? If yes, does it force a re-registration? If no, is the button hidden or disabled?

Note: F002 covers Admin-initiated session expiry as a distinct flow (sends new code automatically). The "resend invite" action is the staff-facing flow for clients who haven't registered yet — it is not covered in F002.

**Decision:** Resend invite lifecycle defined:
1. **Old code invalidated** — all existing `ClientInvite` rows for that client are marked `used_at = now()` before the new row is created. Only one active invite exists at a time.
2. **New code always generated** — a fresh `ClientInvite` row with a new `short_code` and a new 48-hour `expires_at`. New universal link emailed via SendGrid.
3. **Already registered clients** — resend button is disabled (`app_registered = true`) on the Client Detail page. Force re-registration uses the F002 "Expire Session" flow instead, which sends a new code automatically.

**Notes:** Resend invite flow added to F001 spec under the Client management section. Client Detail page key actions updated — resend button disabled state documented. ClientInvite invalidation logic documented.

---

### R4-G3 — Client experience during booking approval wait is undefined

**Status:** Decided

**Issue:** When the AI routes a booking request to staff for approval (Uncertain path), the client is in mid-conversation. The spec defines the staff side (notification, Approve Booking page) but not the client side:

1. **What does the AI say while the client waits?** Without a defined message, the client sees silence — which will prompt them to send follow-up messages, triggering re-processing.
2. **What does the AI say if staff rejects?** The spec gives no rejection message or behavior.
3. **Does rejection trigger the waitlist flow?** Or does the AI simply close the request?

**Decision:** Client UX during approval wait defined across three cases:
1. **While waiting:** AI immediately sends *"I've passed your request to the office for review. I'll get back to you as soon as they confirm — usually within a couple of hours."* Conversation moves to a new `awaiting_approval` state (F003 update required). Any client follow-up messages during the wait receive a holding reply: *"We're still waiting on confirmation from the office — I'll update you shortly."*
2. **On staff rejection:** AI sends *"Unfortunately the office isn't able to accommodate that request. Let me check what's available for you."* Then checks for alternative slots — if found, offers them; if none, adds client to waitlist with *"I've added you to the waitlist and will reach out as soon as something opens up."*
3. **Rejection triggers waitlist** — same flow as "no matching slot found," consistent with R4-C2.

**Notes:** Client-Initiated Booking Flow in F001 spec updated with approval-wait UX. F003 requires a new `awaiting_approval` state added to the state machine to cover the holding period.

---

### R4-G4 — API cross-cutting conventions not defined

**Status:** Decided

**Issue:** F001 defines backend modules but defers endpoint definitions to individual feature specs (G5 principle). However, no baseline conventions are established for how those endpoints will be designed. Without shared conventions, multiple developers building different modules will produce an inconsistent API.

What's missing from F001:
- **URL base path** — e.g., `/api/v1/...` or `/v1/...`
- **Standard error envelope** — e.g., `{ "error": { "code": "SLOT_TAKEN", "message": "..." } }` — every module needs the same shape
- **Auth header convention** — `Authorization: Bearer <token>` (assumed but never stated)
- **Pagination format** — cursor-based or offset-based? (relevant to Message fetch, conversation list, client list)

This is not a module-level concern — it's a contract shared by every module and both client apps.

**Decision:** API cross-cutting conventions defined:
1. **URL base path:** `/api/v1/` for all protected endpoints (e.g. `/api/v1/appointments`, `/api/v1/conversations`). Internal/admin endpoints use `/internal/` (consistent with bootstrap endpoint).
2. **Standard error envelope:**
   ```json
   { "error": { "code": "SLOT_TAKEN", "message": "This slot is no longer available." } }
   ```
   `code` is a screaming snake case machine-readable constant; `message` is human-readable. HTTP status codes follow standard conventions: 400 bad input, 401 unauthorized, 403 forbidden, 404 not found, 409 conflict, 500 server error.
3. **Auth header:** `Authorization: Bearer <access_token>` on all protected endpoints — consistent with F002 and R4-C1.
4. **Pagination:** Cursor-based. Response shape: `{ "data": [...], "next_cursor": "opaque_string_or_null" }`. Clients pass `?cursor=<value>&limit=<n>` (default limit: 50). Applies to message history, conversation list, and client list.

**Notes:** API Conventions section added to F001 spec. All future feature specs must follow these conventions when defining endpoints.

---

### R4-G5 — Minimum OS version support not defined

**Status:** Decided

**Issue:** The spec doesn't define minimum iOS version or minimum Android API level for the React Native client app. These affect:

- Which React Native APIs are available (deferred deep links, notification permissions, WebSocket behavior)
- App store listing (minimum supported OS in the app store metadata)
- Build toolchain and test matrix

Universal link behavior (R3-C4) and push notification permissions (R3-C2) behave differently on old OS versions.

**Decision:** Minimum OS versions defined:
- **iOS 16** — universal links, deferred deep links, and push notification permission APIs all stable. React Native officially supports iOS 16+. Covers ~95%+ of active iPhones.
- **Android API level 26 (Android 8.0 Oreo)** — FCM notification channels (required for Android 8+), deferred deep links, and WebSocket behavior all solid at this level. React Native supports API 23+ but 26 avoids notification channel workarounds. Covers ~95%+ of active Android devices.

**Notes:** Minimum OS versions added to F001 spec under Client App section. App Store and Google Play listings must reflect these minimums. Build toolchain and test matrix should target these as the floor.

---

### R4-G6 — Message pagination not defined

**Status:** Decided

**Issue:** The Chat screen query is: "fetch all Messages across all Conversations for that client (`WHERE client_id = ? AND business_id = ?` ordered by timestamp)." For a client who has been using the app for months, this query is unbounded and returns potentially thousands of rows on every screen load.

Neither a page size, a cursor strategy, nor a "load more" UX behavior is defined. This is both a performance risk and a UX gap.

**Decision:** Message pagination defined:
- **Initial load:** most recent 50 messages fetched on Chat screen open; displayed newest at bottom (standard chat convention).
- **Load more:** user scrolls to top → app fetches previous 50 messages via cursor-based pagination (consistent with R4-G4 `?cursor=<value>&limit=<n>` convention). Continues until `next_cursor` is null (start of history).
- **New messages:** delivered via WebSocket `new_message` event and appended to the bottom in real time — no re-fetch required.
- **Offline:** cached messages show as-is from last fetch; no cache pagination.

**Notes:** Chat screen query updated in F001 spec to document the 50-message initial fetch and cursor-based load-more pattern. Message index on `(conversation_id)` already defined in R3-G8 supports this query efficiently.

---

### R4-G7 — CORS configuration not addressed

**Status:** Decided

**Issue:** The staff web app is a browser-based React app consuming the backend REST API. Browsers enforce CORS on cross-origin requests. Without a defined CORS policy, the web app will fail to call the API in all non-localhost environments.

What's missing:
- Which origins are allowed (e.g., `https://staff.app.[domain]`)
- Whether credentials (cookies for the refresh token httpOnly cookie) are permitted (`credentials: 'include'`)
- Allowed HTTP methods

This is directly tied to the F002 auth model — the refresh token is stored in an httpOnly cookie, which requires `credentials: 'include'` on CORS requests and explicit `Access-Control-Allow-Origin` (wildcard `*` won't work with credentials).

**Decision:** CORS policy defined:
- **Allowed origins:** explicitly whitelisted per environment via `ALLOWED_ORIGINS` env var (comma-separated). Production: `https://staff.app.[domain]`; development: `http://localhost:3000`.
- **Credentials:** `Access-Control-Allow-Credentials: true` — required for httpOnly refresh token cookie.
- **Allowed methods:** `GET, POST, PUT, PATCH, DELETE, OPTIONS`.
- **Allowed headers:** `Authorization, Content-Type`.
- **Preflight:** backend handles `OPTIONS` on all routes.
- `ALLOWED_ORIGINS` added to the environment variables table.

**Notes:** CORS policy section added to F001 spec under Architecture Principles. `ALLOWED_ORIGINS` added to the Environment Variables table (R3-G6). Wildcard `*` explicitly prohibited — incompatible with credentialed requests.

---

## Clarifications Needed

---

### R4-CL1 — Appointment.time type and timezone are ambiguous

**Status:** Decided

**Issue:** The Appointment entity has a `time` field with no type specified. Two questions:

1. **Type:** Is it a full UTC timestamp, a time-of-day string (HH:MM), or a Postgres `TIME` type? Combined with `Schedule.date`, a developer could interpret this as a `TIME` column (e.g., `09:30`) meant to be combined with `Schedule.date` for the full datetime — but this is never stated.
2. **Timezone:** If `time` is stored as a local time string with no timezone, every follow-up calculation (T−5min before deadline) will be wrong for any business not running on the server's clock. This is compounded by R4-C3 (no timezone on Business). If R4-C3 is resolved, `Appointment.time` should be stored as a full UTC timestamp computed from `Schedule.date + Appointment.time + Business.timezone`.

**Decision:** `Appointment.time` renamed to `Appointment.starts_at` — a full UTC timestamp (`TIMESTAMPTZ`). Computed at creation from `Schedule.date + slot time + Business.timezone` (IANA timezone from R4-C3). Stored as UTC; displayed in local time in the UI using the business's timezone. `Schedule.date` remains a `DATE` column for display and grouping only — it is not used in time calculations. All Job Scheduler deadline calculations (T−5min, follow-up windows, outreach hours checks) use `Appointment.starts_at` directly.
**Notes:** Appointment entity updated in F001 spec — `time` field renamed to `starts_at` (`TIMESTAMPTZ`). All references to `Appointment.time` in the data flow, Job Scheduler, and follow-up sections updated to `starts_at`.

---

### R4-CL2 — Approve Booking page role access not specified

**Status:** Decided

**Issue:** The Staff Web App pages table marks Settings and Staff Management as "Admin only." The Approve Booking page (`/bookings/pending`) has no role annotation. Based on the F002 permission matrix, approving a booking request is closest to "edit schedule / appointments" — which requires `can_edit_schedule`. But this is inferred, not stated.

If a Staff member without `can_edit_schedule` navigates to `/bookings/pending`, should they see the page (read-only) or get a 403? Can a Viewer see pending requests?

**Decision:** Approve Booking page access defined:
- **Can approve/reject:** Admin (always) and Staff with `can_edit_schedule` — same gate as Schedule Detail actions.
- **Viewer and Staff without `can_edit_schedule`:** page renders read-only; approve/reject buttons disabled.
- **Nav:** frontend hides the Approve Booking nav item for Viewers; direct navigation still renders the page read-only (no hard 403).

**Notes:** Approve Booking page row updated in the Staff Web App Pages table in F001 spec — role annotation added: "Admin + Staff with can_edit_schedule to act; Viewer read-only."

---

### R4-CL3 — Staging environment configuration not defined

**Status:** Decided

**Issue:** Three environments are defined (development, staging, production). No guidance is given on how staging is configured:

- Does staging use a real SendGrid API key (risk of sending real emails) or a test/sandbox account?
- Does staging use real FCM credentials or a separate Firebase test project?
- Does staging connect to a separate database, or is it shared with production?

A developer setting up staging for the first time has no spec to follow.

**Decision:** Staging environment configuration defined:
- **Database:** separate staging database, never shared with production. Same schema, independent data.
- **SendGrid:** sandbox mode — emails processed but never delivered to real inboxes. Prevents accidental sends during testing.
- **Firebase/FCM:** separate Firebase project for staging. Push notifications go to test devices only.
- **Seed data:** `npm run seed:admin` available in staging (`NODE_ENV=staging`); blocked only on `NODE_ENV=production`.
- **`NODE_ENV`:** `staging` — production-like behavior (no dev shortcuts) but seed script is not blocked.
- All staging credentials are separate env vars with no values shared with production config.

**Notes:** Staging environment configuration added to the Operational Considerations section in F001 spec.

---

## What's Well-Defined (Round 4)

The following areas are clear and complete after all four rounds — no revisiting needed:

- Full database entity model (all entities, fields, types, nullability, indexes, multi-tenancy)
- Staff-initiated outreach loop, follow-up schedule, deadline enforcement, cancellation logic
- Waitlist system (first-in-first-served, LLM matching, 30-min window, two-message sequence)
- WebSocket channel structure and 7-event schema
- Staff Web App: 10 pages, routes, key actions, desktop-only scope
- Client App: 5 screens, bottom tab navigation, offline behavior, push tap behavior
- Non-functional requirements (performance, security, scalability, compliance, observability baselines)
- Environment variables (16 documented, .env.example required)
- System bootstrap (dev seed + production endpoint, F004 dependency noted)
- Operational considerations (migrations, 3 envs, app store, Sentry, Bull Board in scope; CI/CD, backups out of scope)
- Technology stack (React, React Native, Node.js/TypeScript, PostgreSQL, Bull, Ollama — all decided)
- AI provider abstraction (Ollama for dev; config-only swap to production provider)
- F002 (auth), F003 (state machine) — fully specified, cross-referenced
- Architecture principles (error delegation, row-level multi-tenancy, single source of truth, provider abstraction)
- Business.settings schema (5 keys with defaults)
- Client opt-out (self-service + staff flag)
- Staff Alert System (9 triggers, escalation chain)

---

## Round 4 Decision Log

| # | Issue | Decision | Date |
| --- | --- | --- | --- |
| R4-C1 | WebSocket authentication not defined | Option A — JWT in Authorization header on upgrade request; 401 on invalid/missing token | 2026-05-05 |
| R4-C2 | Booking approval timeout and rejection path undefined | Option A — 2hr configurable window; timeout/rejection both offer slots or waitlist; slot-gone treated as R4-C4 conflict | 2026-05-05 |
| R4-C3 | Business timezone not stored | Option A — `timezone` IANA field added to Business entity; default UTC; all server-side time ops use it; F004 must require it at setup | 2026-05-05 |
| R4-C4 | No concurrency protection against double-booking | Option A — conditional UPDATE with status+client_id guard; 0 rows affected triggers conflict branch (offer alternatives or waitlist) | 2026-05-05 |
| R4-CONTRA-1 | AI write boundary vs. service_type contradiction | Option A — `service_type` added to AI write boundary; AI writes it at booking confirmation; staff can correct via R3-CL3 | 2026-05-05 |
| R4-G1 | Short code redemption error states | Three error codes defined (EXPIRED, USED, INVALID); 5-attempt lockout for wrong code; staff resends for expired/used | 2026-05-05 |
| R4-G2 | Resend invite lifecycle | Old code invalidated; new code always generated; resend disabled for registered clients — use F002 Expire Session instead | 2026-05-05 |
| R4-G3 | Client UX during booking approval wait | Holding message while waiting; rejection offers slots or waitlist; new `awaiting_approval` state needed in F003 | 2026-05-05 |
| R4-G4 | API cross-cutting conventions | `/api/v1/` base; standard error envelope with code+message; Bearer auth; cursor-based pagination (default 50) | 2026-05-05 |
| R4-G5 | Minimum OS version support | iOS 16 minimum; Android API 26 (Android 8.0) minimum; both cover ~95%+ of active devices | 2026-05-05 |
| R4-G6 | Message pagination | 50-message initial load; cursor-based load-more on scroll; new messages via WebSocket; no cache pagination | 2026-05-05 |
| R4-G7 | CORS configuration | Whitelisted origins via ALLOWED_ORIGINS env var; credentials: true; GET/POST/PUT/PATCH/DELETE/OPTIONS; no wildcard | 2026-05-05 |
| R4-CL1 | Appointment.time type and timezone | Renamed to `starts_at` (TIMESTAMPTZ); computed from Schedule.date + slot time + Business.timezone; stored as UTC | 2026-05-05 |
| R4-CL2 | Approve Booking page role access | Admin + Staff with can_edit_schedule can act; Viewer and others see read-only; no hard 403 | 2026-05-05 |
| R4-CL3 | Staging environment configuration | Separate DB + Firebase project; SendGrid sandbox mode; seed script allowed; NODE_ENV=staging; no shared prod credentials | 2026-05-05 |
