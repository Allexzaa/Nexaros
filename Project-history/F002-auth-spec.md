# F002 — Authentication & Authorization

**Created:** 2026-05-05
**Status:** Approved
**Depends on:** [F001 — Core System Architecture](F001-core-architecture-spec.md)
**Referenced by:** [F003 — AI Engine: Conversation State Machine](F003-ai-conversation-state-machine-spec.md)
**Review:** Decisions captured in [F001-core-architecture-review.md](F001-core-architecture-review.md) — item C4

---

## Overview

Two distinct auth systems run in parallel: one for staff (web app) and one for clients (mobile app). They share the same backend but have entirely different flows, token lifetimes, and permission models.

---

## Staff Authentication

### Login Methods

Staff can sign in via either:
- **Email + password** — standard credential login
- **Google SSO** — OAuth 2.0 via Google; staff account linked by email address

A single staff account can use both methods (e.g. email/password as fallback if Google session lapses). Linking is done by email match on first Google SSO login.

### Session Model

| Token | Lifetime | Purpose |
| --- | --- | --- |
| Access token (JWT) | 5 minutes | Authorizes API requests |
| Refresh token | 30 days | Issues new access tokens silently |

- Access token is short-lived — 5-minute expiry is the security boundary
- Refresh token is stored in an httpOnly cookie; rotated on every use
- Silent refresh: client automatically exchanges refresh token for a new access token in the background — staff never sees a login prompt during an active session
- On refresh token expiry (30 days of inactivity): staff must log in again

### First Admin Bootstrap

- When a Business is first created (see G3 — business onboarding, deferred to future spec), the first staff account is automatically assigned the Admin role
- All subsequent staff are invited by the Admin

### Staff Invitation Flow

1. Admin enters staff member's email in the dashboard
2. System sends an invite email with a one-time link (expires 48 hours)
3. Staff member clicks link → prompted to set a password or sign in with Google
4. Account created with the role Admin assigned

### Password Reset

1. Staff clicks "Forgot password" on login screen
2. System sends a reset link to their email (expires 1 hour)
3. Staff sets new password → all existing refresh tokens invalidated → re-login required

---

## Staff Authorization

### Roles

Three roles. Every staff account has exactly one role.

**Admin**
Full access. The only role that can manage other staff, configure business settings, and assign designatable permissions.

**Staff**
Operational access. Can do day-to-day work. Two actions are off by default but can be enabled per-person by Admin.

**Viewer**
Read-only. Can watch all conversations but cannot take any action. Intended for observers (owners who want visibility without acting, trainees, etc.).

### Permission Matrix

| Action | Admin | Staff | Staff (designated) | Viewer |
| --- | --- | --- | --- | --- |
| Trigger outreach | ✓ | ✗ | ✓ | ✗ |
| Take over conversation | ✓ | ✓ | ✓ | ✗ |
| Invite / manage staff | ✓ | ✗ | ✗ | ✗ |
| View all conversations | ✓ | ✓ | ✓ | ✓ |
| Edit schedule / appointments | ✓ | ✗ | ✓ | ✗ |
| Business settings | ✓ | ✗ | ✗ | ✗ |
| Assign designatable permissions | ✓ | ✗ | ✗ | ✗ |

### Designatable Permissions

Admin can toggle these flags on or off per Staff member at any time. Changes take effect on the next access token issue (within 5 minutes).

| Flag | Default | Effect |
| --- | --- | --- |
| `can_trigger_outreach` | false | Staff member can trigger outreach for a schedule |
| `can_edit_schedule` | false | Staff member can create, edit, and delete appointments |

Viewer role ignores these flags — no permissions can be designated to a Viewer.

---

## Client Authentication

### Short Code Redemption — Initial Registration

1. Client receives an email with a link containing a short code (via First Contact Bootstrap — see [F001](F001-core-architecture-spec.md); V1 is email only via SendGrid)
2. Client opens link → deep-links into the app (or prompts download if not installed)
3. App presents the short code pre-filled (or client enters manually)
4. Backend validates: short code exists, `used_at` is null, `expires_at` has not passed
5. On success:
   - `ClientInvite.used_at` set to now
   - `Client.app_registered` set to true
   - Long-lived JWT issued with no expiry date
   - Client lands in the app, session active

### Client Session Lifetime

- Client sessions are **indefinite** — the JWT does not expire on its own
- Session ends only when the Admin explicitly expires it
- No inactivity timeout; client stays logged in until the app is uninstalled or Admin acts

### Admin-Initiated Session Expiry

1. Admin expires a client from the staff dashboard
2. Backend increments `Client.session_version`
3. All existing client JWTs for that client become invalid (backend checks version on every request)
4. System automatically sends a new short code to the client via email (V1; same channel used for initial onboarding)
5. Client follows the re-registration flow below

### Client Re-Registration Flow

Identical to initial registration:
1. Client receives new short code link via SMS or email
2. Opens app → enters short code
3. New JWT issued → session restored
4. `ClientInvite` record created fresh (old one remains for audit)

---

## Data Model Changes

### StaffUser — additions

| Field | Type | Notes |
| --- | --- | --- |
| `password_hash` | string (nullable) | bcrypt hash; null if Google SSO only |
| `google_id` | string (nullable) | OAuth subject ID; null if email/password only |
| `role` | enum | `admin` / `staff` / `viewer` |
| `can_trigger_outreach` | boolean | default false; Admin-assignable for staff role only |
| `can_edit_schedule` | boolean | default false; Admin-assignable for staff role only |
| `refresh_token_hash` | string (nullable) | hashed refresh token; null after logout |
| `refresh_token_expires_at` | timestamp (nullable) | 30 days from last login |

### Client — additions

| Field | Type | Notes |
| --- | --- | --- |
| `session_version` | integer | starts at 1; incremented on Admin-initiated expiry |

---

## Token Model

### Staff JWT Claims

```
{
  "sub": "<staff_user_id>",
  "business_id": "<business_id>",
  "role": "admin | staff | viewer",
  "can_trigger_outreach": true | false,
  "can_edit_schedule": true | false,
  "exp": <unix timestamp, 5 minutes from issue>
}
```

### Client JWT Claims

```
{
  "sub": "<client_id>",
  "business_id": "<business_id>",
  "session_version": <integer>,
  "exp": null (no expiry)
}
```

On every client request: backend checks `session_version` in the token against `Client.session_version` in the database. Mismatch = 401, session expired.

---

## Auth Flows Summary

| Flow | Trigger | Output |
| --- | --- | --- |
| Staff email/password login | Staff submits credentials | Access token + refresh token cookie |
| Staff Google SSO login | Staff clicks Google button | Access token + refresh token cookie |
| Staff silent refresh | Access token expires | New access token (no user action) |
| Staff logout | Staff clicks logout | Refresh token deleted, cookie cleared |
| Staff password reset | Staff clicks "Forgot password" | New password set, all sessions invalidated |
| Staff invite | Admin sends invite | Invite email sent, pending account created |
| Client first registration | Short code redeemed | Long-lived JWT, app_registered = true |
| Client session expiry | Admin expires client | session_version incremented, new short code sent |
| Client re-registration | New short code redeemed | New JWT, session restored |

---

## Out of Scope (V1)

- SSO providers beyond Google (Microsoft, Okta, SAML)
- Two-factor authentication
- Audit logs for permission changes
- Active session / device management dashboard
- Client-initiated logout ("delete my account")
- Staff account deactivation flow (different from deletion)
