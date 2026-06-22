import 'dotenv/config';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';

if (process.env.NODE_ENV === 'production') {
  console.log('Test data script is disabled in production.');
  process.exit(0);
}

const db = new Pool({ connectionString: process.env.DATABASE_URL });

// ── helpers ──────────────────────────────────────────────────────────────────

function daysFromNow(n: number, hour = 10, minute = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

function dateOnly(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

async function insertMessages(
  convId: string,
  thread: Array<{ sender: 'ai' | 'client' | 'staff'; content: string; minutesAgo: number }>,
): Promise<void> {
  for (const msg of thread) {
    const ts = new Date(Date.now() - msg.minutesAgo * 60 * 1000).toISOString();
    await db.query(
      `INSERT INTO message (id, conversation_id, sender, content, timestamp)
       VALUES ($1, $2, $3, $4, $5)`,
      [uuidv4(), convId, msg.sender, msg.content, ts],
    );
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function seed(): Promise<void> {
  const bizRow = await db.query(`SELECT id FROM business LIMIT 1`);
  if (!bizRow.rowCount) { console.error('No business found — run npm run seed first.'); process.exit(1); }
  const businessId: string = bizRow.rows[0].id;

  const staffRow = await db.query(`SELECT id FROM staff_user WHERE business_id = $1 AND role = 'admin' LIMIT 1`, [businessId]);
  const adminId: string = staffRow.rows[0].id;

  // ── check if test data already exists ──
  const existing = await db.query(`SELECT COUNT(*) FROM client WHERE business_id = $1`, [businessId]);
  if (parseInt(existing.rows[0].count) > 0) {
    console.log('Test data already present — dropping and re-seeding...');
    await db.query(`DELETE FROM waitlist_entry WHERE business_id = $1`, [businessId]);
    await db.query(`DELETE FROM conversation WHERE business_id = $1`, [businessId]);
    await db.query(`DELETE FROM appointment WHERE business_id = $1`, [businessId]);
    await db.query(`DELETE FROM schedule WHERE business_id = $1`, [businessId]);
    await db.query(`DELETE FROM client WHERE business_id = $1`, [businessId]);
  }

  await db.query('BEGIN');
  try {

    // ── CLIENTS ──────────────────────────────────────────────────────────────
    console.log('Creating clients...');

    const clients: Record<string, string> = {};
    const clientData = [
      { key: 'sarah',   name: 'Sarah Johnson',    phone: '+15550001001', email: 'sarah@example.com' },
      { key: 'marcus',  name: 'Marcus Chen',       phone: '+15550001002', email: 'marcus@example.com' },
      { key: 'emily',   name: 'Emily Rodriguez',   phone: '+15550001003', email: 'emily@example.com' },
      { key: 'david',   name: 'David Kim',         phone: '+15550001004', email: 'david@example.com' },
      { key: 'lisa',    name: 'Lisa Thompson',     phone: '+15550001005', email: 'lisa@example.com' },
      { key: 'james',   name: 'James Wilson',      phone: '+15550001006', email: 'james@example.com' },
      { key: 'aisha',   name: 'Aisha Patel',       phone: '+15550001007', email: 'aisha@example.com' },
      { key: 'noah',    name: 'Noah Williams',     phone: '+15550001008', email: 'noah@example.com' },
      { key: 'maya',    name: 'Maya Brown',        phone: '+15550001009', email: 'maya@example.com' },
    ];

    for (const c of clientData) {
      const id = uuidv4();
      clients[c.key] = id;
      await db.query(
        `INSERT INTO client (id, business_id, name, phone, email) VALUES ($1, $2, $3, $4, $5)`,
        [id, businessId, c.name, c.phone, c.email],
      );
    }

    // ── SCHEDULES ────────────────────────────────────────────────────────────
    console.log('Creating schedules...');

    const schedules: Record<string, string> = {};
    const scheduleDays = [
      { key: 'lastWeek', offset: -5 },
      { key: 'yesterday', offset: -1 },
      { key: 'today', offset: 0 },
      { key: 'tomorrow', offset: 1 },
      { key: 'nextWeek1', offset: 6 },
      { key: 'nextWeek2', offset: 7 },
      { key: 'nextWeek3', offset: 8 },
    ];

    for (const s of scheduleDays) {
      const id = uuidv4();
      schedules[s.key] = id;
      await db.query(
        `INSERT INTO schedule (id, business_id, date, created_by) VALUES ($1, $2, $3, $4)`,
        [id, businessId, dateOnly(s.offset), adminId],
      );
    }

    // ── APPOINTMENTS ─────────────────────────────────────────────────────────
    console.log('Creating appointments...');

    const appts: Record<string, string> = {};

    // Past confirmed (James) — last week 10am
    appts.james = uuidv4();
    await db.query(
      `INSERT INTO appointment (id, business_id, schedule_id, client_id, starts_at, service_type, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [appts.james, businessId, schedules.lastWeek, clients.james, daysFromNow(-5, 10), 'Haircut', 'confirmed'],
    );

    // Past cancelled (Aisha) — yesterday 2pm
    appts.aisha = uuidv4();
    await db.query(
      `INSERT INTO appointment (id, business_id, schedule_id, client_id, starts_at, service_type, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [appts.aisha, businessId, schedules.yesterday, clients.aisha, daysFromNow(-1, 14), 'Color Treatment', 'cancelled'],
    );

    // Today — Maya (no-response)
    appts.maya = uuidv4();
    await db.query(
      `INSERT INTO appointment (id, business_id, schedule_id, client_id, starts_at, service_type, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [appts.maya, businessId, schedules.today, clients.maya, daysFromNow(0, 9), 'Consultation', 'no-response'],
    );

    // Tomorrow — Sarah (confirmed)
    appts.sarah = uuidv4();
    await db.query(
      `INSERT INTO appointment (id, business_id, schedule_id, client_id, starts_at, service_type, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [appts.sarah, businessId, schedules.tomorrow, clients.sarah, daysFromNow(1, 10), 'Haircut', 'confirmed'],
    );

    // Tomorrow — Marcus (ai-active, outreach sent, awaiting reply)
    appts.marcus = uuidv4();
    await db.query(
      `INSERT INTO appointment (id, business_id, schedule_id, client_id, starts_at, service_type, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [appts.marcus, businessId, schedules.tomorrow, clients.marcus, daysFromNow(1, 14), 'Color Treatment', 'ai-active'],
    );

    // Next week — Emily (ai-active, escalated)
    appts.emily = uuidv4();
    await db.query(
      `INSERT INTO appointment (id, business_id, schedule_id, client_id, starts_at, service_type, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [appts.emily, businessId, schedules.nextWeek1, clients.emily, daysFromNow(6, 11), 'Highlights', 'ai-active'],
    );

    // Next week — David (ai-active, awaiting approval)
    appts.david = uuidv4();
    await db.query(
      `INSERT INTO appointment (id, business_id, schedule_id, client_id, starts_at, service_type, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [appts.david, businessId, schedules.nextWeek2, clients.david, daysFromNow(7, 13), 'Blowout', 'ai-active'],
    );

    // Next week — Noah (staff_active, staff took over)
    appts.noah = uuidv4();
    await db.query(
      `INSERT INTO appointment (id, business_id, schedule_id, client_id, starts_at, service_type, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [appts.noah, businessId, schedules.nextWeek3, clients.noah, daysFromNow(8, 15), 'Keratin Treatment', 'ai-active'],
    );

    // Available slot for Lisa's waitlist (next week)
    appts.availableForLisa = uuidv4();
    await db.query(
      `INSERT INTO appointment (id, business_id, schedule_id, client_id, starts_at, service_type, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [appts.availableForLisa, businessId, schedules.nextWeek1, null, daysFromNow(6, 15), 'Haircut', 'available'],
    );

    // ── CONVERSATIONS ─────────────────────────────────────────────────────────
    console.log('Creating conversations...');

    const convs: Record<string, string> = {};

    // 1. RESOLVED — James (past, completed appointment)
    convs.james = uuidv4();
    await db.query(
      `INSERT INTO conversation (id, business_id, client_id, appointment_id, state, follow_up_count)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [convs.james, businessId, clients.james, appts.james, 'resolved', 0],
    );
    await insertMessages(convs.james, [
      { sender: 'ai',     content: "Hi James! This is a reminder about your Haircut appointment this Friday at 10am. Does that still work for you?", minutesAgo: 8000 },
      { sender: 'client', content: "Yes, that works great, thanks!", minutesAgo: 7950 },
      { sender: 'ai',     content: "Perfect! We'll see you then. Reply STOP at any time to opt out.", minutesAgo: 7940 },
    ]);

    // 2. CANCELLED — Aisha
    convs.aisha = uuidv4();
    await db.query(
      `INSERT INTO conversation (id, business_id, client_id, appointment_id, state, follow_up_count)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [convs.aisha, businessId, clients.aisha, appts.aisha, 'cancelled', 1],
    );
    await insertMessages(convs.aisha, [
      { sender: 'ai',     content: "Hi Aisha! You have a Color Treatment appointment scheduled for tomorrow at 2pm. Can you confirm you'll be there?", minutesAgo: 2000 },
      { sender: 'client', content: "Sorry I need to cancel, something came up", minutesAgo: 1900 },
      { sender: 'ai',     content: "No problem at all, Aisha. Your appointment has been cancelled. Feel free to rebook whenever you're ready!", minutesAgo: 1899 },
    ]);

    // 3. NO_RESPONSE — Maya
    convs.maya = uuidv4();
    await db.query(
      `INSERT INTO conversation (id, business_id, client_id, appointment_id, state, follow_up_count, next_follow_up_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [convs.maya, businessId, clients.maya, appts.maya, 'no_response', 3, null],
    );
    await insertMessages(convs.maya, [
      { sender: 'ai',     content: "Hi Maya! You have a Consultation scheduled for today at 9am. Please confirm by replying YES or NO.", minutesAgo: 720 },
      { sender: 'ai',     content: "Just following up — your appointment is in a few hours. Reply YES to confirm or NO to cancel.", minutesAgo: 480 },
      { sender: 'ai',     content: "Last reminder — we haven't heard back. If we don't hear from you, the slot may be released.", minutesAgo: 240 },
    ]);

    // 4. CONFIRMED — Sarah (tomorrow, confirmed)
    convs.sarah = uuidv4();
    await db.query(
      `INSERT INTO conversation (id, business_id, client_id, appointment_id, state, follow_up_count)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [convs.sarah, businessId, clients.sarah, appts.sarah, 'confirmed', 0],
    );
    await insertMessages(convs.sarah, [
      { sender: 'ai',     content: "Hi Sarah! We'd love to have you in for a Haircut tomorrow at 10am. Does that work for you?", minutesAgo: 300 },
      { sender: 'client', content: "Yes! Looking forward to it 😊", minutesAgo: 280 },
      { sender: 'ai',     content: "Wonderful! Your appointment is confirmed for tomorrow at 10am. See you then!", minutesAgo: 279 },
    ]);

    // 5. AWAITING_REPLY — Marcus (outreach sent, no reply yet)
    convs.marcus = uuidv4();
    await db.query(
      `INSERT INTO conversation (id, business_id, client_id, appointment_id, state, follow_up_count, next_follow_up_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [convs.marcus, businessId, clients.marcus, appts.marcus, 'awaiting_reply', 0, daysFromNow(0, 18)],
    );
    await insertMessages(convs.marcus, [
      { sender: 'ai', content: "Hi Marcus! We have a Color Treatment slot open tomorrow at 2pm. Interested in booking? Reply YES to confirm or NO to pass.", minutesAgo: 45 },
    ]);

    // 6. ESCALATED — Emily (client sent confusing message, AI escalated)
    convs.emily = uuidv4();
    await db.query(
      `INSERT INTO conversation (id, business_id, client_id, appointment_id, state, escalation_reason, follow_up_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [convs.emily, businessId, clients.emily, appts.emily, 'escalated',
       'Client is asking about a specific stylist and custom pricing that the AI cannot confirm.', 0],
    );
    await insertMessages(convs.emily, [
      { sender: 'ai',     content: "Hi Emily! We have a Highlights appointment available next Tuesday at 11am. Shall we book it?", minutesAgo: 90 },
      { sender: 'client', content: "Is Maria available? I only want Maria. Also can I get the price she gave me last time which was $120 not the regular price", minutesAgo: 75 },
      { sender: 'ai',     content: "I want to make sure we get this right for you! Let me connect you with a team member who can check Maria's availability and confirm your pricing.", minutesAgo: 74 },
    ]);

    // 7. AWAITING_APPROVAL — David (wants to book, staff must approve)
    convs.david = uuidv4();
    await db.query(
      `INSERT INTO conversation (id, business_id, client_id, appointment_id, state, offered_slot_id, follow_up_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [convs.david, businessId, clients.david, appts.david, 'awaiting_approval', appts.david, 0],
    );
    await insertMessages(convs.david, [
      { sender: 'ai',     content: "Hi David! We have a Blowout available next Wednesday at 1pm. Interested?", minutesAgo: 60 },
      { sender: 'client', content: "Yes please!", minutesAgo: 50 },
      { sender: 'ai',     content: "Great! I'm sending this to our team for quick approval. You'll hear back within the hour.", minutesAgo: 49 },
    ]);

    // 8. STAFF_ACTIVE — Noah (staff took over the conversation)
    convs.noah = uuidv4();
    await db.query(
      `INSERT INTO conversation (id, business_id, client_id, appointment_id, state, taken_over_by, follow_up_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [convs.noah, businessId, clients.noah, appts.noah, 'staff_active', adminId, 0],
    );
    await insertMessages(convs.noah, [
      { sender: 'ai',     content: "Hi Noah! We'd like to schedule a Keratin Treatment for you next Thursday at 3pm. Does that work?", minutesAgo: 120 },
      { sender: 'client', content: "I have a question about the aftercare, will there be instructions provided?", minutesAgo: 100 },
      { sender: 'ai',     content: "That's a great question! Let me connect you with one of our specialists who can walk you through everything.", minutesAgo: 99 },
      { sender: 'staff',  content: "Hi Noah, this is Alex! Absolutely — we provide a full aftercare kit and a printed guide. You'll need to avoid washing your hair for 72 hours after the treatment.", minutesAgo: 85 },
      { sender: 'client', content: "Perfect, thank you! That's exactly what I needed to know.", minutesAgo: 70 },
    ]);

    // ── WAITLIST ──────────────────────────────────────────────────────────────
    console.log('Creating waitlist entries...');

    // Lisa — wants a Haircut, waitlisted
    await db.query(
      `INSERT INTO waitlist_entry (id, client_id, business_id, preferences, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [uuidv4(), clients.lisa, businessId, 'Haircut, any morning slot, preferably this week', 'waiting'],
    );

    // Second waitlist entry — Marcus (also on waitlist for another service, unrelated to his active conv)
    await db.query(
      `INSERT INTO waitlist_entry (id, client_id, business_id, preferences, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [uuidv4(), clients.maya, businessId, 'Consultation, flexible on time, next week preferred', 'waiting'],
    );

    await db.query('COMMIT');

    console.log('\n✓ Test data created successfully!\n');
    console.log('Clients (9):');
    console.log('  Sarah Johnson    — confirmed appointment tomorrow 10am');
    console.log('  Marcus Chen      — awaiting reply (outreach sent)');
    console.log('  Emily Rodriguez  — escalated (stylist/pricing question)');
    console.log('  David Kim        — awaiting staff approval');
    console.log('  Lisa Thompson    — on waitlist (Haircut, mornings)');
    console.log('  James Wilson     — resolved (past appointment last week)');
    console.log('  Aisha Patel      — cancelled');
    console.log('  Noah Williams    — staff active (staff took over)');
    console.log('  Maya Brown       — no response + on waitlist\n');
    console.log('Schedules: last week, yesterday, today, tomorrow, next week (3 days)');
    console.log('Conversations: 8 across all major states');
    console.log('Waitlist entries: 2 (Lisa, Maya)\n');

  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

seed()
  .catch((err: Error) => { console.error('Test data seed failed:', err.message); process.exit(1); })
  .finally(() => db.end());
