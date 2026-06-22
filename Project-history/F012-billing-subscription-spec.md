# F012 — Billing & Subscription

**Status:** Spec Ready  
**Date:** 2026-05-06  
**Author:** Claude  

---

## Goal

Charge the businesses that use this platform a recurring subscription fee. This turns the app into a SaaS product with a revenue model, plan-based feature limits, and a self-serve billing portal.

---

## Scope

| Area | What |
|---|---|
| Subscription plans | Free trial, Starter, Pro — with defined limits |
| Stripe Billing | Recurring subscription via Stripe Subscriptions |
| Plan enforcement | Block or degrade features when over plan limits |
| Self-serve portal | Admins can upgrade, downgrade, and manage billing |
| Trial | 14-day free trial on signup, no card required |
| Webhook handling | Sync subscription status from Stripe events |

Out of scope: annual billing discount (can add later), team seats pricing, per-appointment transaction fees (separate from F011), metered billing.

---

## Existing Foundation

- `business` table — one row per business (F001)
- `staff_user` table — staff count queryable
- Stripe already integrated for client payments (F011); platform already has Stripe credentials

---

## Plans

| Plan | Price | Staff seats | Appointments/month | AI conversations | Analytics |
|---|---|---|---|---|---|
| **Trial** | Free, 14 days | 3 | 50 | 50 | No |
| **Starter** | $49/mo | 5 | 200 | 500 | Basic |
| **Pro** | $149/mo | Unlimited | Unlimited | Unlimited | Full |

Plans are defined in code (`src/config/plans.ts`) — no database table needed. Plan IDs map to Stripe Price IDs.

---

## Data Model

### New columns on `business`

```sql
ALTER TABLE business
  ADD COLUMN stripe_customer_id     TEXT,
  ADD COLUMN stripe_subscription_id TEXT,
  ADD COLUMN plan                   TEXT NOT NULL DEFAULT 'trial'
                                      CHECK (plan IN ('trial', 'starter', 'pro', 'cancelled')),
  ADD COLUMN plan_expires_at        TIMESTAMPTZ,   -- null = no expiry (active paid plan)
  ADD COLUMN trial_ends_at          TIMESTAMPTZ;   -- set on business creation
```

Set `trial_ends_at = NOW() + INTERVAL '14 days'` on `INSERT INTO business`.

---

## 1. Plan Enforcement

### Middleware: `src/middleware/planGuard.ts`

```ts
planGuard(limit: keyof PlanLimits): RequestHandler
```

Called on routes that have plan-based limits. Reads `business.plan` and `business.plan_expires_at` / `business.trial_ends_at`, compares against plan config.

**Trial expired handling:** After `trial_ends_at` passes and no paid subscription, set `plan = 'cancelled'` (via Stripe webhook or a daily cron). Block all write operations — reads still allowed so admin can log in and upgrade.

### Enforced limits

| Resource | Check | Applied to |
|---|---|---|
| Staff seats | Count active `staff_user` rows | `POST /api/v1/staff/invite` |
| Monthly appointments | Count `appointment` rows in current month | `POST /api/v1/appointments` |
| AI conversations | Count `conversation` rows in current month | AI outreach trigger |

### Response when limit hit

```json
{ "error": "plan_limit_reached", "limit": "staff_seats", "current": 5, "max": 5, "upgradeUrl": "/billing" }
```

HTTP 402.

---

## 2. Subscription Routes

### `GET /api/v1/billing/status`

- **Auth:** `requireAuth`, `requireRole('admin')`
- **Response:**

```json
{
  "plan": "starter",
  "status": "active",
  "trialEndsAt": null,
  "currentPeriodEnd": "2026-06-06T00:00:00Z",
  "usage": {
    "staffSeats": { "current": 3, "max": 5 },
    "appointmentsThisMonth": { "current": 87, "max": 200 },
    "conversationsThisMonth": { "current": 112, "max": 500 }
  },
  "invoices": [
    { "date": "2026-05-06", "amountCents": 4900, "status": "paid", "pdfUrl": "..." }
  ]
}
```

### `POST /api/v1/billing/subscribe`

- **Auth:** `requireAuth`, `requireRole('admin')`
- **Body:** `{ planId: 'starter' | 'pro', paymentMethodId: string }`
- **Behavior:**
  1. Look up or create Stripe Customer for business
  2. Attach payment method to customer; set as default
  3. Create Stripe Subscription with the corresponding `stripe_price_id`
  4. Update `business.plan`, `business.stripe_subscription_id`
- **Response:** `{ subscriptionId, status }`

### `POST /api/v1/billing/change-plan`

- **Auth:** `requireAuth`, `requireRole('admin')`
- **Body:** `{ planId: 'starter' | 'pro' }`
- **Behavior:** Stripe `subscriptions.update({ items: [{ price: newPriceId }], proration_behavior: 'create_prorations' })`
- Updates `business.plan`

### `POST /api/v1/billing/cancel`

- **Auth:** `requireAuth`, `requireRole('admin')`
- **Behavior:** Stripe `subscriptions.update({ cancel_at_period_end: true })`
- **Response:** `{ cancelsAt: ISO date }`

### `GET /api/v1/billing/portal`

- **Auth:** `requireAuth`, `requireRole('admin')`
- Creates a Stripe Customer Portal session
- **Response:** `{ url: string }` — redirect client to this URL for self-serve billing management

---

## 3. Stripe Webhook (Billing Events)

### Route: `POST /webhooks/stripe/billing`

Separate from F011 webhook (different signing secret possible).

| Event | Action |
|---|---|
| `customer.subscription.created` | Set `plan`, `stripe_subscription_id`, clear trial |
| `customer.subscription.updated` | Update `plan` from price ID lookup |
| `customer.subscription.deleted` | Set `plan = 'cancelled'`, `plan_expires_at = period_end` |
| `invoice.payment_failed` | Email admin: payment failed, update to downgrade grace period (7 days) |
| `invoice.payment_succeeded` | Ensure plan is active; clear any grace period flag |

---

## 4. Billing UI (Staff Web)

### New page: `/billing`

- **Access:** Admin only
- Current plan card: plan name, renewal date, usage bars for all limits
- Upgrade/downgrade buttons with plan comparison table
- Invoice history table with PDF download links
- "Manage billing" button → Stripe Customer Portal redirect

### Trial banner

Shown on all pages when `plan = 'trial'` and `trial_ends_at - now < 7 days`:

> "Your free trial ends in X days. Upgrade to keep your data and avoid interruption."

---

## Environment Variables Required

```
STRIPE_STARTER_PRICE_ID=    # Stripe Price ID for Starter plan
STRIPE_PRO_PRICE_ID=        # Stripe Price ID for Pro plan
STRIPE_BILLING_WEBHOOK_SECRET=
```

---

## Phases (proposed)

| Phase | Scope |
|---|---|
| 1 | DB migration + `plans.ts` config + plan enforcement middleware |
| 2 | Subscribe / change-plan / cancel routes + Stripe Billing webhook |
| 3 | Billing status endpoint (with usage) + Customer Portal route |
| 4 | Billing UI page in staff-web + trial banner |

---

## Open Questions

1. Should trial require a credit card upfront (reduces churn but increases friction) or no card required?
2. What happens to existing businesses' data when they cancel — soft-delete after 30 days, or keep forever?
3. Annual billing at a discount (e.g. 2 months free) — defer to later or include now?
4. Should staff/viewer roles be able to see the billing status page (read-only), or admin-only strictly?
