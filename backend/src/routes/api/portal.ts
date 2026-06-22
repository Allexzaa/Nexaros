/**
 * F009 — Client Booking Portal routes
 *
 * Public routes (no auth):
 *   GET  /api/v1/public/business/:slug       — business info for landing page
 *   GET  /api/v1/public/slots                — available slots for a date
 *   POST /api/v1/client-auth/send-otp        — send OTP to phone
 *   POST /api/v1/client-auth/verify-otp      — verify OTP, issue session
 *   POST /api/v1/client-auth/logout          — clear session
 *
 * Client-authenticated routes (client session cookie):
 *   GET    /api/v1/client/appointments        — list client's appointments
 *   POST   /api/v1/client/appointments        — book a slot
 *   PATCH  /api/v1/client/appointments/:id/cancel
 *   GET    /api/v1/client/appointments/:id/reschedule-slots
 *   PATCH  /api/v1/client/appointments/:id/reschedule
 *   POST   /api/v1/client/waitlist
 */

import { Router, Request, Response, NextFunction } from 'express';
import { createHash, randomInt } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../db';
import { createError } from '../../middleware/errorHandler';
import { requirePortalAuth, PortalRequest } from '../../auth/portalMiddleware';
import { redisConnection } from '../../jobs/connection';

const router = Router();

// ── helpers ───────────────────────────────────────────────────────────────────

function hashOTP(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

async function getBusinessBySlug(slug: string) {
  const r = await db.query<{ id: string; name: string; timezone: string; settings: Record<string, unknown> }>(
    `SELECT id, name, timezone, settings FROM business WHERE slug = $1 LIMIT 1`,
    [slug],
  );
  return r.rows[0] ?? null;
}

// ── PUBLIC: first business slug (dev convenience) ─────────────────────────────

router.get('/public/business-slug', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const r = await db.query<{ slug: string }>(`SELECT slug FROM business ORDER BY created_at LIMIT 1`);
    if (!r.rows[0]) return next(createError('NOT_FOUND', 'No business found.', 404));
    res.json({ slug: r.rows[0].slug });
  } catch (err) { next(err); }
});

// ── PUBLIC: business info ─────────────────────────────────────────────────────

router.get('/public/business/:slug', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const biz = await getBusinessBySlug(req.params.slug);
    if (!biz) return next(createError('NOT_FOUND', 'Business not found.', 404));

    const s = biz.settings ?? {};
    if (s.bookings_paused) {
      return res.json({
        name: biz.name,
        slug: req.params.slug,
        bookingsPaused: true,
        pauseMessage: (s.bookings_pause_message as string) || "We're not accepting new bookings right now — check back soon.",
        timezone: biz.timezone,
      });
    }

    res.json({
      name:               biz.name,
      slug:               req.params.slug,
      bookingsPaused:     false,
      timezone:           biz.timezone,
      tagline:            (s.tagline as string) || null,
      address:            (s.address as string) || null,
      bookingInstructions:(s.booking_instructions as string) || null,
      logoUrl:            (s.logo_url as string) || null,
    });
  } catch (err) { next(err); }
});

// ── PUBLIC: available slot dates ──────────────────────────────────────────────

router.get('/public/slots', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { businessSlug, date, serviceType } = req.query as Record<string, string>;
    if (!businessSlug || !date) {
      return next(createError('INVALID_INPUT', 'businessSlug and date are required.', 400));
    }

    const biz = await getBusinessBySlug(businessSlug);
    if (!biz) return next(createError('NOT_FOUND', 'Business not found.', 404));

    const params: unknown[] = [biz.id, date, biz.timezone];
    const serviceClause = serviceType
      ? `AND service_type = $${params.push(serviceType)}`
      : '';

    const result = await db.query<{ id: string; starts_at: Date; service_type: string | null }>(
      `SELECT id, starts_at, service_type
       FROM appointment
       WHERE business_id = $1
         AND status = 'available'
         AND client_id IS NULL
         AND starts_at > NOW()
         AND (starts_at AT TIME ZONE $3)::date = $2::date
         ${serviceClause}
       ORDER BY starts_at ASC`,
      params,
    );

    res.json({ slots: result.rows });
  } catch (err) { next(err); }
});

// ── PUBLIC: available slot dates (for calendar) ───────────────────────────────

router.get('/public/available-dates', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { businessSlug, serviceType } = req.query as Record<string, string>;
    if (!businessSlug) return next(createError('INVALID_INPUT', 'businessSlug is required.', 400));

    const biz = await getBusinessBySlug(businessSlug);
    if (!biz) return next(createError('NOT_FOUND', 'Business not found.', 404));

    const params: unknown[] = [biz.id, biz.timezone];
    const serviceClause = serviceType ? `AND service_type = $${params.push(serviceType)}` : '';

    const result = await db.query<{ date: string }>(
      `SELECT DISTINCT (starts_at AT TIME ZONE $2)::date::text AS date
       FROM appointment
       WHERE business_id = $1
         AND status = 'available'
         AND client_id IS NULL
         AND starts_at > NOW()
         ${serviceClause}
       ORDER BY date ASC`,
      params,
    );

    res.json({ dates: result.rows.map(r => r.date) });
  } catch (err) { next(err); }
});

// ── PUBLIC: services list ─────────────────────────────────────────────────────

router.get('/public/services', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { businessSlug } = req.query as Record<string, string>;
    if (!businessSlug) return next(createError('INVALID_INPUT', 'businessSlug is required.', 400));

    const biz = await getBusinessBySlug(businessSlug);
    if (!biz) return next(createError('NOT_FOUND', 'Business not found.', 404));

    const result = await db.query<{ service_type: string }>(
      `SELECT DISTINCT service_type
       FROM appointment
       WHERE business_id = $1
         AND status = 'available'
         AND client_id IS NULL
         AND starts_at > NOW()
         AND service_type IS NOT NULL
       ORDER BY service_type ASC`,
      [biz.id],
    );

    res.json({ services: result.rows.map(r => r.service_type) });
  } catch (err) { next(err); }
});

// ── OTP AUTH: send ────────────────────────────────────────────────────────────

router.post('/client-auth/send-otp', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { phone, businessSlug } = req.body as { phone?: string; businessSlug?: string };
    if (!phone || !businessSlug) {
      return next(createError('INVALID_INPUT', 'phone and businessSlug are required.', 400));
    }

    const normalized = phone.replace(/\D/g, '');
    if (normalized.length < 10) {
      return next(createError('INVALID_INPUT', 'Invalid phone number.', 400));
    }
    const e164 = normalized.startsWith('1') ? `+${normalized}` : `+1${normalized}`;

    const biz = await getBusinessBySlug(businessSlug);
    if (!biz) return next(createError('NOT_FOUND', 'Business not found.', 404));

    // Rate limit: max 3 OTPs per phone per 10 minutes
    const rateKey = `otp:rate:${e164}`;
    const attempts = await redisConnection.incr(rateKey);
    if (attempts === 1) await redisConnection.expire(rateKey, 600);
    if (attempts > 3) {
      return next(createError('RATE_LIMITED', 'Too many OTP requests. Please wait 10 minutes.', 429));
    }

    // Upsert client
    const clientResult = await db.query<{ id: string; opted_out: boolean }>(
      `INSERT INTO client (id, business_id, name, phone)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (business_id, phone) DO UPDATE SET phone = EXCLUDED.phone
       RETURNING id, opted_out`,
      [uuidv4(), biz.id, e164, e164],
    ).catch(async () => {
      // phone not unique constraint — just fetch
      return db.query<{ id: string; opted_out: boolean }>(
        `SELECT id, opted_out FROM client WHERE business_id = $1 AND phone = $2 LIMIT 1`,
        [biz.id, e164],
      );
    });

    const client = clientResult.rows[0];
    if (!client) return next(createError('NOT_FOUND', 'Could not find or create client.', 404));
    if (client.opted_out) return next(createError('OPTED_OUT', 'This number has opted out of communications.', 403));

    // Generate and store OTP
    const code = String(randomInt(100000, 999999));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await db.query(
      `UPDATE client SET otp_hash = $1, otp_expires_at = $2 WHERE id = $3`,
      [hashOTP(code), expiresAt, client.id],
    );

    // Dev: console-log; prod: send via smsService (F005)
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[OTP] Phone: ${e164} | Code: ${code} | Expires: ${expiresAt.toISOString()}`);
    }

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── OTP AUTH: verify ──────────────────────────────────────────────────────────

router.post('/client-auth/verify-otp', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { phone, businessSlug, otp } = req.body as { phone?: string; businessSlug?: string; otp?: string };
    if (!phone || !businessSlug || !otp) {
      return next(createError('INVALID_INPUT', 'phone, businessSlug, and otp are required.', 400));
    }

    const normalized = phone.replace(/\D/g, '');
    const e164 = normalized.startsWith('1') ? `+${normalized}` : `+1${normalized}`;

    const biz = await getBusinessBySlug(businessSlug);
    if (!biz) return next(createError('NOT_FOUND', 'Business not found.', 404));

    const clientResult = await db.query<{
      id: string; name: string; otp_hash: string | null; otp_expires_at: Date | null;
    }>(
      `SELECT id, name, otp_hash, otp_expires_at FROM client
       WHERE business_id = $1 AND phone = $2 LIMIT 1`,
      [biz.id, e164],
    );

    const client = clientResult.rows[0];
    if (!client || !client.otp_hash || !client.otp_expires_at) {
      return next(createError('INVALID_OTP', 'No OTP found. Please request a new code.', 400));
    }
    if (new Date() > new Date(client.otp_expires_at)) {
      return next(createError('INVALID_OTP', 'OTP has expired. Please request a new code.', 400));
    }
    if (hashOTP(otp.trim()) !== client.otp_hash) {
      return next(createError('INVALID_OTP', 'Incorrect code. Please try again.', 400));
    }

    // Clear OTP fields
    await db.query(`UPDATE client SET otp_hash = NULL, otp_expires_at = NULL WHERE id = $1`, [client.id]);

    // Create session (30 days)
    const token = uuidv4();
    const sessionExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await db.query(
      `INSERT INTO client_session (id, client_id, business_id, session_token, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (client_id) DO UPDATE SET session_token = $4, expires_at = $5`,
      [uuidv4(), client.id, biz.id, token, sessionExpiry],
    );

    res.cookie('client_session', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      expires: sessionExpiry,
    });

    res.json({ clientId: client.id, name: client.name || e164 });
  } catch (err) { next(err); }
});

// ── OTP AUTH: logout ──────────────────────────────────────────────────────────

router.post('/client-auth/logout', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.cookies?.client_session;
    if (token) {
      await db.query(`DELETE FROM client_session WHERE session_token = $1`, [token]);
    }
    res.clearCookie('client_session');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── CLIENT: list appointments ─────────────────────────────────────────────────

router.get('/client/appointments', requirePortalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { clientId } = (req as PortalRequest).client;
    const { status } = req.query as { status?: string };

    const now = new Date().toISOString();
    const upcomingClause = status === 'past'
      ? `AND a.starts_at < $2`
      : status === 'upcoming'
      ? `AND a.starts_at >= $2 AND a.status = 'confirmed'`
      : '';

    const result = await db.query<{
      id: string; starts_at: Date; service_type: string | null; status: string;
    }>(
      `SELECT a.id, a.starts_at, a.service_type, a.status
       FROM appointment a
       WHERE a.client_id = $1 ${upcomingClause}
       ORDER BY a.starts_at DESC`,
      upcomingClause ? [clientId, now] : [clientId],
    );

    res.json({ data: result.rows });
  } catch (err) { next(err); }
});

// ── CLIENT: book a slot ───────────────────────────────────────────────────────

router.post('/client/appointments', requirePortalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { clientId, businessId } = (req as PortalRequest).client;
    const { slotId, notes } = req.body as { slotId?: string; notes?: string };

    if (!slotId) return next(createError('INVALID_INPUT', 'slotId is required.', 400));

    const slot = await db.query<{ id: string; starts_at: Date; service_type: string | null; status: string }>(
      `SELECT id, starts_at, service_type, status FROM appointment
       WHERE id = $1 AND business_id = $2 LIMIT 1`,
      [slotId, businessId],
    );

    if (!slot.rows[0]) return next(createError('NOT_FOUND', 'Slot not found.', 404));
    if (slot.rows[0].status !== 'available') {
      return next(createError('SLOT_UNAVAILABLE', 'This slot is no longer available.', 409));
    }

    await db.query(
      `UPDATE appointment SET status = 'confirmed', client_id = $1 WHERE id = $2`,
      [clientId, slotId],
    );

    res.status(201).json({
      appointmentId: slotId,
      startsAt:      slot.rows[0].starts_at,
      serviceType:   slot.rows[0].service_type,
    });
  } catch (err) { next(err); }
});

// ── CLIENT: cancel ────────────────────────────────────────────────────────────

router.patch('/client/appointments/:id/cancel', requirePortalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { clientId, businessId } = (req as PortalRequest).client;
    const apptId = req.params.id;

    const appt = await db.query<{ id: string; starts_at: Date; status: string }>(
      `SELECT id, starts_at, status FROM appointment
       WHERE id = $1 AND client_id = $2 AND business_id = $3 LIMIT 1`,
      [apptId, clientId, businessId],
    );
    if (!appt.rows[0]) return next(createError('NOT_FOUND', 'Appointment not found.', 404));
    if (appt.rows[0].status !== 'confirmed') {
      return next(createError('INVALID_STATE', 'Only confirmed appointments can be cancelled.', 409));
    }

    // Check cancellation window (business setting, default 24h)
    const bizResult = await db.query<{ settings: Record<string, unknown> }>(
      `SELECT settings FROM business WHERE id = $1`, [businessId],
    );
    const windowHours = (bizResult.rows[0]?.settings?.client_cancel_window_hours as number) ?? 24;
    const hoursUntil = (new Date(appt.rows[0].starts_at).getTime() - Date.now()) / 3600000;
    if (hoursUntil < windowHours) {
      return next(createError('CANCEL_WINDOW_PASSED',
        `Cancellations must be made at least ${windowHours} hours before the appointment.`, 409));
    }

    await db.query(`UPDATE appointment SET status = 'cancelled' WHERE id = $1`, [apptId]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── CLIENT: reschedule slot options ──────────────────────────────────────────

router.get('/client/appointments/:id/reschedule-slots', requirePortalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { clientId, businessId } = (req as PortalRequest).client;
    const { date } = req.query as { date?: string };
    if (!date) return next(createError('INVALID_INPUT', 'date (YYYY-MM-DD) is required.', 400));

    const appt = await db.query<{ service_type: string | null }>(
      `SELECT service_type FROM appointment WHERE id = $1 AND client_id = $2 AND business_id = $3 LIMIT 1`,
      [req.params.id, clientId, businessId],
    );
    if (!appt.rows[0]) return next(createError('NOT_FOUND', 'Appointment not found.', 404));

    const bizTz = await db.query<{ timezone: string }>(`SELECT timezone FROM business WHERE id = $1`, [businessId]);
    const tz = bizTz.rows[0]?.timezone ?? 'America/Los_Angeles';

    const result = await db.query<{ id: string; starts_at: Date; service_type: string | null }>(
      `SELECT id, starts_at, service_type FROM appointment
       WHERE business_id = $1
         AND status = 'available'
         AND client_id IS NULL
         AND id != $2
         AND (starts_at AT TIME ZONE $3)::date = $4::date
         AND starts_at > NOW()
       ORDER BY starts_at ASC`,
      [businessId, req.params.id, tz, date],
    );

    res.json({ slots: result.rows });
  } catch (err) { next(err); }
});

// ── CLIENT: reschedule ────────────────────────────────────────────────────────

router.patch('/client/appointments/:id/reschedule', requirePortalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { clientId, businessId } = (req as PortalRequest).client;
    const { newSlotId } = req.body as { newSlotId?: string };
    if (!newSlotId) return next(createError('INVALID_INPUT', 'newSlotId is required.', 400));

    const original = await db.query<{ starts_at: Date; status: string; service_type: string | null }>(
      `SELECT starts_at, status, service_type FROM appointment
       WHERE id = $1 AND client_id = $2 AND business_id = $3 LIMIT 1`,
      [req.params.id, clientId, businessId],
    );
    if (!original.rows[0]) return next(createError('NOT_FOUND', 'Appointment not found.', 404));
    if (original.rows[0].status !== 'confirmed') {
      return next(createError('INVALID_STATE', 'Only confirmed appointments can be rescheduled.', 409));
    }

    const bizResult = await db.query<{ settings: Record<string, unknown> }>(
      `SELECT settings FROM business WHERE id = $1`, [businessId],
    );
    const windowHours = (bizResult.rows[0]?.settings?.client_cancel_window_hours as number) ?? 24;
    const hoursUntil = (new Date(original.rows[0].starts_at).getTime() - Date.now()) / 3600000;
    if (hoursUntil < windowHours) {
      return next(createError('RESCHEDULE_WINDOW_PASSED',
        `Rescheduling must be done at least ${windowHours} hours before the appointment.`, 409));
    }

    const newSlot = await db.query<{ starts_at: Date; status: string }>(
      `SELECT starts_at, status FROM appointment WHERE id = $1 AND business_id = $2 LIMIT 1`,
      [newSlotId, businessId],
    );
    if (!newSlot.rows[0] || newSlot.rows[0].status !== 'available') {
      return next(createError('SLOT_UNAVAILABLE', 'The selected slot is no longer available.', 409));
    }

    // Free original, confirm new
    await db.query(`UPDATE appointment SET status = 'available', client_id = NULL WHERE id = $1`, [req.params.id]);
    await db.query(`UPDATE appointment SET status = 'confirmed', client_id = $1 WHERE id = $2`, [clientId, newSlotId]);

    res.json({ appointmentId: newSlotId, startsAt: newSlot.rows[0].starts_at });
  } catch (err) { next(err); }
});

// ── CLIENT: join waitlist ─────────────────────────────────────────────────────

router.post('/client/waitlist', requirePortalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { clientId, businessId } = (req as PortalRequest).client;
    const { serviceType, preferences } = req.body as { serviceType?: string; preferences?: string };

    await db.query(
      `INSERT INTO waitlist_entry (id, client_id, business_id, preferences)
       VALUES ($1, $2, $3, $4)`,
      [uuidv4(), clientId, businessId, preferences || serviceType || ''],
    );

    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
