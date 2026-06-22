# F016 — Conversational AI Engine

**Status:** Spec Ready
**Author:** Claude (session 2026-05-24)

---

## Problem

The current AI engine is a constrained intent classifier, not a conversational AI. The LLM is forced to output a fixed JSON schema with 10 possible intents. It cannot:

- Answer questions about business policies, services, or hours
- Respond naturally to social messages ("Great, thanks!")
- Handle multi-topic messages gracefully
- Recover from awkward situations with warmth
- Do anything outside the narrow scheduling flow without escalating

Clients experience it as a cold, robotic platform. The "Great, thank you!" → repeated confirmation bug is a symptom of the deeper issue: the LLM has no agency — the state machine drives everything.

---

## Goal

Replace the intent-classification architecture with a **tool-calling conversational AI** that:

1. Holds natural, warm conversations in any direction
2. Calls scheduling tools when it needs to take action (check slots, book, reschedule, cancel)
3. Keeps the state machine as a safety guard — not the conversation driver
4. Remains auditable: every tool call and its result is logged

---

## Architecture Change

### Current flow

```
Client message
  → messageProcessor
    → stateEngine.applyTransition("message_received")
    → LLM(system prompt forces JSON intent)
    → mapIntentToEvent()
    → stateEngine.applyTransition(event)
    → side effects
    → store AI reply
```

### New flow

```
Client message
  → conversationAgent
    → build context (conversation history + business info + available tools)
    → LLM(persona prompt + tool definitions)
      ↳ if tool call → execute tool → feed result back to LLM → repeat
      ↳ when done → LLM returns final natural language reply
    → stateGuard.validate(action) — blocks illegal state transitions
    → apply confirmed action (DB write, slot lock, etc.)
    → store AI reply
```

The LLM drives the conversation. Tools are the only way it touches data.

---

## Components

### 1. Persona system prompt (`prompts.ts` — rewrite)

Replaces the current JSON-schema prompt. Contains:

- Who the AI is: warm, professional scheduling assistant for `{businessName}`
- What it can do: listed as natural language capabilities, not intents
- Business context injected at runtime: services, hours, timezone, cancellation policy
- Tone rules: friendly, concise, never repeat confirmations, don't be robotic
- Escalation rule: offer human if client is distressed or explicitly asks

No JSON schema. No intent list. Natural language response.

### 2. Tool definitions (new file: `tools.ts`)

The LLM is given these callable tools via the function-calling API:

| Tool | Description |
|---|---|
| `check_availability(date_range, time_of_day)` | Returns available slots for a date/time range |
| `reschedule_appointment(slot_id)` | Reschedules the active appointment to a confirmed slot |
| `cancel_appointment()` | Cancels the active appointment |
| `confirm_appointment()` | Confirms the current appointment as-is |
| `get_appointment_details()` | Returns current appointment info (date, time, service) |
| `opt_out_client()` | Marks client as opted out, ends conversation |
| `request_human_takeover(reason)` | Escalates to staff |

Each tool has a JSON schema description so the LLM knows when and how to call it.

### 3. Agent loop (`conversationAgent.ts` — new file, replaces messageProcessor.ts)

Runs the agentic loop:

1. Build messages array: system prompt + conversation history (last N messages + summary)
2. Call LLM with tool definitions
3. If response contains a tool call:
   - Validate it against `stateGuard`
   - Execute the tool
   - Append tool result to messages
   - Call LLM again (up to max 5 iterations)
4. When LLM returns a text reply (no tool call): done
5. Store final reply in DB

### 4. State guard (`stateGuard.ts` — new file)

Lightweight validator that replaces the state machine's role as gatekeeper. Rules:

| Tool called | Allowed in states |
|---|---|
| `confirm_appointment` | `awaiting_reply`, `processing` |
| `reschedule_appointment` | `rescheduling`, `slot_offered`, `awaiting_reply`, `processing` |
| `cancel_appointment` | any active state |
| `check_availability` | any |
| `get_appointment_details` | any |
| `opt_out_client` | any |
| `request_human_takeover` | any |

If the LLM tries a disallowed tool, the guard returns an error message to the LLM ("That action isn't available in the current state") and lets it recover naturally.

### 5. Simplified state model

Current: 13 states drive the entire flow.
New: 5 states used only as DB record + guard context:

| State | Meaning |
|---|---|
| `active` | AI is in control, conversation ongoing |
| `confirmed` | Appointment confirmed, conversation closed |
| `cancelled` | Appointment cancelled |
| `escalated` | Staff has taken over |
| `closed` | Conversation ended (opt-out or staff closed) |

The AI does not transition between states mid-conversation based on message-by-message intent. It calls a tool, the tool executes the action and updates the DB state.

---

## Business context injection

At the start of each agent loop, the system prompt is enriched with live data:

```
Business: {name}
Services offered: {services list from DB}
Business hours: {hours from settings}
Cancellation policy: {from settings}
Current appointment: {service} on {date/time}
Client name: {name}
Today: {date}
```

This lets the LLM answer "what services do you offer?" or "what's your cancellation policy?" without escalating.

---

## What stays the same

- `slotManager.ts` — slot locking, conflict detection, findSlotsForDate, findMatchingSlots
- `timeParser.ts` — deterministic time expression parsing (still used inside tool implementations)
- `contextWindow.ts` — last-N messages + LLM summary (still used to build message history)
- `emitters.ts` — real-time socket events (still fired by tool side effects)
- `jobs/` — outreach, reminders, waitlist jobs unchanged
- Staff takeover / return — unchanged (staff can still take over any conversation)
- `keywords.ts` — distress keyword check still runs before the agent loop

---

## What changes

| File | Action |
|---|---|
| `ai/prompts.ts` | Rewrite — persona prompt, no JSON schema |
| `ai/messageProcessor.ts` | Replace with `ai/conversationAgent.ts` |
| `ai/stateEngine.ts` | Keep for DB writes only; remove transition logic from hot path |
| `ai/types.ts` | Update — remove LLMIntent enum, add ToolCall types |
| `ai/tools.ts` | New — tool definitions + executor functions |
| `ai/stateGuard.ts` | New — per-tool state allowlist |
| `routes/` calling `processIncomingMessage` | Update to call `runConversationAgent` |

---

## LLM API requirement

Tool calling requires the LLM to support function calling (OpenAI-compatible tool_calls format). The current `llmClient` uses the OpenAI-compatible API already — Ollama's `llama3.1:8b` supports function calling with tool_use syntax.

The `client.ts` LLM wrapper needs one addition: handle `tool_calls` in the response alongside `content`.

---

## Phases

### Phase 1 — Tool definitions + agent loop skeleton
- Write `tools.ts`: tool schemas + stub executors
- Write `conversationAgent.ts`: agent loop (build context → LLM → tool dispatch → LLM → reply)
- Write `stateGuard.ts`: allowlist validator
- Update `client.ts` to handle tool_calls in response
- No route changes yet — unit test the agent loop in isolation

### Phase 2 — Tool executors (real DB + slot logic)
- Implement each tool executor using existing slotManager, DB, emitters
- Wire distress check before agent loop
- Wire context window (history + summary) into agent
- All 7 tools functional with real side effects

### Phase 3 — Persona prompt + business context injection
- Rewrite `prompts.ts` — persona prompt, tone rules, business context
- Build context injector: pulls services, hours, policy from DB at call time
- Integration test: full message → agent loop → DB state → reply

### Phase 4 — Route cutover + regression tests
- Replace `processIncomingMessage` calls in routes with `runConversationAgent`
- Update or replace existing message processor tests
- Migrate conversation states in DB (`rescheduling`, `slot_offered`, etc. → `active`)
- End-to-end test: simulate full conversation via the dev simulate panel

---

## Open questions (resolve before Phase 1)

1. **Max tool iterations per message** — 5 is the proposed limit. Raise it? Lower it?
2. **State migration** — existing conversations in `rescheduling` / `slot_offered` / etc. — migrate to `active` or handle legacy states in the guard?
3. **Ollama tool calling** — confirm `llama3.1:8b` reliably calls tools in the local setup before committing. If not, may need a different model (llama3.2, mistral-nemo, etc.)
4. **Conversation history length** — currently last 10 messages. With tool call messages added, this grows faster. Reduce to 6 turns?
