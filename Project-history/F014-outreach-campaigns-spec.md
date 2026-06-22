# F014 — Outreach Campaigns

**Status:** Spec Ready  
**Date:** 2026-05-06  
**Author:** Claude  

---

## Goal

Let admins proactively re-engage dormant clients and run targeted outreach campaigns — "you haven't visited in 6 weeks, want to book?" — using the AI conversation engine. This drives repeat bookings without any manual effort per client.

---

## Scope

| Area | What |
|---|---|
| Campaign creation | Admin defines audience, message template, and send time |
| Audience builder | Filter clients by last visit, visit count, service type, or manual list |
| AI-powered outreach | Each campaign message kicks off an AI conversation (reuses F003 outreach flow) |
| Send schedule | Immediate or scheduled; respect business outreach hours |
| Campaign analytics | Sent, replied, booked, opted-out counts per campaign |
| Opt-out handling | STOP reply removes client from all future campaigns |

Out of scope: A/B testing, email campaigns (SMS-first), campaign automation chains (drip sequences), third-party CRM import.

---

## Existing Foundation

- F003: outreach trigger already exists — `POST /api/v1/schedules/:id/outreach` starts an AI conversation. Campaigns reuse this path at scale.
- F005: `smsService` with delivery tracking
- `client.opted_out` flag exists (F004) — batch cancel enforced
- BullMQ for job processing
- `business.settings.outreach_hours_start/end` — already enforced by F003

---

## Data Model

### New table: `campaign`

```sql
CREATE TABLE campaign (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES business(id),
  created_by      UUID NOT NULL REFERENCES staff_user(id),
  name            TEXT NOT NULL,
  message_template TEXT NOT NULL,   -- handlebars-style: "Hi {{firstName}}, ..."
  audience_filter JSONB NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled')),
  scheduled_for   TIMESTAMPTZ,      -- null = send immediately on launch
  send_rate_per_minute INTEGER NOT NULL DEFAULT 10,  -- throttle to avoid spam flags
  total_recipients INTEGER,         -- populated on launch
  sent_count      INTEGER NOT NULL DEFAULT 0,
  replied_count   INTEGER NOT NULL DEFAULT 0,
  booked_count    INTEGER NOT NULL DEFAULT 0,
  optout_count    INTEGER NOT NULL DEFAULT 0,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON campaign (business_id, created_at DESC);
```

### New table: `campaign_recipient`

```sql
CREATE TABLE campaign_recipient (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   UUID NOT NULL REFERENCES campaign(id) ON DELETE CASCADE,
  client_id     UUID NOT NULL REFERENCES client(id),
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sent', 'replied', 'booked', 'opted_out', 'failed', 'skipped')),
  conversation_id UUID REFERENCES conversation(id),
  sent_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON campaign_recipient (campaign_id, status);
CREATE INDEX ON campaign_recipient (client_id);
CREATE UNIQUE INDEX ON campaign_recipient (campaign_id, client_id);
```

---

## 1. Audience Filter

### `audience_filter` JSONB schema

```json
{
  "lastVisitDaysAgo": { "min": 30, "max": 180 },
  "minVisitCount": 1,
  "scheduleIds": ["uuid1", "uuid2"],
  "manualClientIds": ["uuid3"]
}
```

All filters are AND-combined. `manualClientIds` overrides other filters if provided.

### Route: `POST /api/v1/campaigns/preview-audience`

- **Auth:** `requireAuth`, `requireRole('admin')`
- **Body:** `{ audienceFilter: AudienceFilter }`
- **Response:** `{ count: 47, sample: [{ clientId, name, lastVisitAt }] }` (max 5 sample clients)
- Runs the audience query without creating anything — used in the campaign builder UI

### Audience query

```sql
SELECT c.id, c.name, MAX(a.scheduled_at) AS last_visit_at, COUNT(a.id) AS visit_count
FROM client c
LEFT JOIN appointment a ON a.client_id = c.id AND a.status = 'completed'
WHERE c.business_id = $businessId
  AND c.opted_out = false
  AND (filter conditions...)
GROUP BY c.id
HAVING (having conditions...)
```

---

## 2. Campaign Routes

### `POST /api/v1/campaigns`

- **Auth:** `requireAuth`, `requireRole('admin')`
- **Body:** `{ name, messageTemplate, audienceFilter, scheduledFor? }`
- **Validation:**
  - `messageTemplate`: non-empty; max 160 chars (SMS limit); valid handlebars variables (only `{{firstName}}`, `{{businessName}}`, `{{bookingLink}}` allowed)
  - `scheduledFor`: must be in the future and within business outreach hours
- **Response:** `{ campaignId }`

### `GET /api/v1/campaigns`

- Paginated list with status, sent/replied/booked counts
- Scoped to business

### `GET /api/v1/campaigns/:id`

- Full campaign detail including per-status recipient counts

### `POST /api/v1/campaigns/:id/launch`

- **Auth:** `requireAuth`, `requireRole('admin')`
- Resolves audience → inserts `campaign_recipient` rows
- Sets `status = 'running'` (or `'scheduled'` if `scheduled_for` is future)
- Sets `total_recipients`
- Enqueues `campaignSendJob` (immediate or delayed)

### `POST /api/v1/campaigns/:id/pause`

- Sets `status = 'paused'`; BullMQ job checks status before each send

### `POST /api/v1/campaigns/:id/cancel`

- Sets `status = 'cancelled'`; marks pending recipients as `'skipped'`

---

## 3. Campaign Send Job

### Job: `jobs/campaignSendJob.ts`

Processes one campaign in batches:

```ts
processor(job: Job<{ campaignId: string }>): Promise<void>
```

1. Load campaign — if not `running`, exit
2. Load next batch of `campaign_recipient` rows where `status = 'pending'` (batch size = `send_rate_per_minute * 1`)
3. For each recipient:
   - Check `client.opted_out` — if true, mark `status = 'skipped'`
   - Render message template (replace `{{firstName}}`, etc.)
   - Send SMS via `smsService`
   - Create `conversation` row in `AWAITING_REPLY` state (reuse F003 outreach path)
   - Set `campaign_recipient.status = 'sent'`, `campaign_recipient.conversation_id`
   - Increment `campaign.sent_count`
4. If more pending recipients remain: re-enqueue self with 60s delay (rate limiting)
5. If no remaining: set `campaign.status = 'completed'`, `completed_at = now`

---

## 4. Campaign Attribution

### Conversation → Campaign link

When a campaign recipient replies (F003 inbound message flow), detect that the conversation originated from a campaign (`conversation.campaign_recipient_id` → new column):

```sql
ALTER TABLE conversation
  ADD COLUMN campaign_recipient_id UUID REFERENCES campaign_recipient(id);
```

### Status updates

- Client replies → `campaign_recipient.status = 'replied'`; increment `campaign.replied_count`
- Appointment confirmed from this conversation → `campaign_recipient.status = 'booked'`; increment `campaign.booked_count`
- Client sends STOP → `campaign_recipient.status = 'opted_out'`; set `client.opted_out = true`; increment `campaign.optout_count`

---

## 5. Campaign UI (Staff Web)

### New page: `/campaigns`

- Campaign list with status badges and key metrics (sent / replied / booked)
- "New Campaign" button → campaign builder

### Campaign builder wizard

**Step 1 — Details:** Name, message template with live preview and character count  
**Step 2 — Audience:** Filter controls + "Preview audience" count + sample list  
**Step 3 — Schedule:** "Send now" or pick date/time; shows timezone  
**Step 4 — Review:** Final summary + Launch button

### Campaign detail page

- Status, progress bar (sent / total)
- Metrics: sent, replied (% of sent), booked (% of replied), opted out
- Recipient table with status per client (paginated)
- Pause / Cancel buttons

---

## Phases (proposed)

| Phase | Scope |
|---|---|
| 1 | DB migrations + audience query + preview-audience route |
| 2 | Campaign CRUD routes + launch / pause / cancel |
| 3 | Campaign send job + rate limiting + F003 integration (conversation creation) |
| 4 | Attribution tracking (replied / booked / opted-out) + campaign UI in staff-web |

---

## Open Questions

1. Should admins be able to re-send a campaign to clients who didn't reply (after N days), or is each campaign a one-shot?
2. Is 10 messages/minute the right default send rate, or should it be higher? (Twilio A2P 10DLC has its own throughput limits per campaign type.)
3. Should the `{{bookingLink}}` variable automatically generate a short tracked URL to the client booking portal, or just insert the base portal URL?
4. Should viewer-role staff be able to see campaign analytics (read-only), or admin-only?
