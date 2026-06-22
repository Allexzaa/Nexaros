# F002 — Authentication & Authorization — Phases

**Linked spec:** [F002-auth-spec.md](F002-auth-spec.md)
**Depends on:** F001 all phases complete
**Total phases:** 4
**Purpose:** Implement both auth systems (staff + client) end-to-end — tokens, sessions, roles, Google SSO, staff invitation, password reset, and client session expiry. At the end of Phase 4 both apps can fully authenticate; all API endpoints are protected.

---

## Phase 1 — Staff Email/Password Auth + Token Infrastructure

**Goal:** Staff can log in with email and password. Access token issued; refresh token stored in httpOnly cookie. All F001 WebSocket upgrade tokens become real. Silent refresh working.

**Deliverables:**

**Backend:**
- `POST /api/v1/auth/login` — email + password → validate against `staff_user.password_hash` (bcrypt) → issue access JWT (5-min expiry) + refresh token (30-day, httpOnly cookie, `Secure`, `SameSite=Strict`). Refresh token stored as bcrypt hash in `staff_user.refresh_token_hash`.
- `POST /api/v1/auth/refresh` — reads httpOnly cookie → validates refresh token hash + expiry → issues new access token + rotates refresh token (old invalidated, new set). Returns 401 if token missing, expired, or hash mismatch.
- `POST /api/v1/auth/logout` — clears refresh token hash in DB + clears cookie.
- `GET /api/v1/auth/me` — returns current staff user from access token (used by staff web on mount to restore session).
- JWT middleware — validates `Authorization: Bearer <token>` on all protected routes; attaches `req.staff` with `{ id, businessId, role, canTriggerOutreach, canEditSchedule }`.
- Staff JWT payload matches `StaffTokenPayload` shape in `src/realtime/types.ts` (Phase 2 contract).
- Auth rate limiter already applied to auth endpoints (F001 Phase 1).

**Staff web app (`staff-web`):**
- Login page form wired to `POST /api/v1/auth/login`.
- On success: store access token in `AuthContext` memory; schedule silent refresh 10 seconds before expiry (4m50s timer).
- Silent refresh: `POST /api/v1/auth/refresh` with `credentials: 'include'` → update access token in memory → reschedule next refresh.
- On 401 from any API call: attempt one silent refresh, retry original call. If refresh also fails: logout + redirect to `/login`.
- `/dev-login` route disabled — replaced by real login.

**Dependencies:** F001 Phase 1 (DB, bcrypt, JWT_SECRET env var already set).

**Done when:** Staff can log in, navigate the app, token silently refreshes without interruption, and logout clears the session completely.

---

## Phase 2 — Staff Authorization Middleware

**Goal:** Every protected route enforces role and permission checks. The permission matrix from the spec is implemented as middleware and used across all existing stubs.

**Deliverables:**

**Backend:**
- `requireAuth` middleware — already implemented in Phase 1; ensures valid access token.
- `requireRole(...roles)` middleware — checks `req.staff.role` against allowed roles; returns 403 if not matched.
- `requirePermission(flag)` middleware — checks `req.staff[flag]` (canTriggerOutreach, canEditSchedule); returns 403 if false. Only applies to `staff` role — `admin` always passes.
- Applied to all existing route stubs and all future routes:

| Route | Middleware |
|---|---|
| `POST /api/v1/schedules/:id/outreach` | `requireAuth` + `requirePermission('canTriggerOutreach')` |
| `PATCH /api/v1/conversations/:id/takeover` | `requireAuth` + `requireRole('admin','staff')` |
| `POST /api/v1/staff` (invite) | `requireAuth` + `requireRole('admin')` |
| `GET /api/v1/conversations` | `requireAuth` |
| `PUT /api/v1/appointments/:id` | `requireAuth` + `requirePermission('canEditSchedule')` |
| `PATCH /api/v1/business/settings` | `requireAuth` + `requireRole('admin')` |
| `PATCH /api/v1/staff/:id/permissions` | `requireAuth` + `requireRole('admin')` |

- `PATCH /api/v1/staff/:id/permissions` endpoint — Admin updates `can_trigger_outreach` / `can_edit_schedule` on a staff member. Changes take effect on the next access token issue (within 5 minutes — no invalidation needed).

**Staff web app:**
- `ApproveBooking` page: approve/reject buttons already conditionally rendered based on `canEditSchedule` — now backed by real permission from token.
- Sidebar nav items (Settings, Staff) already Admin-only — confirmed working with real token role.
- API calls that hit a 403 show a "Permission denied" message rather than crashing.

**Dependencies:** Phase 1 (requireAuth middleware, req.staff).

**Done when:** Sending requests as Viewer returns 403 on restricted routes; Admin passes all checks; Staff with designated permission passes its specific check; all 403 responses use the standard error envelope.

---

## Phase 3 — Google SSO + Staff Invitation + Password Reset

**Goal:** Staff can sign in with Google. Admins can invite new staff. Staff can reset their password.

**Deliverables:**

**Backend:**
- `GET /api/v1/auth/google` — redirects to Google OAuth 2.0 consent screen. Required scopes: `openid email profile`.
- `GET /api/v1/auth/google/callback` — Google redirects here with auth code → exchange for ID token → extract `email` and `sub` (Google user ID):
  - If `staff_user` with matching `email` exists: set `google_id = sub` (link accounts); issue access + refresh tokens.
  - If no match: return 404 — Google SSO only works for existing accounts (Admin must invite first).
- `POST /api/v1/staff/invite` — Admin only. Creates a pending `staff_user` row (no password, role assigned, `invite_token_hash` stored, expires 48hr). Sends invite email via SendGrid with a one-time link: `https://staff.app.[domain]/accept-invite?token=<token>`.
- `POST /api/v1/auth/accept-invite` — validates invite token → prompts staff to set password or link Google → creates full account → issues session.
- `POST /api/v1/auth/forgot-password` — rate-limited. Finds staff by email → generates reset token (1hr expiry, stored as hash) → sends reset email via SendGrid.
- `POST /api/v1/auth/reset-password` — validates reset token → updates `password_hash` → sets `refresh_token_hash = null` on all sessions for that user (force re-login) → returns 200.

**Staff web app:**
- Login page "Sign in with Google" button — redirects to `GET /api/v1/auth/google`.
- "Forgot password?" link → `/forgot-password` page → email form → success message.
- `/reset-password?token=<token>` page → new password form → redirects to `/login` on success.
- `/accept-invite?token=<token>` page → set password (or link Google) form → redirects to `/` on success.
- Staff Management page (`/staff`) — list staff, invite form (email + role), assign/revoke designatable permissions per staff member.

**Dependencies:** Phase 1 (token infrastructure), Phase 2 (requireRole middleware for invite endpoint). Requires `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `SENDGRID_API_KEY` set in env.

**Done when:** Staff can sign in via Google, Admin can invite a new staff member who receives an email and sets up their account, and password reset invalidates all existing sessions.

---

## Phase 4 — Client Auth (Short Code Redemption + Session Expiry)

**Goal:** Clients can redeem a short code and receive a long-lived JWT. Admin can expire a client session and trigger re-registration. Client JWT is validated on every request with session version check.

**Deliverables:**

**Backend:**
- `POST /api/v1/auth/redeem` — validates short code (exists, `used_at` null, `expires_at` not passed). Rate-limited: 5 attempts per code, 15-minute lockout on 5th failure. Returns specific error codes: `INVITE_EXPIRED`, `INVITE_USED`, `INVITE_INVALID`, `RATE_LIMIT_EXCEEDED`. On success: sets `ClientInvite.used_at`, sets `Client.app_registered = true`, issues long-lived JWT (no expiry) with `session_version` claim.
- Client JWT middleware — validates token on all `/api/v1/client/*` routes; checks `session_version` in token against `Client.session_version` in DB. Mismatch → 401 `SESSION_EXPIRED`.
- `POST /api/v1/client/device-tokens` — upsert FCM device token by `(client_id, platform)`.
- `DELETE /api/v1/client/device-tokens/:platform` — delete token on logout.
- `POST /api/v1/admin/clients/:id/expire-session` — Admin only. Increments `Client.session_version`. Invalidates all existing JWTs for that client instantly. Creates a new `ClientInvite` (new short code, 48hr expiry, any old active invites marked used). Sends new invite email via SendGrid.
- `POST /api/v1/client/messages` — (stub) validates client JWT; accepts outgoing message from client app; stores in DB.
- `GET /api/v1/client/messages` — (stub) returns paginated message history (`?cursor=&limit=50`) for the authenticated client across all their conversations.

**Client mobile app:**
- Short Code Entry screen already handles all error states (`INVITE_EXPIRED`, `INVITE_USED`, `INVITE_INVALID`, rate limit) — now backed by real endpoint.
- On successful redemption: JWT stored in secure memory (`AuthContext`), device token registered via `POST /api/v1/client/device-tokens`.
- On `SESSION_EXPIRED` 401: logout + navigate back to ShortCodeEntry with message "Your session has expired. Please check your email for a new invite."
- On logout: `DELETE /api/v1/client/device-tokens/:platform` called before clearing token.

**Dependencies:** Phase 1 (JWT infrastructure), Phase 3 (SendGrid for new invite email on session expiry). Migration: add `session_version integer NOT NULL DEFAULT 1` to `client` table.

**Done when:** Client can redeem a short code and stay logged in indefinitely; Admin expiring the session instantly invalidates the JWT on next request; device tokens are registered and cleaned up correctly.

---

## Phase Summary

| Phase | Name | Key Output | Depends On |
|---|---|---|---|
| 1 | Staff Email/Password + Token Infrastructure | Staff can log in; silent refresh; logout | F001 complete |
| 2 | Staff Authorization Middleware | Role + permission enforcement on all routes | Phase 1 |
| 3 | Google SSO + Invitation + Password Reset | Google login; staff invite flow; password reset | Phases 1–2 |
| 4 | Client Auth + Session Expiry | Short code redemption; indefinite session; admin expiry | Phases 1–3 |

Phases must run in order — each builds on the previous. Phase 4 can start in parallel with Phase 3 on the client side (mobile app wiring) since the endpoint contracts are defined.
