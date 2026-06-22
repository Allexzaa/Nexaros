# F003 — AI Engine: Conversation State Machine

**Created:** 2026-05-05
**Status:** Approved
**Depends on:** [F001 — Core System Architecture](F001-core-architecture-spec.md), [F002 — Authentication & Authorization](F002-auth-spec.md)
**Review:** Decisions captured in [F001-core-architecture-review.md](F001-core-architecture-review.md) — item C6
**Resolved 2026-05-06:** Client-initiated booking path uses a UI slot picker (not chat). Client selects a slot in the mobile app → API creates Appointment + Conversation → AI confirms via same flow as outreach-triggered. The `awaiting_approval` state is reserved for edge-case in-chat requests only (unusual service type, custom duration the AI cannot auto-confirm). `conversation.appointment_id` stays `NOT NULL`. See decision memory for full rationale.

---

## Overview

Every client conversation is a finite state machine. The AI Engine drives the machine by processing incoming client messages, determining intent via LLM, and selecting the next action and state. Without a defined state machine, different developers will implement conflicting behavior for the same scenarios. This spec defines every state, every event that causes a transition, every edge case, and the rules the LLM must follow.

---

## States

Each Conversation record has exactly one state at any moment.

| State | Description |
| --- | --- |
| `idle` | Outreach queued but AI has not yet sent the first message |
| `awaiting_reply` | AI sent a message and is waiting for the client to respond |
| `processing` | Client sent a message; AI is calling the LLM to determine intent |
| `confirming` | AI sent a confirmation request; waiting for client's final "yes" |
| `rescheduling` | Client said they can't make it; AI is gathering their day/time preferences |
| `slot_offered` | AI has presented one or more alternative slots; waiting for client to choose |
| `waitlisted` | No available slots; client preferences recorded; waiting for a slot to open |
| `escalated` | AI determined it cannot handle the conversation; staff has been notified |
| `staff_active` | Staff has taken over; AI is paused (`taken_over_by` is set) |
| `confirmed` | Appointment locked; conversation complete |
| `no_response` | Deadline passed with no reply after all follow-ups; slot released |
| `cancelled` | Client explicitly declined all options or requested to stop |
| `awaiting_approval` | AI routed a client-initiated booking request to staff; conversation on hold pending staff decision |
| `resolved` | Terminal state; encompasses confirmed, no_response, and cancelled |

**Terminal states:** `confirmed`, `no_response`, `cancelled`, `resolved`. No transitions out of these except a manual staff action.

---

## Events (Triggers)

Events cause state transitions. They come from three sources: client actions, system timers, and staff actions.

### Client-originated events

| Event | Description |
| --- | --- |
| `message_received` | Client sends any message |
| `confirmation_intent` | LLM classifies client message as intent to confirm |
| `decline_intent` | LLM classifies client as unable to attend |
| `question_intent` | LLM classifies client message as a question about the appointment |
| `reschedule_preference_given` | LLM extracts specific day/time preferences for rescheduling |
| `slot_accepted` | Client selects or confirms an offered alternative slot |
| `slot_declined` | Client rejects the offered slot |
| `opt_out` | Client explicitly says stop, unsubscribe, remove me, don't contact me |
| `ambiguous_message` | LLM confidence below threshold; intent unclear |
| `off_topic_message` | LLM classifies message as unrelated to scheduling |
| `human_requested` | Client explicitly asks to speak to a person |

### System-originated events

| Event | Description |
| --- | --- |
| `outreach_triggered` | Staff clicks Trigger Outreach; queues first message |
| `follow_up_timer_fired` | Job Scheduler fires a scheduled follow-up |
| `deadline_reached` | Appointment confirmation deadline passes with no confirmation |
| `llm_api_failure` | LLM call fails or times out |
| `slot_released` | A slot opens (cancellation, no-response, deadline) |
| `waitlist_match_found` | LLM matched this client's preferences to an open slot |
| `waitlist_no_match` | Open slot does not match this client's preferences |
| `job_cancellation` | Pending follow-up jobs are cancelled (client responded) |
| `booking_routed_to_staff` | AI determined booking request is uncertain; staff notification sent |
| `approval_timeout` | `booking_approval_timeout_hours` window expired with no staff response |

### Staff-originated events

| Event | Description |
| --- | --- |
| `staff_takeover` | Staff sets `taken_over_by` on the Conversation |
| `staff_returns_to_ai` | Staff clears `taken_over_by`; AI resumes |
| `staff_forces_close` | Staff manually marks conversation resolved |
| `staff_resumes_after_no_response` | Staff re-opens a no_response conversation manually |
| `staff_approved_booking` | Staff approves a pending client-initiated booking request |
| `staff_rejected_booking` | Staff rejects a pending client-initiated booking request |

---

## State Transition Table

| Current State | Event | Next State | Action |
| --- | --- | --- | --- |
| `idle` | `outreach_triggered` | `awaiting_reply` | AI sends initial outreach message |
| `awaiting_reply` | `message_received` | `processing` | Queue LLM intent detection |
| `awaiting_reply` | `follow_up_timer_fired` | `awaiting_reply` | AI sends follow-up message; increment follow_up_count |
| `awaiting_reply` | `deadline_reached` | `no_response` | Release slot; notify staff; trigger waitlist check |
| `awaiting_reply` | `staff_takeover` | `staff_active` | AI paused; staff notified |
| `processing` | `confirmation_intent` | `confirming` | AI sends confirmation request: "Just to confirm — [details]. Can I lock this in for you?" |
| `processing` | `decline_intent` | `rescheduling` | AI acknowledges; asks for day/time preferences |
| `processing` | `question_intent` | `awaiting_reply` | AI answers question; awaits next reply |
| `processing` | `reschedule_preference_given` | `rescheduling` | Preferences extracted; Slot Manager queried |
| `processing` | `off_topic_message` (1st) | `awaiting_reply` | AI redirects: "I can only help with your appointment for [date]." |
| `processing` | `off_topic_message` (2nd+) | `escalated` | AI escalates; staff notified |
| `processing` | `ambiguous_message` (1st) | `awaiting_reply` | AI asks for clarification: "Sorry, could you confirm — are you able to make it?" |
| `processing` | `ambiguous_message` (2nd+) | `escalated` | AI escalates; staff notified |
| `processing` | `human_requested` | `escalated` | AI responds: "I'll connect you with our team." Staff notified immediately |
| `processing` | `opt_out` | `cancelled` | AI confirms stop; mark conversation cancelled; no further outreach |
| `processing` | `llm_api_failure` | `escalated` | AI cannot respond; staff notified with reason |
| `processing` | `booking_routed_to_staff` | `awaiting_approval` | AI sends holding message: "I've passed your request to the office for review. I'll get back to you as soon as they confirm — usually within a couple of hours." Approval-wait job queued. |
| `confirming` | `confirmation_intent` | `confirmed` | Slot locked; confirmation message sent; appointment status → confirmed |
| `confirming` | `decline_intent` | `rescheduling` | AI acknowledges change of mind; asks for preferences |
| `confirming` | `ambiguous_message` | `confirming` | AI re-asks confirmation: "Just confirming — yes or no?" |
| `confirming` | `message_received` (no clear intent) | `confirming` | Re-prompt once; escalate if repeated |
| `confirming` | `deadline_reached` | `no_response` | Release slot; notify staff; trigger waitlist check |
| `confirming` | `staff_takeover` | `staff_active` | AI paused |
| `rescheduling` | `reschedule_preference_given` | `slot_offered` | Slot Manager finds closest match → AI presents single best slot: "This is the only option I have. Would this work?" |
| `rescheduling` | `reschedule_preference_given` (no match) | `waitlisted` | Slot Manager returns no match → AI informs client; WaitlistEntry created with preferences |
| `rescheduling` | `staff_takeover` | `staff_active` | AI paused; staff sees gathered preferences in context |
| `slot_offered` | `slot_accepted` | `confirmed` | New slot locked; old slot freed; confirmation message sent |
| `slot_offered` | `slot_declined` | `waitlisted` | No re-offer; AI adds client to waitlist: "I'll reach out if something matching your preferences opens up." |
| `slot_offered` | `staff_takeover` | `staff_active` | AI paused |
| `waitlisted` | `waitlist_match_found` | `awaiting_reply` | AI sends slot offer; WaitlistEntry status → notified |
| `waitlisted` | `waitlist_no_match` | `waitlisted` | Move to next waitlist entry; this entry stays waiting |
| `waitlisted` | `staff_takeover` | `staff_active` | AI paused |
| `escalated` | `staff_takeover` | `staff_active` | Staff takes over |
| `escalated` | `staff_forces_close` | `resolved` | Closed manually |
| `staff_active` | `staff_returns_to_ai` | `awaiting_reply` | AI resumes; sends re-engagement message if needed |
| `staff_active` | `staff_forces_close` | `resolved` | Closed manually |
| `no_response` | `staff_resumes_after_no_response` | `awaiting_reply` | Staff re-opens; AI can re-engage |
| `no_response` | `staff_forces_close` | `resolved` | Closed manually |
| `awaiting_approval` | `message_received` | `awaiting_approval` | AI sends holding reply: "We're still waiting on confirmation from the office — I'll update you shortly." No LLM call needed. |
| `awaiting_approval` | `staff_approved_booking` | `slot_offered` | Approval-wait job cancelled. AI searches for available slot; presents best match to client. |
| `awaiting_approval` | `staff_rejected_booking` | `slot_offered` or `waitlisted` | Approval-wait job cancelled. AI sends: "Unfortunately the office isn't able to accommodate that request. Let me check what's available for you." If slots exist → `slot_offered`; if none → `waitlisted`. |
| `awaiting_approval` | `approval_timeout` | `slot_offered` or `waitlisted` | Same outcome as `staff_rejected_booking` — AI informs client it couldn't be confirmed and checks for alternatives. |
| `awaiting_approval` | `staff_takeover` | `staff_active` | AI paused; approval-wait job cancelled. |
| `confirmed` | `message_received` | `confirmed` | AI acknowledges: "Your appointment is confirmed. See you [date]!" Stays confirmed |
| `confirmed` | `staff_forces_close` | `resolved` | Closed manually |
| `cancelled` | `staff_forces_close` | `resolved` | Closed manually |

---

## LLM Intent Detection Protocol

Every time `message_received` fires, the AI Engine calls the LLM with:

### Input to LLM

```text
System prompt:
  You are a scheduling assistant for [Business Name].
  Your only job is to confirm, reschedule, or handle questions about appointments.
  Current conversation state: [state]
  Appointment details: [date, time, location if set]
  Available alternative slots (if in rescheduling): [list]

Conversation history: [last N messages]
New client message: "[message text]"

Respond in JSON:
{
  "intent": "confirm | decline | question | reschedule_preference | slot_accept | slot_decline | opt_out | off_topic | ambiguous | human_requested",
  "confidence": 0.0–1.0,
  "response_text": "The message to send to the client",
  "extracted_preferences": "any stated day/time preferences (null if none)"
}
```

### Confidence Threshold

| Confidence | Action |
| --- | --- |
| ≥ 0.75 | Use detected intent |
| 0.50–0.74 | Treat as `ambiguous_message` — AI asks clarification |
| < 0.50 | Treat as `ambiguous_message` — escalate on second occurrence |

### Escalation Rules (override any state)

These always trigger `escalated` regardless of current state:

1. Intent = `human_requested` — client explicitly asks for a person
2. Intent = `opt_out` — client wants to stop (→ `cancelled` instead)
3. `ambiguous_message` on second consecutive occurrence from same conversation
4. `off_topic_message` on second consecutive occurrence
5. `llm_api_failure` — LLM is down or times out
6. Message contains distress keywords (defined list, e.g. "emergency", "urgent help", "threatening") — immediate escalation, no LLM needed

---

## Follow-Up Sequence Within `awaiting_reply`

The state stays `awaiting_reply` throughout the follow-up sequence. The Job Scheduler manages the timing.

| follow_up_count | Trigger | Message intent |
| --- | --- | --- |
| 0 | Outreach sent | Initial message |
| 1 | T+5 min after outreach | "We only have until [deadline]. After that, your slot goes to someone else." |
| 2 | T+1 hr after follow-up 1 | "Following up — we're getting close. Do you want to confirm?" |
| 3 | T−5 min before deadline | "Last chance — 5 minutes left. After [deadline] your slot is released." |
| — | Deadline reached | → `no_response` |

**Cancellation rule:** When `message_received` fires in `awaiting_reply`, all pending follow-up jobs for that conversation are immediately cancelled by the Job Scheduler. follow_up_count is not reset — it records how many fired before the client responded.

---

## Edge Cases

| Scenario | Behavior |
| --- | --- |
| Client says "who is this?" | AI responds: "This is [Business Name]'s scheduling assistant. I'm reaching out about your [date] appointment." Stays in current state. |
| Client replies after `no_response` | System logs the message. Conversation stays `no_response`. Staff is notified — they decide whether to re-open. |
| Client replies after `confirmed` | AI responds with a friendly acknowledgement: "Your appointment is confirmed for [date]. See you then!" Stays `confirmed`. |
| Client sends multiple rapid messages | Messages are queued. AI processes them in order. Only one LLM call active per conversation at a time. |
| Staff takes over then goes offline | `taken_over_by` remains set. Conversation stays `staff_active`. Timer fires after configurable inactivity window → staff alerted again. |
| LLM returns malformed JSON | Treated as `llm_api_failure` → escalate. |
| Slot offered is booked by another client before this client accepts | Slot Manager detects conflict → AI apologizes, returns to `rescheduling` with new available options. |
| Client is on waitlist and a slot opens but they've since been confirmed elsewhere | WaitlistEntry.status checked — if already `scheduled`, skip and move to next entry. |
| No staff online when escalation fires | Alert queued. First staff to open dashboard sees the escalated conversation highlighted. |
| Client sends multiple messages during `awaiting_approval` | Each message receives the same holding reply. No LLM calls triggered. State stays `awaiting_approval`. |
| Staff approves but no slot is available at that moment | Treated as a booking conflict (R4-C4 pattern) — AI informs client the slot is no longer available and checks for alternatives; → `slot_offered` or `waitlisted`. |

---

## Staff-Facing Escalation Alert

When a conversation transitions to `escalated`, the Staff Alert System fires:

- Alert type: `ai_escalation`
- Payload: conversation_id, client name, last message, escalation reason
- Delivery: in-app notification (V1), push notification (V2)
- Dashboard: conversation card turns red and moves to top of the list

Staff sees: the full conversation thread, the escalation reason, and a "Take Over" button. Taking over sets `taken_over_by` → state transitions to `staff_active`.

---

## Data Model Additions

### Conversation entity — additions

| Field | Type | Notes |
| --- | --- | --- |
| `state` | enum | All states listed above; default `idle` |
| `offered_slot_id` | uuid (nullable) | Appointment.id of slot currently being offered in `slot_offered` state |
| `escalation_reason` | text (nullable) | Why the AI escalated; set on transition to `escalated` |
| `consecutive_ambiguous_count` | integer | Resets to 0 on any clear intent; increments on ambiguous/off-topic; triggers escalation at 2 |
| `context_summary` | text (nullable) | LLM-generated summary of messages older than the last 10; prepended to every LLM call once thread exceeds 10 messages |

### No new tables required

---

## Happy Path — Sequence Example

1. Staff triggers outreach → Conversation: `idle` → `awaiting_reply`
2. AI sends: "Hi [Name], this is [Business]. Your appointment is [date/time]. Can we confirm you for this slot?"
3. Client replies: "Yes that works" → `awaiting_reply` → `processing`
4. LLM: intent = `confirm`, confidence = 0.95
5. → `confirming`. AI sends: "Great — just to confirm: [date, time, location]. Shall I lock this in?"
6. Client replies: "Yes" → `confirming` → `processing` → `confirmed`
7. AI sends: "You're all set! See you [date] at [time]."
8. Appointment status → `confirmed`. All pending follow-up jobs cancelled.

## Rescheduling Path — Sequence Example

1. Client replies: "I can't make Tuesday" → `processing` → decline_intent → `rescheduling`
2. AI: "No problem. What days or times generally work better for you?"
3. Client: "Wednesday mornings" → `processing` → reschedule_preference_given → Slot Manager queried
4. Match found → `slot_offered`. AI: "This is the only option I have — Wednesday [date] at 10am. Would that work?"
5. Client: "Perfect" → `slot_accepted` → `confirmed`. Old slot freed. Waitlist check triggered on freed slot.
6. **If client declines:** → `waitlisted`. AI: "I'll reach out if something matching your preferences opens up." WaitlistEntry created.

## Waitlist Re-engagement Path — Sequence Example

1. Slot released (deadline, cancellation, or no-response)
2. Job Scheduler triggers waitlist check immediately
3. LLM checks each WaitlistEntry (oldest first) against open slot
4. First match found → `idle` → `awaiting_reply`. AI: "Hi [Name], a slot just opened up — [date] at [time]. Would this work for you?"
5. Client accepts → `confirmed`. WaitlistEntry status → `scheduled`.
6. Client declines → WaitlistEntry stays `waiting`; AI moves to next entry on list
7. No match in list → slot stays `available` for manual booking

## Booking Approval Path — Sequence Example

1. Client sends: "Can I book a 90-minute deep tissue massage?" → `processing`
2. LLM: intent = client-initiated booking, confidence low (unusual duration) → `booking_routed_to_staff`
3. → `awaiting_approval`. AI sends: "I've passed your request to the office for review. I'll get back to you as soon as they confirm — usually within a couple of hours."
4. Staff notification sent: "Client [Name] has requested a 90-minute deep tissue massage — please approve or reject."
5. **If staff approves within window:** Approval-wait job cancelled. AI finds available slot → `slot_offered`. AI: "The office confirmed they can do that. Here's the next available slot — [date] at [time]. Would that work?"
6. **If staff rejects:** Approval-wait job cancelled. AI: "Unfortunately the office isn't able to accommodate that request. Let me check what's available for you." Checks slots → `slot_offered` or `waitlisted`.
7. **If timeout fires:** Same outcome as rejection.

## No-Response Path — Sequence Example

1. Outreach sent → `awaiting_reply`
2. T+5 min: follow-up 1 fires → AI sends urgency message → `awaiting_reply`
3. T+1hr: follow-up 2 fires → AI sends check-in → `awaiting_reply`
4. T−5 min: follow-up 3 fires → AI sends last-chance message → `awaiting_reply`
5. Deadline reached → `no_response`. Slot released. Staff notified. Waitlist triggered.

---

## Auto-Pickup: Schedule Watcher

The AI does not require staff to manually trigger outreach. Two mechanisms start the outreach process:

**Manual trigger:** Staff clicks Trigger Outreach on a schedule → immediate outreach for all `pending-outreach` appointments on that schedule.

**Auto-pickup watcher:** A recurring Job Scheduler task runs every 5 minutes (configurable). It scans for any Appointment rows with status `pending-outreach` that have no associated Conversation yet. When found, it creates Conversations and starts outreach automatically — no staff action needed.

This means staff can simply add appointments to a schedule and walk away. The AI will pick them up within 5 minutes.

**Outreach hours window:** Auto-pickup respects a configurable hours window in `Business.settings.outreach_hours_start` and `Business.settings.outreach_hours_end` (e.g. 9am–7pm). If the watcher fires outside this window, it queues the outreach to fire at the start of the next window. Manual triggers override the window — staff can send immediately at any time.

**Business.settings additions:**

| Key | Default | Description |
| --- | --- | --- |
| `outreach_response_window_hours` | 2 | Hours from outreach trigger before slot auto-releases |
| `outreach_hours_start` | 09:00 | Earliest time AI can send first outreach message |
| `outreach_hours_end` | 19:00 | Latest time AI can send first outreach message |
| `auto_pickup_interval_minutes` | 5 | How often the watcher scans for unprocessed appointments |
| `escalation_keywords` | [] | Office-specific keywords that trigger immediate escalation (added on top of system base list) |

**Note:** Waitlist response window is fixed at 30 minutes — not office-configurable. See [F001-core-architecture-review.md](F001-core-architecture-review.md) item G7.

---

## Open Questions (for review)

1. **Confirmation deadline default** — ~~per-appointment deadline removed entirely~~. Global default: 2 hours from outreach trigger, office-configurable via `Business.settings.outreach_response_window_hours`. `confirmation_deadline` removed from Appointment entity. **Decided 2026-05-05.**
2. **Rescheduling flow** — ~~offer multiple slots~~. AI asks for preferred time/date first, finds single best match, presents it as the only option. Decline → waitlist immediately. Waitlisted clients stay on list; AI re-notifies on future slot releases. Auto-pickup watcher added (5-min interval, respects outreach hours window). **Decided 2026-05-05.**
3. **Waitlist offer timeout** — ~~office-configurable~~. Fixed at 30 minutes — not configurable. Two-message sequence: offer at T+0, reminder at T+25 min, move to next at T+30. `waitlist_offer_timeout_minutes` removed from Business.settings. **Revised 2026-05-05 (F001 review G7).**
4. **AI re-engagement after staff returns to AI** — Option C: AI checks last message sender on resume. If last message was from client (unanswered), AI responds to it. If last message was from staff or AI, AI stays silent and waits for next client reply or follow-up timer. **Decided 2026-05-05.**
5. **Distress keyword list** — Option C: system-wide hardcoded base list (e.g. "emergency", "urgent help", "threatening", "lawyer", "lawsuit") that always applies and cannot be removed by offices. Each office can add extra keywords via `Business.settings.escalation_keywords`. Base list is platform-maintained. **Decided 2026-05-05.**
6. **LLM context window** — Option C: last 10 messages sent to LLM on every call. When message count exceeds 10, a separate LLM call generates a running summary of the older messages. Summary stored in `Conversation.context_summary` and prepended to every subsequent LLM call as compressed context. Summary is regenerated each time a new message pushes an old one out of the window. **Decided 2026-05-05.**
