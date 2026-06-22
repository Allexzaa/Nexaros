# F011 — Payments & Deposits

**Status:** Spec Ready  
**Date:** 2026-05-06  
**Author:** Claude  

---

## Goal

Collect deposits or full payment from clients at booking time via Stripe, enforce cancellation fees, and give staff visibility into payment status per appointment. This protects the business from no-shows and unpaid sessions.

---

## Scope

| Area | What |
|---|---|
| Stripe integration | Payment intents, card capture, refunds |
| Deposit at booking | Require deposit before appointment is confirmed |
| Full payment at booking | Optional: collect full service price upfront |
| Cancellation fee | Charge card on file if cancelled inside the window |
| Payment status | Per-appointment payment record visible to staff |
| Refunds | Admin-initiated full or partial refund |

Out of scope: recurring subscriptions (F012), in-person POS / card reader, split payments, invoicing, multiple currencies per business.

---

## Existing Foundation

- F009: client booking portal — payment step inserts here (step 4, between confirm and confirmation screen)
- F010: `schedule.price_cents` — service pricing already stored
- `appointment` table exists (F004)
- `client` table exists — add Stripe customer ID

---

## Data Model

### New columns on `client`

```sql
ALTER TABLE client
  ADD COLUMN stripe_customer_id TEXT;  -- Stripe Customer object ID
```

### New columns on `schedule`

```sql
ALTER TABLE schedule
  ADD COLUMN deposit_cents        INTEGER NOT NULL DEFAULT 0,   -- 0 = no deposit required
  ADD COLUMN deposit_policy       TEXT NOT NULL DEFAULT 'none'
                                    CHECK (deposit_policy IN ('none', 'deposit', 'full')),
  ADD COLUMN cancellation_fee_cents INTEGER NOT NULL DEFAULT 0; -- charged if cancelled inside window
```

Set via existing `PATCH /api/v1/schedules/:id`.

### New table: `payment`

```sql
CREATE TABLE payment (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           UUID NOT NULL REFERENCES business(id),
  appointment_id        UUID NOT NULL REFERENCES appointment(id),
  client_id             UUID NOT NULL REFERENCES client(id),
  stripe_payment_intent_id TEXT,
  stripe_charge_id      TEXT,
  type                  TEXT NOT NULL CHECK (type IN ('deposit', 'full', 'cancellation_fee')),
  amount_cents          INTEGER NOT NULL,
  currency              TEXT NOT NULL DEFAULT 'usd',
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','requires_payment_method','requires_confirmation','succeeded','failed','refunded','partially_refunded','cancelled')),
  refunded_cents        INTEGER NOT NULL DEFAULT 0,
  metadata              JSONB NOT NULL DEFAULT '{}',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON payment (appointment_id);
CREATE INDEX ON payment (client_id);
CREATE INDEX ON payment (business_id, created_at DESC);
```

### New columns on `business.settings` (JSONB)

```json
{
  "stripe_account_id": null,
  "currency": "usd"
}
```

---

## 1. Stripe Connect (per-business)

Each business has its own Stripe account via Stripe Connect (Express or Standard). The platform collects a fee per transaction.

### Route: `GET /api/v1/business/stripe/connect`
- **Auth:** `requireAuth`, `requireRole('admin')`
- Initiates Stripe Connect OAuth flow
- Stores `stripe_account_id` in `business.settings` after callback

### Route: `GET /api/v1/business/stripe/disconnect`
- **Auth:** `requireAuth`, `requireRole('admin')`
- Clears `stripe_account_id`; warns if there are pending payments

### Route: `GET /api/v1/business/stripe/status`
- **Auth:** `requireAuth`, `requireRole('admin')`
- Returns `{ connected: bool, chargesEnabled: bool, payoutsEnabled: bool }`

---

## 2. Payment Intent — Booking Flow

### Route: `POST /api/v1/payments/create-intent`

- **Auth:** Client session
- **Body:** `{ appointmentId: string }`
- **Behavior:**
  1. Load appointment + schedule; verify appointment belongs to this client
  2. Determine amount: `deposit_policy = 'deposit'` → `deposit_cents`; `'full'` → `price_cents`
  3. Look up or create Stripe Customer for client
  4. Create `PaymentIntent` via Stripe API (amount, currency, customer, `capture_method: 'automatic'`)
  5. Insert `payment` row with `status: 'pending'`
  6. Return `{ clientSecret, publishableKey }`

### Client-web (F009) integration

After step 3 (Time Slot Selection), if `deposit_policy !== 'none'`:
- Show Stripe Elements card input
- On submit: `stripe.confirmCardPayment(clientSecret)`
- On success: complete booking (`POST /api/v1/appointments`)
- On failure: show error, do not create appointment

If `deposit_policy = 'none'`: skip payment step entirely, book directly.

---

## 3. Stripe Webhook

### Route: `POST /webhooks/stripe/events`

- **Auth:** Stripe signature validation (`stripe.webhooks.constructEvent`)
- **Events handled:**

| Event | Action |
|---|---|
| `payment_intent.succeeded` | Update `payment.status = 'succeeded'`; confirm appointment if `pending` |
| `payment_intent.payment_failed` | Update `payment.status = 'failed'`; optionally cancel appointment |
| `charge.refunded` | Update `payment.status = 'refunded'` or `'partially_refunded'`; set `refunded_cents` |

---

## 4. Cancellation Fee

### Service: `src/services/paymentService.ts`

```ts
chargeCancellationFee(appointmentId: string): Promise<void>
```

- Called when appointment cancelled inside `client_cancel_window_hours`
- Load original payment → retrieve Stripe Customer's default payment method
- Create new `PaymentIntent` for `cancellation_fee_cents` + confirm immediately
- Insert new `payment` row with `type: 'cancellation_fee'`
- If no card on file: log and skip (cannot force charge without saved method)

### Integration point

In the appointment cancel handler: if `cancellation_fee_cents > 0` and `appointment.scheduled_at - now < client_cancel_window_hours`, call `chargeCancellationFee`.

---

## 5. Refunds

### Route: `POST /api/v1/payments/:id/refund`

- **Auth:** `requireAuth`, `requireRole('admin')`
- **Body:** `{ amountCents?: number }` — omit for full refund
- **Behavior:**
  1. Load `payment` — must be `succeeded`
  2. Call `stripe.refunds.create({ charge: stripe_charge_id, amount })`
  3. Update `payment.refunded_cents`, set status to `refunded` or `partially_refunded`
- **Response:** `{ ok: true, refundedCents }`

---

## 6. Payment Visibility (Staff)

### Extend `GET /api/v1/appointments/:id` response

```json
{
  "payment": {
    "status": "succeeded",
    "amountCents": 2500,
    "type": "deposit",
    "refundedCents": 0,
    "canRefund": true
  }
}
```

### Staff Dashboard (F007)

Add a "Payment" section to the appointment detail drawer:
- Status badge, amount, refund button (admin only)

---

## Environment Variables Required

```
STRIPE_SECRET_KEY=
STRIPE_PUBLISHABLE_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PLATFORM_FEE_PERCENT=   # e.g. 2.5 for 2.5% platform fee
```

---

## Phases (proposed)

| Phase | Scope |
|---|---|
| 1 | DB migrations + Stripe Connect routes + paymentService scaffold |
| 2 | Payment intent creation + Stripe Elements in client-web booking flow |
| 3 | Stripe webhook handler + appointment confirmation on payment success |
| 4 | Cancellation fee charging + refund route + payment visibility in staff dashboard |

---

## Open Questions

1. Stripe Connect Express vs. Standard? Express is easier to onboard but limits customization.
2. Should the platform take a percentage fee per transaction, or is this internal tooling only?
3. What happens if Stripe payment succeeds but the appointment creation fails? Need a compensation strategy (immediate refund vs. manual review queue).
4. Should clients be able to save a card for future bookings, or card-per-booking only?
