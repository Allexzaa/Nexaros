<p align="center">
  <img src="icon.png" alt="Nexaros" width="260" />
</p>

<p align="center">
  <img src="title.svg" alt="NEXAROS" />
</p>

An AI-powered scheduling platform for appointment-based businesses.

---

## What It Does

AI Scheduler lets businesses automate appointment scheduling through AI-driven SMS conversations. Staff build schedules, trigger outreach to clients, and the AI handles confirmation, rescheduling, waitlisting, and escalation — all without staff involvement on the happy path. Staff monitor conversations and take over at any time via a web dashboard. Clients can also self-book through a dedicated web portal.

---

## Quick Start

### Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| Node.js | 22+ | Backend + frontend |
| Docker | Any | PostgreSQL + Redis |
| Ollama | Any | Local LLM (optional for AI features) |

---

### Step 1 — Clone and install

```bash
git clone https://github.com/Allexzaa/Nexaros.git
cd Nexaros
npm install
```

This installs dependencies for all three workspaces: `backend`, `staff-web`, and `client-web`.

---

### Step 2 — Start PostgreSQL and Redis

**First time only** — create the containers:

```bash
docker run -d --name ai-scheduler-db \
  -e POSTGRES_USER=aischeduler \
  -e POSTGRES_PASSWORD=aischeduler \
  -e POSTGRES_DB=aischeduler \
  -p 5432:5432 \
  postgres:16-alpine

docker run -d --name ai-scheduler-redis \
  -p 6379:6379 \
  redis:7-alpine
```

**On subsequent runs** — just start the existing containers:

```bash
docker start ai-scheduler-db ai-scheduler-redis
```

---

### Step 3 — Configure environment

The backend ships with a working `.env` for local development. The only file you need is already at `backend/.env`. No changes required to run the app locally.

Key values in `backend/.env`:

```
DATABASE_URL=postgresql://aischeduler:aischeduler@localhost:5432/aischeduler
REDIS_URL=redis://localhost:6379
PORT=3001
NODE_ENV=development

# Local LLM (Ollama) — required for AI conversation features
LLM_BASE_URL=http://localhost:11434/v1
LLM_API_KEY=ollama
LLM_MODEL=llama3.1:8b

# Email / SMS — console-logged in dev, no real credentials needed
SENDGRID_API_KEY=SG.xxxx
```

---

### Step 4 — Run database migrations

```bash
npm run migrate
```

This applies all schema migrations to the local database.

---

### Step 5 — Seed the database

```bash
# Creates: Test Office business + admin@test.com account (password: changeme)
npm run seed

# Adds: 9 clients, 7 schedules, 8 conversations across all AI states
npm run test-data --workspace=backend
```

After seeding, the business slug will be something like `test-office-xxxxxx`. Run this to find it:

```bash
docker exec ai-scheduler-db psql -U aischeduler -d aischeduler -c "SELECT name, slug FROM business;"
```

---

### Step 6 — Start the servers

Open **three terminals**:

```bash
# Terminal 1 — Backend API (port 3001)
npm run dev

# Terminal 2 — Staff web app (port 3000)
cd staff-web && npm run dev -- --port 3000

# Terminal 3 — Client booking portal (port 3002)
cd client-web && npm run dev -- --port 3002
```

---

### Step 7 — Open the apps

| App | URL | Login |
|---|---|---|
| Staff Dashboard | `http://localhost:3000` | admin@test.com / changeme |
| Client Portal | `http://localhost:3002/<slug>` | Phone OTP (see terminal for code) |
| Job Queue (Bull Board) | `http://localhost:3001/admin/queues` | No auth |

---

### Optional — AI features (local LLM)

The AI conversation engine requires Ollama running locally. Without it, outreach jobs will fail but all other features work normally.

```bash
# Install Ollama: https://ollama.com
ollama pull llama3.1:8b
ollama serve          # starts on http://localhost:11434
```

Once Ollama is running, trigger outreach from the Schedules page and the AI will generate and process messages.

---

### Simulate a client reply (dev testing)

Since SMS is not wired up in dev, use the built-in simulate panel:

1. Open any conversation in the Staff Dashboard
2. Trigger outreach from the Schedules page (creates a conversation)
3. Open that conversation — the yellow **🧪 Simulate Client Reply** panel appears on the right
4. Click a quick-reply button or type a custom message

---

## Project Structure

```
Nexaros/
├── backend/          # Express API + AI engine + BullMQ jobs
│   ├── src/
│   │   ├── ai/           # LLM client, state machine, message processor, time parser
│   │   ├── auth/         # JWT + cookie middleware
│   │   ├── jobs/         # BullMQ processors (outreach, reminders, waitlist)
│   │   ├── routes/       # API routes (staff + portal)
│   │   └── services/     # slotManager, emailService, etc.
│   ├── migrations/   # node-pg-migrate files
│   └── scripts/      # seed.ts, testData.ts
│
├── staff-web/        # React + Vite staff dashboard (port 3000)
│   └── src/pages/    # Dashboard, Schedules, Conversations, Clients, Settings, Staff
│
├── client-web/       # Next.js 14 client booking portal (port 3002)
│   └── app/[slug]/   # Landing, login, book, appointments pages
│
├── Build_Plan.md     # Master feature index
└── Project-history/  # Spec and phases files for each feature
```

---

## Features

**Authentication & Authorization (F002)**
Staff login via email/password or Google SSO. Three-tier roles (Admin, Staff, Viewer) with granular permissions. Invite flow, password reset, deactivated staff blocked at login.

**AI Scheduling Engine (F003 + F016)**
Tool-calling conversational AI (F016). Warm, natural conversations — answers questions about services, hours, and policies. Calls scheduling tools when action is needed (confirm, reschedule, cancel, check availability). State guard prevents illegal actions. Distress keyword escalation. Staff takeover/return. Deterministic time parser. Three follow-up messages with deadline enforcement. Waitlist re-engagement.

**Business Operations (F004)**
Schedule and appointment CRUD, staff management, client records with opt-out, business settings with JSONB merge-patch.

**Staff Dashboard (F007/a/b)**
Full React web app on port 3000:
- **Dashboard** — conversations with state badges, escalated-first, filter tabs
- **Conversations** — full thread, takeover/return/approve/reject/close, staff reply input, dev simulate panel
- **Approve Bookings** — one-click approve/reject queue for `awaiting_approval` conversations
- **Clients** — search, profile, appointment history, opt-out toggle
- **Schedules** — month/week calendar; day timeline; ⚡ Batch Create Slots modal
- **Settings** — all business config + portal branding + pause toggle
- **Staff** — invite, role change, permission toggles, deactivate

**Client Booking Portal (F009)**
Next.js web app on port 3002 at `/<slug>`:
- Landing page with branding, Book Now CTA
- Phone OTP login (6-digit code, 30-day session, no password)
- Booking flow: DB-driven date picker → time slots → inline OTP → confirmation (.ics + Google Calendar)
- My Appointments: upcoming/past, cancel and reschedule
- Waitlist join when no slots on chosen date
- Pause bookings toggle for admins

---

## Default Credentials (dev seed)

| | Value |
|---|---|
| Staff email | admin@test.com |
| Staff password | changeme |
| Client OTP | printed in backend terminal |

---

## Project Status

| Feature | Status |
|---|---|
| F001 — Core System Architecture | Done |
| F002 — Authentication & Authorization | Done |
| F003 — AI Engine: Conversation State Machine | Done |
| F004 — Business Operations | Done |
| F005 — Notifications & Delivery Gateway | Spec Ready |
| F006 — Calendar Integration | Spec Ready |
| F007 — Staff Dashboard UI | Done |
| F007a — Schedule Timeline View | Done |
| F007b — Schedule Calendar + Batch Creator | Done |
| F008 — Automated Reminders | Spec Ready |
| F009 — Client Booking Portal | Done |
| F010 — Reporting & Analytics | Spec Ready |
| F011 — Payments & Deposits | Spec Ready |
| F012 — Billing & Subscription | Spec Ready |
| F013 — Post-Appointment Follow-Up | Spec Ready |
| F014 — Outreach Campaigns | Spec Ready |
| F015 — Multi-Location Support | Spec Ready |
| F016 — Conversational AI Engine | Done |

Specs for F005–F015 are in [`Project-history/`](Project-history/). None are built yet.
