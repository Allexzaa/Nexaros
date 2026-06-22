# F013 — Post-Appointment Follow-Up

**Status:** Spec Ready  
**Date:** 2026-05-06  
**Author:** Claude  

---

## Goal

Automatically follow up with clients after their appointment to collect a rating or review. This drives Google/Yelp reviews for the business and gives the owner signal on client satisfaction — without any manual effort.

---

## Scope

| Area | What |
|---|---|
| Follow-up trigger | Send message N hours after appointment completion |
| Rating collection | In-conversation 1–5 star rating via SMS reply |
| Review redirect | If rating ≥ 4, send a Google/Yelp review link |
| Low rating flag | If rating ≤ 2, escalate to staff for service recovery |
| Rating storage | Per-appointment rating record |
| Staff visibility | Rating shown on appointment detail |

Out of scope: NPS survey, email-only follow-up (SMS first), public review aggregation dashboard, responding to reviews programmatically.

---

## Existing Foundation

- F003: AI conversation state machine — follow-up is a new terminal flow that runs outside an existing conversation
- F005: `smsService` delivery
- F008: BullMQ delayed jobs pattern (same pattern for scheduling follow-up)
- `appointment` table with `status` and `scheduled_at`
- `business.settings` JSONB for configuration

---

## Data Model

### New table: `appointment_rating`

```sql
CREATE TABLE appointment_rating (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id UUID NOT NULL UNIQUE REFERENCES appointment(id),
  client_id      UUID NOT NULL REFERENCES client(id),
  business_id    UUID NOT NULL REFERENCES business(id),
  score          INTEGER CHECK (score BETWEEN 1 AND 5),
  comment        TEXT,
  follow_up_sent_at TIMESTAMPTZ,
  responded_at   TIMESTAMPTZ,
  review_link_sent BOOLEAN NOT NULL DEFAULT false,
  escalated      BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON appointment_rating (business_id, created_at DESC);
CREATE INDEX ON appointment_rating (client_id);
```

### New `business.settings` keys

```json
{
  "followup_delay_hours": 2,
  "followup_enabled": true,
  "review_link_google": null,
  "review_link_yelp": null,
  "followup_low_score_threshold": 2
}
```

---

## 1. Follow-Up Trigger

### Appointment completion detection

Two trigger paths:

**Path A — Staff marks appointment complete** (requires F010 `completed` status addition)  
→ Immediately schedule follow-up job with `delay = followup_delay_hours * 3600 * 1000`

**Path B — Time-based fallback**  
A daily cron at midnight queries appointments where:
- `status = 'confirmed'`
- `scheduled_at + duration < now`
- No `appointment_rating` row exists
- No follow-up already queued

Schedules follow-up job for each match.

### Service: `src/services/followUpService.ts`

```ts
scheduleFollowUp(appointmentId: string): Promise<void>
```

1. Load appointment + client + business settings
2. Skip if `followup_enabled = false` or `client.opted_out = true`
3. Skip if `appointment_rating` row already exists for this appointment
4. Enqueue BullMQ delayed job
5. Insert `appointment_rating` row with `follow_up_sent_at = null` (populated when sent)

---

## 2. Follow-Up Job Processor

### Job: `jobs/followUpJob.ts`

```ts
processor(job: Job<{ appointmentId: string }>): Promise<void>
```

1. Load appointment rating record — if already has `score`, skip
2. Load client — if `opted_out`, skip
3. Send SMS via `smsService`:

> "Hi [Name], how was your [Service] at [Business]? Reply with a number 1–5 (5 = great!)"

4. Update `appointment_rating.follow_up_sent_at = now`
5. Open a new `conversation` in state `AWAITING_FOLLOWUP_REPLY` (new state) for inbound reply routing

---

## 3. New Conversation State: `AWAITING_FOLLOWUP_REPLY`

### State machine addition (F003 extension)

New state in `StateEngine`:

| State | Valid input | Transition |
|---|---|---|
| `AWAITING_FOLLOWUP_REPLY` | `FOLLOWUP_SCORE` | → `FOLLOWUP_RECEIVED` |
| `AWAITING_FOLLOWUP_REPLY` | `UNRECOGNIZED` (after 1 retry) | → `CLOSED` |

**Intent: `FOLLOWUP_SCORE`** — LLM or regex detects a 1–5 digit in the reply body.

### On `FOLLOWUP_SCORE`

1. Store score in `appointment_rating.score`, `responded_at = now`
2. If `score >= 4` and a review link is configured:
   - Send: "Glad to hear it! Would you mind leaving us a quick review? [link]"
   - Set `review_link_sent = true`
3. If `score <= followup_low_score_threshold`:
   - Send: "We're sorry to hear that. A team member will be in touch shortly."
   - Set `appointment_rating.escalated = true`
   - Emit escalation event to staff (Socket.io + notification)
4. Transition conversation → `CLOSED`

---

## 4. Low-Score Escalation Visibility (Staff)

### Staff dashboard (F007) — new panel section

On the Conversations page, add a "Needs Attention" subsection for low-score escalations:
- Client name, appointment date, score, time since response
- Link to conversation
- "Mark resolved" button → clears escalation flag

### `GET /api/v1/reports/ratings` (extend F010)

```json
{
  "averageScore": 4.3,
  "responseRate": 0.61,
  "distribution": { "1": 2, "2": 3, "3": 8, "4": 21, "5": 47 },
  "lowScoreEscalations": 5,
  "reviewLinksClicked": 31
}
```

---

## 5. Rating Visibility on Appointment

### Extend `GET /api/v1/appointments/:id` response

```json
{
  "rating": {
    "score": 5,
    "comment": null,
    "respondedAt": "2026-04-15T14:30:00Z"
  }
}
```

`null` if no rating yet.

---

## Phases (proposed)

| Phase | Scope |
|---|---|
| 1 | DB migration + `followUpService` + BullMQ job + trigger on appointment complete |
| 2 | New `AWAITING_FOLLOWUP_REPLY` state + score detection + review link send |
| 3 | Low-score escalation + staff visibility in F007 dashboard |
| 4 | Ratings in appointment detail API + ratings section in F010 reports |

---

## Open Questions

1. Should the follow-up conversation reuse the existing `conversation` row for the original booking, or always create a new one?
2. What if the client didn't respond to the follow-up — should we send one reminder after 24h, or leave it?
3. Should high-scoring clients (5 stars) be automatically added to a "VIP" segment for priority booking or outreach campaigns (F014)?
4. Is a free-text comment field needed, or just the 1–5 score via SMS?
