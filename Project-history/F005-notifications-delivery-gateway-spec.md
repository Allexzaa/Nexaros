# F005 — Notifications & Delivery Gateway

**Status:** Spec Ready  
**Date:** 2026-05-06  
**Author:** Claude  

---

## Goal

Replace every stub/console-log delivery path with real outbound channels (SMS via Twilio, email via SendGrid) and build the inbound SMS receive path so the AI engine can process client replies. This is the layer that makes F003's state machine actually reachable by clients.

---

## Scope

| Area | What |
|---|---|
| SMS outbound | Send messages to clients via Twilio |
| SMS inbound | Receive client replies via Twilio webhook → F003 pipeline |
| Email outbound | Transactional emails via SendGrid (invites, confirmations, reminders) |
| Delivery tracking | Log send attempts, status, and failures per message |
| Retry logic | Exponential backoff for failed sends |
| Template system | Parameterized message templates per notification type |

Out of scope: push notifications (deferred to F007 client app), WhatsApp, marketing/bulk campaigns, unsubscribe management beyond existing `opted_out` flag.

---

## Existing Stubs to Replace

- `emailService` — currently console-logs when `SENDGRID_API_KEY` is placeholder
- F003 outreach trigger — generates message text but has no real send path
- Invite email in F002 — uses the same stub emailService
- Appointment confirmation / reminder jobs — message text generated, not sent

---

## Data Model

### New table: `notification_log`

```sql
CREATE TABLE notification_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID NOT NULL REFERENCES business(id),
  client_id     UUID REFERENCES client(id),     -- null for staff emails
  staff_user_id UUID REFERENCES staff_user(id), -- null for client SMS
  channel       TEXT NOT NULL CHECK (channel IN ('sms', 'email')),
  direction     TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  to_address    TEXT NOT NULL,                  -- phone or email
  from_address  TEXT NOT NULL,
  template_key  TEXT,                           -- e.g. 'booking_confirmed'
  body          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','sent','delivered','failed','received')),
  provider_id   TEXT,                           -- Twilio SID or SendGrid message ID
  error_message TEXT,
  metadata      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON notification_log (business_id, created_at DESC);
CREATE INDEX ON notification_log (client_id) WHERE client_id IS NOT NULL;
CREATE INDEX ON notification_log (status) WHERE status IN ('pending','failed');
```

---

## 1. SMS — Outbound (Twilio)

### Service: `src/services/smsService.ts`

```ts
sendSMS(to: string, body: string, context: { businessId: string; clientId?: string; templateKey?: string }): Promise<string>
```

- Sends via `twilio.messages.create({ to, from: TWILIO_FROM_NUMBER, body })`
- Inserts a `notification_log` row with `status: 'sent'` and `provider_id: sid`
- On Twilio error: inserts row with `status: 'failed'`, throws — caller decides retry
- Returns `provider_id` (Twilio SID)

### Retry job: `jobs/retrySmsJob.ts`

- Runs every 5 minutes via BullMQ
- Queries `notification_log` where `channel = 'sms'`, `direction = 'outbound'`, `status = 'failed'`, `created_at > NOW() - INTERVAL '24 hours'`, and `metadata->>'retry_count' < '3'`
- Re-sends with backoff (5 min, 15 min, 60 min between attempts)
- Increments `metadata.retry_count` on each attempt

### Environment variables required

```
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=   # E.164 format, e.g. +15550001234
```

---

## 2. SMS — Inbound (Twilio Webhook)

### Route: `POST /webhooks/twilio/inbound`

- **Auth:** Twilio signature validation via `validateExpressRequest` (twilio library) — return 403 if invalid
- **Body (form-encoded):** `From`, `To`, `Body`, `MessageSid`
- **Behavior:**
  1. Look up `client` by phone number (`From`) and `business` by Twilio number (`To`)
  2. Log to `notification_log` (`direction: 'inbound'`, `status: 'received'`)
  3. Find or create `conversation` for this client (use existing F003 logic)
  4. Call `processIncomingMessage(conversationId, Body)` — the F003 pipeline entry point
  5. Return `<Response/>` (empty TwiML) — reply is sent via outbound SMS asynchronously
- **Error handling:** If client or business not found, log and return 200 (Twilio requires 200 always)

### Environment variables required

```
TWILIO_WEBHOOK_SECRET=  # used for signature validation
```

---

## 3. Email — Outbound (SendGrid)

### Service: `src/services/emailService.ts` (replace stub)

```ts
sendEmail(opts: {
  to: string;
  templateKey: EmailTemplateKey;
  params: Record<string, string>;
  context: { businessId: string; staffUserId?: string; clientId?: string };
}): Promise<string>
```

- Resolves template from `EMAIL_TEMPLATES` map (see below)
- Sends via `@sendgrid/mail` with `sgMail.send()`
- Inserts `notification_log` row; returns `provider_id`
- Dev fallback: if `SENDGRID_API_KEY` is placeholder or `NODE_ENV=test`, console-logs the rendered email and returns a fake ID — no real send

### Template map: `src/services/emailTemplates.ts`

| `templateKey` | Subject | Use |
|---|---|---|
| `staff_invite` | "You've been invited to [Business]" | F002 invite flow |
| `booking_confirmed_client` | "Your appointment is confirmed" | F003 confirmation |
| `booking_confirmed_staff` | "New appointment booked" | Staff notification |
| `booking_reminder_client` | "Reminder: appointment tomorrow" | Reminder job |
| `booking_cancelled_client` | "Your appointment has been cancelled" | Cancel flow |
| `waitlist_slot_available` | "A slot opened up — book now" | Waitlist re-engagement |

All templates: plain text + basic HTML. No SendGrid Dynamic Templates dependency — keep templates in code so they're version-controlled and testable without API calls.

### Environment variables required

```
SENDGRID_API_KEY=
SENDGRID_FROM_EMAIL=   # verified sender address
SENDGRID_FROM_NAME=    # e.g. "AI Scheduler"
```

---

## 4. Delivery Status Webhook (SendGrid)

### Route: `POST /webhooks/sendgrid/events`

- **Auth:** SendGrid signed webhook verification (HMAC-SHA256 with `SENDGRID_WEBHOOK_KEY`)
- **Body:** array of event objects `[{ message_id, event, email, timestamp }]`
- **Behavior:** For each event, find `notification_log` by `provider_id = message_id`, update `status` to `delivered` or `failed`, set `error_message` if applicable
- Returns 200 always

---

## 5. Notification API (Admin/Staff visibility)

### `GET /api/v1/notifications`

- **Auth:** `requireAuth` (any role)
- **Query params:** `clientId?`, `channel?`, `status?`, `limit` (default 50, max 200), `before` (cursor)
- **Response:** paginated list of `notification_log` rows, newest first
- **Scope:** scoped to `business_id` from JWT — staff never see other businesses

---

## Integration Points

| System | Change |
|---|---|
| F002 invite flow | Replace `emailService` stub call with real `sendEmail({ templateKey: 'staff_invite' })` |
| F003 outreach trigger | Replace placeholder send with `sendSMS()` |
| F003 confirmation side effect | Add `sendEmail({ templateKey: 'booking_confirmed_client' })` |
| F003 reminder job | Add `sendSMS()` + `sendEmail({ templateKey: 'booking_reminder_client' })` |
| F003 waitlist re-engagement | Add `sendSMS()` |

---

## Phases (proposed)

| Phase | Scope |
|---|---|
| 1 | DB migration + notification_log model + smsService + emailService (replace stub) |
| 2 | Twilio inbound webhook → F003 pipeline |
| 3 | SendGrid delivery webhook + notification API endpoint |
| 4 | Wire F002 + F003 integration points + retry job |

---

## Open Questions

1. Do we need per-business Twilio numbers, or one shared number for now?
2. Should `notification_log` be pruned after N days to control table size?
3. Staff notification emails — send to all staff or only the assigned staff member?
