# Build Plan — AI Scheduler

Master feature index. One entry per feature. All detail lives in `Project-history/` — follow the links.

**Feature status:** `Planned` | `Spec Ready` | `Approved` | `In Progress` | `Done` | `On Hold`
**Phase status:** `Pending` | `Active` | `Done`

---

<!--
  Claude: append new entries at the bottom in the format below.
  Never remove or reorder entries.
  Update Status and Progress lines as work advances.
  Add the Phases link only after the phases file is created.
-->

## F001 — Core System Architecture
**Status:** Done
**Summary:** Defines the full system structure, components, data flow, and technology choices that all future features are built on.
**Spec:** [F001-core-architecture-spec.md](Project-history/F001-core-architecture-spec.md)
**Phases:** [F001-core-architecture-phases.md](Project-history/F001-core-architecture-phases.md)
**Progress:** All 6 phases complete

---

## F002 — Authentication & Authorization
**Status:** Done
**Summary:** Defines staff login (email/password + Google SSO), three-tier role model with designatable permissions, and client session lifecycle (indefinite until Admin-expired).
**Spec:** [F002-auth-spec.md](Project-history/F002-auth-spec.md)
**Phases:** [F002-auth-phases.md](Project-history/F002-auth-phases.md)
**Progress:** All 4 phases complete

---

## F003 — AI Engine: Conversation State Machine
**Status:** Done
**Summary:** Defines every conversation state, event, transition, LLM intent detection protocol, escalation rules, edge cases, and data model additions for the AI scheduling engine.
**Spec:** [F003-ai-conversation-state-machine-spec.md](Project-history/F003-ai-conversation-state-machine-spec.md)
**Phases:** [F003-ai-conversation-state-machine-phases.md](Project-history/F003-ai-conversation-state-machine-phases.md)
**Progress:** All 6 phases complete — 159 tests total

---

## F004 — Business Operations: Settings, Staff, Clients & Schedules
**Status:** Done
**Summary:** Full CRUD layer for admins and staff to configure the business, manage accounts, manage client records, and build appointment schedules — the operational backbone the AI engine acts on.
**Spec:** [F004-business-operations-spec.md](Project-history/F004-business-operations-spec.md)
**Phases:** [F004-business-operations-phases.md](Project-history/F004-business-operations-phases.md)
**Progress:** All 3 phases complete — 212 tests total

---

## F005 — Notifications & Delivery Gateway
**Status:** Spec Ready
**Summary:** Replaces all stub/console-log delivery paths with real SMS (Twilio) and email (SendGrid) channels, adds the inbound SMS webhook so clients can reply, and wires delivery tracking — making the AI engine actually reachable by clients.
**Spec:** [F005-notifications-delivery-gateway-spec.md](Project-history/F005-notifications-delivery-gateway-spec.md)
**Phases:** —
**Progress:** —

---

## F006 — Calendar Integration
**Status:** Spec Ready
**Summary:** Reads busy blocks from Google Calendar (and iCal feeds) to prevent double-booking, and writes confirmed appointments back as calendar events — so staff don't need to maintain two systems.
**Spec:** [F006-calendar-integration-spec.md](Project-history/F006-calendar-integration-spec.md)
**Phases:** —
**Progress:** —

---

## F007 — Staff Dashboard: Conversations & Appointments UI
**Status:** In Progress
**Summary:** Builds the staff-facing web interface for live conversation management (take-over, approve bookings), a day/week appointment calendar, and a waitlist panel — turning the backend into a product a human operator can use today.
**Spec:** [F007-staff-dashboard-spec.md](Project-history/F007-staff-dashboard-spec.md)
**Phases:** —
**Progress:** Dashboard, ConversationView, Clients, ClientDetail, ScheduleBuilder, ScheduleDetail, ApproveBooking, Settings, StaffManagement all built.

---

## F007a — Schedule Detail: Timeline View
**Status:** Done
**Summary:** Replaces the flat appointment table on the Schedule Detail page with a vertical day-timeline — slots as colored blocks at their correct time position, click-to-select detail panel, click-to-add on empty areas, and side-by-side overlap handling.
**Spec:** [F007a-schedule-timeline-view-spec.md](Project-history/F007a-schedule-timeline-view-spec.md)
**Phases:** 3 phases (grid → selection+panel → full actions)
**Progress:** All 3 phases complete

---

## F007b — Schedule Calendar: Month/Week/Day Navigation + Batch Slot Creator
**Status:** Done
**Summary:** Replaces the flat schedule list with a month/week/day calendar and adds a batch slot creator modal so staff can build a full week of availability in one action.
**Spec:** [F007b-calendar-navigation-spec.md](Project-history/F007b-calendar-navigation-spec.md)
**Phases:** 4 phases (backend → month → week → batch creator)
**Progress:** All 4 phases complete

---

## F008 — Automated Reminders
**Status:** Spec Ready
**Summary:** Schedules and sends configurable SMS/email reminders to clients before their appointments to reduce no-shows, with automatic cancellation when appointments change.
**Spec:** [F008-automated-reminders-spec.md](Project-history/F008-automated-reminders-spec.md)
**Phases:** —
**Progress:** —

---

## F009 — Client Booking Portal
**Status:** Done
**Summary:** A client-facing web app where clients can browse services, self-book a slot, manage upcoming appointments, and join the waitlist — the primary booking surface the AI conversation leads clients to.
**Spec:** [F009-client-booking-portal-spec.md](Project-history/F009-client-booking-portal-spec.md)
**Phases:** [F009-client-booking-portal-phases.md](Project-history/F009-client-booking-portal-phases.md)
**Progress:** All 4 phases complete — apps/client-web live on port 3002

---

## F010 — Reporting & Analytics
**Status:** Spec Ready
**Summary:** Admin dashboard with booking funnel, no-show rates, AI performance, revenue summary, and staff utilization — giving the business owner full visibility into how the system is performing.
**Spec:** [F010-reporting-analytics-spec.md](Project-history/F010-reporting-analytics-spec.md)
**Phases:** —
**Progress:** —

---

## F011 — Payments & Deposits
**Status:** Spec Ready
**Summary:** Stripe integration to collect deposits or full payment at booking time, enforce cancellation fees, and allow admin-initiated refunds — protecting the business from no-shows and unpaid sessions.
**Spec:** [F011-payments-deposits-spec.md](Project-history/F011-payments-deposits-spec.md)
**Phases:** —
**Progress:** —

---

## F012 — Billing & Subscription
**Status:** Spec Ready
**Summary:** SaaS billing layer with Free Trial, Starter, and Pro plans via Stripe Subscriptions, plan-based feature limits, and a self-serve billing portal for business admins.
**Spec:** [F012-billing-subscription-spec.md](Project-history/F012-billing-subscription-spec.md)
**Phases:** —
**Progress:** —

---

## F013 — Post-Appointment Follow-Up
**Status:** Spec Ready
**Summary:** Automatically messages clients after their appointment to collect a 1–5 rating, redirects happy clients to leave a Google/Yelp review, and escalates low scores to staff for service recovery.
**Spec:** [F013-post-appointment-followup-spec.md](Project-history/F013-post-appointment-followup-spec.md)
**Phases:** —
**Progress:** —

---

## F014 — Outreach Campaigns
**Status:** Spec Ready
**Summary:** Lets admins build targeted re-engagement campaigns (audience filter + message template + schedule) that kick off AI conversations at scale to drive repeat bookings from dormant clients.
**Spec:** [F014-outreach-campaigns-spec.md](Project-history/F014-outreach-campaigns-spec.md)
**Phases:** —
**Progress:** —

---

## F015 — Multi-Location Support
**Status:** Spec Ready
**Summary:** Adds an Organization layer above each Business so a single admin can manage multiple physical locations — each with its own staff, schedules, and phone number — under one billing account.
**Spec:** [F015-multi-location-spec.md](Project-history/F015-multi-location-spec.md)
**Phases:** —
**Progress:** —

---

## F016 — Conversational AI Engine

**Status:** Done
**Summary:** Replaces the rigid intent-classifier architecture with a tool-calling conversational AI — the LLM holds natural conversations, calls scheduling tools when it needs to act, and keeps the state machine only as a safety guard.
**Spec:** [F016-conversational-ai-spec.md](Project-history/F016-conversational-ai-spec.md)
**Phases:** —
**Progress:** All 4 phases complete — 212 tests passing

---

<!--
ENTRY TEMPLATE:

## F[NNN] — [Feature Name]
**Status:** Planned
**Summary:** [One sentence — what it does and why it matters.]
**Spec:** [F[NNN]-[slug]-spec.md](Project-history/F[NNN]-[slug]-spec.md)
**Phases:** —
**Progress:** —

When phases are created and work begins, update to:

## F[NNN] — [Feature Name]
**Status:** In Progress — Phase [X] of [N]
**Summary:** [unchanged]
**Spec:** [F[NNN]-[slug]-spec.md](Project-history/F[NNN]-[slug]-spec.md)
**Phases:** [F[NNN]-[slug]-phases.md](Project-history/F[NNN]-[slug]-phases.md)
**Progress:** Phase 1 done · Phase 2 active · Phase 3–4 pending
-->
