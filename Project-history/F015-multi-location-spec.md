# F015 — Multi-Location Support

**Status:** Spec Ready  
**Date:** 2026-05-06  
**Author:** Claude  

---

## Goal

Let a business owner manage multiple physical locations (branches) from one account — each with its own staff, schedules, and phone number — while sharing billing, admin access, and reporting at the organization level.

---

## Scope

| Area | What |
|---|---|
| Organization model | New `organization` entity above `business` |
| Location management | Each `business` row becomes a location; admin manages all |
| Cross-location admin | Super-admin role sees all locations; location-admin sees one |
| Staff assignment | Staff belong to one location (or can be shared) |
| Unified billing | One subscription per organization, not per location |
| Cross-location reporting | Roll-up analytics across all locations |

Out of scope: inter-location appointment transfers, shared client records across locations (clients are per-location today), franchise/reseller model, custom domains per location.

---

## Architecture Decision

**Approach: Add `organization` table above `business`**

- Current `business` table rows become "locations" within an organization
- All existing `business_id` foreign keys remain unchanged — zero data migration of operational tables
- `organization` owns the subscription (F012) and super-admin accounts
- Single-location businesses: organization has one location (transparent, no UI change)

---

## Data Model

### New table: `organization`

```sql
CREATE TABLE organization (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  plan             TEXT NOT NULL DEFAULT 'trial'
                     CHECK (plan IN ('trial', 'starter', 'pro', 'cancelled')),
  trial_ends_at    TIMESTAMPTZ,
  plan_expires_at  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Changes to `business`

```sql
ALTER TABLE business
  ADD COLUMN organization_id UUID REFERENCES organization(id),
  ADD COLUMN location_name   TEXT,      -- e.g. "Downtown", "Westside"
  ADD COLUMN timezone        TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  ADD COLUMN address         TEXT,
  ADD COLUMN is_active       BOOLEAN NOT NULL DEFAULT true;
```

Migrate: create one `organization` row per existing `business`; set `business.organization_id`.

### Changes to `staff_user`

```sql
ALTER TABLE staff_user
  ADD COLUMN organization_id UUID REFERENCES organization(id),
  ADD COLUMN is_org_admin    BOOLEAN NOT NULL DEFAULT false;
```

`is_org_admin = true` → can manage all locations in the organization.

---

## 1. Organization Admin Role

### New role: `org_admin`

- Sits above `admin` — can switch between locations, create locations, manage billing
- Stored as `staff_user.is_org_admin = true`
- JWT claims: `{ role: 'admin', orgId: '...', businessId: '...', isOrgAdmin: true }`

### Location switcher (Staff Web)

- Dropdown in nav showing all active locations in the org
- Selecting a location sets a `location_id` cookie; all subsequent API calls scoped to that location
- Org admin sees "All Locations" option for roll-up views

---

## 2. Location Management Routes

### `GET /api/v1/org/locations`

- **Auth:** `requireAuth`, `isOrgAdmin`
- **Response:** list of all `business` rows for this organization with staff count, appointment count (this month), active status

### `POST /api/v1/org/locations`

- **Auth:** `requireAuth`, `isOrgAdmin`
- **Body:** `{ locationName, timezone, address, phone }`
- **Behavior:** Insert new `business` row with same `organization_id`; provision Twilio number (or prompt admin to assign one)
- **Response:** `{ businessId, slug }`

### `PATCH /api/v1/org/locations/:businessId`

- **Auth:** `requireAuth`, `isOrgAdmin`
- **Body:** `{ locationName?, timezone?, address?, isActive? }`
- Deactivating a location (`isActive: false`): blocks new bookings, existing appointments unaffected

---

## 3. Billing — Organization Level

### F012 changes

Move `stripe_customer_id`, `stripe_subscription_id`, `plan`, `trial_ends_at` from `business` to `organization`.

Plan limits apply at the **organization level** (aggregate across all locations):

| Limit | Scope |
|---|---|
| Staff seats | Total active staff across all locations |
| Appointments/month | Total across all locations |
| AI conversations/month | Total across all locations |
| Locations | New plan limit: Starter = 2, Pro = unlimited |

Plan enforcement middleware reads `organization.plan` instead of `business.plan`.

---

## 4. Cross-Location Reporting (F010 extension)

### Extend all report endpoints

Add `locationId?` query param:
- `locationId` provided: scoped to that location (existing behavior)
- `locationId` omitted + `isOrgAdmin`: roll-up across all locations

### Roll-up response example (`GET /api/v1/reports/appointments?groupBy=location`)

```json
{
  "locations": [
    { "businessId": "...", "locationName": "Downtown", "confirmed": 87, "completed": 79 },
    { "businessId": "...", "locationName": "Westside",  "confirmed": 43, "completed": 38 }
  ],
  "totals": { "confirmed": 130, "completed": 117 }
}
```

---

## 5. Staff Sharing Across Locations (Optional)

Staff can be assigned to multiple locations by having multiple `staff_user` rows (one per location) sharing the same `user_email` and linked via a new `user_identity_id`:

```sql
ALTER TABLE staff_user
  ADD COLUMN user_identity_id UUID;  -- shared across locations for same person
```

This allows a staff member to log in once and switch locations via the location switcher. Deferred implementation — add column now, wire logic later.

---

## 6. Migration Plan

Since multi-location is additive:

1. Create `organization` table
2. For each existing `business`, create a corresponding `organization` row; set `business.organization_id`
3. For each `staff_user`, set `organization_id` from their `business.organization_id`
4. Designate the first `admin` role staff member in each org as `is_org_admin = true`
5. Move billing columns from `business` to `organization` (F012 dependency)

Single-location businesses see no UI change — the location switcher only appears when `org.locations.count > 1`.

---

## Phases (proposed)

| Phase | Scope |
|---|---|
| 1 | DB migrations (organization table + business/staff_user columns) + data backfill |
| 2 | org_admin role + JWT claim extension + location management routes |
| 3 | Location switcher in staff-web + billing moved to org level (F012 update) |
| 4 | Cross-location roll-up reporting (F010 extension) + staff sharing via user_identity_id |

---

## Open Questions

1. Should `org_admin` be a separate login, or a promotion of an existing `admin` staff account?
2. Starter plan: 2 locations max — should adding a 3rd location hard-block or prompt upgrade?
3. Should clients be shared across locations (one client record per org) or remain per-location? Sharing is better for the client experience but requires a client data model change.
4. Custom phone number per location — does the business want to bring their own Twilio number, or does the platform provision one per location?
