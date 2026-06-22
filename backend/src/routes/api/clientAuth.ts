import { Router, Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../db';
import { createError } from '../../middleware/errorHandler';
import { authRateLimiter } from '../../middleware/rateLimiter';
import { issueClientToken } from '../../auth/tokens';
import { requireClientAuth, ClientRequest } from '../../auth/clientMiddleware';
import { requireAuth, requireRole, StaffRequest } from '../../auth/middleware';
import { sendClientInvite } from '../../services/email';
import { env } from '../../config/env';
import { runConversationAgent } from '../../ai/conversationAgent';
import { emitNewMessage, emitAppointmentConfirmed } from '../../realtime/emitters';
import { MessageRecord } from '../../realtime/types';
import { lockSlot, SlotConflictError } from '../../services/slotManager';

const router = Router();

// In-memory rate limit store for short code attempts (keyed by short_code)
// In production: replace with Redis-backed rate limiting
const attemptStore = new Map<string, { count: number; lockedUntil: number }>();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS   = 15 * 60 * 1000;

function checkRateLimit(code: string): boolean {
  const now = Date.now();
  const entry = attemptStore.get(code);
  if (!entry) return true;
  if (entry.lockedUntil > now) return false;
  if (entry.count >= MAX_ATTEMPTS) {
    attemptStore.set(code, { count: entry.count, lockedUntil: now + LOCKOUT_MS });
    return false;
  }
  return true;
}

function incrementAttempts(code: string): void {
  const entry = attemptStore.get(code) ?? { count: 0, lockedUntil: 0 };
  attemptStore.set(code, { ...entry, count: entry.count + 1 });
}

function clearAttempts(code: string): void {
  attemptStore.delete(code);
}

// POST /api/v1/auth/redeem — client short code redemption
router.post('/auth/redeem', authRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code } = req.body as { code?: string };
    if (!code) return next(createError('INVALID_INPUT', 'code is required.', 400));

    if (!checkRateLimit(code)) {
      return next(createError('RATE_LIMIT_EXCEEDED', 'Too many incorrect attempts. Please try again in 15 minutes.', 429));
    }

    const result = await db.query<{
      id: string; client_id: string; business_id: string;
      expires_at: Date; used_at: Date | null;
    }>(
      `SELECT ci.id, ci.client_id, ci.business_id, ci.expires_at, ci.used_at
       FROM client_invite ci WHERE ci.short_code = $1 LIMIT 1`,
      [code.trim()],
    );

    const invite = result.rows[0];

    if (!invite) {
      incrementAttempts(code);
      return next(createError('INVITE_INVALID', 'Invalid invite code.', 400));
    }
    if (invite.used_at) {
      return next(createError('INVITE_USED', 'This invite has already been redeemed. If you\'re having trouble signing in, contact your office.', 400));
    }
    if (invite.expires_at < new Date()) {
      return next(createError('INVITE_EXPIRED', 'This invite link has expired. Please contact your office to request a new one.', 400));
    }

    clearAttempts(code);

    // Mark invite as used and set client as registered
    await db.query('BEGIN');
    try {
      await db.query('UPDATE client_invite SET used_at = now() WHERE id = $1', [invite.id]);
      await db.query('UPDATE client SET app_registered = true WHERE id = $1', [invite.client_id]);
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }

    // Get current session_version for the client
    const clientRow = await db.query<{ session_version: number }>(
      'SELECT session_version FROM client WHERE id = $1', [invite.client_id],
    );

    const token = issueClientToken(invite.client_id, invite.business_id, clientRow.rows[0].session_version);
    res.json({ token, clientId: invite.client_id, businessId: invite.business_id });
  } catch (err) { next(err); }
});

// POST /api/v1/client/device-tokens — upsert FCM device token
router.post('/client/device-tokens', requireClientAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id: clientId, businessId } = (req as ClientRequest).client;
    const { token, platform } = req.body as { token?: string; platform?: string };

    if (!token || !platform || !['ios', 'android'].includes(platform)) {
      return next(createError('INVALID_INPUT', 'token and platform (ios|android) are required.', 400));
    }

    await db.query(
      `INSERT INTO device_token (id, client_id, business_id, token, platform, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (client_id, platform) DO UPDATE SET token = $4, updated_at = now()`,
      [uuidv4(), clientId, businessId, token, platform],
    );

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/v1/client/device-tokens/:platform — remove token on logout
router.delete('/client/device-tokens/:platform', requireClientAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id: clientId } = (req as ClientRequest).client;
    const { platform } = req.params;
    await db.query('DELETE FROM device_token WHERE client_id = $1 AND platform = $2', [clientId, platform]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/v1/client/messages — receive a message from the client app
router.post('/client/messages', requireClientAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id: clientId, businessId } = (req as ClientRequest).client;
    const { content, conversationId } = req.body as { content?: string; conversationId?: string };

    if (!content || !conversationId) {
      return next(createError('INVALID_INPUT', 'content and conversationId are required.', 400));
    }

    // Verify conversation belongs to this client
    const convResult = await db.query<{ state: string; business_id: string }>(
      `SELECT state, business_id FROM conversation WHERE id = $1 AND client_id = $2 LIMIT 1`,
      [conversationId, clientId],
    );
    if (!convResult.rows[0]) {
      return next(createError('NOT_FOUND', 'Conversation not found.', 404));
    }
    const { state, business_id } = convResult.rows[0];

    // Verify business matches client token
    if (business_id !== businessId) {
      return next(createError('FORBIDDEN', 'Access denied.', 403));
    }

    // Store the client message
    const msgResult = await db.query<{ id: string; timestamp: Date }>(
      `INSERT INTO message (id, conversation_id, sender, content) VALUES ($1, $2, 'client', $3) RETURNING id, timestamp`,
      [uuidv4(), conversationId, content],
    );
    const msgRow = msgResult.rows[0];

    const messageRecord: MessageRecord = {
      id: msgRow.id,
      sender: 'client',
      content,
      timestamp: msgRow.timestamp.toISOString(),
    };
    emitNewMessage(businessId, clientId, conversationId, messageRecord);

    // Run the agent for any active state; skip terminal and staff-controlled states
    const SKIP_STATES = new Set(['cancelled', 'resolved', 'no_response', 'staff_active', 'escalated']);
    if (!SKIP_STATES.has(state)) {
      runConversationAgent(conversationId, content).catch((err) =>
        console.error(`[client/messages] runConversationAgent error:`, err),
      );
    }

    res.status(201).json({ messageId: msgRow.id });
  } catch (err) { next(err); }
});

// GET /api/v1/client/messages — paginated message history (stub for Phase 4 wiring)
router.get('/client/messages', requireClientAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id: clientId, businessId } = (req as ClientRequest).client;
    const limit  = Math.min(parseInt(req.query.limit  as string ?? '50', 10), 100);
    const cursor = req.query.cursor as string | undefined;

    const result = await db.query<{
      id: string; content: string; sender: string; timestamp: Date; conversation_id: string;
    }>(
      `SELECT m.id, m.content, m.sender, m.timestamp, m.conversation_id
       FROM message m
       JOIN conversation c ON c.id = m.conversation_id
       WHERE c.client_id = $1 AND c.business_id = $2
         ${cursor ? `AND m.timestamp < (SELECT timestamp FROM message WHERE id = $4)` : ''}
       ORDER BY m.timestamp DESC
       LIMIT $3`,
      cursor ? [clientId, businessId, limit, cursor] : [clientId, businessId, limit],
    );

    const rows = result.rows.reverse();
    const nextCursor = result.rows.length === limit ? result.rows[result.rows.length - 1].id : null;
    res.json({ data: rows, next_cursor: nextCursor });
  } catch (err) { next(err); }
});

// POST /api/v1/admin/clients/:id/expire-session — Admin only
router.post(
  '/admin/clients/:id/expire-session',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { businessId } = (req as StaffRequest).staff;
      const clientId = req.params.id;

      // Verify client belongs to this business
      const clientRow = await db.query<{ id: string; email: string | null }>(
        'SELECT id, email FROM client WHERE id = $1 AND business_id = $2 LIMIT 1',
        [clientId, businessId],
      );

      if (!clientRow.rows[0]) {
        return next(createError('NOT_FOUND', 'Client not found.', 404));
      }

      // Increment session_version — invalidates all existing JWTs
      await db.query('UPDATE client SET session_version = session_version + 1 WHERE id = $1', [clientId]);

      // Invalidate any pending invites for this client
      await db.query(
        'UPDATE client_invite SET used_at = now() WHERE client_id = $1 AND used_at IS NULL',
        [clientId],
      );

      // Create a new invite and send it
      const shortCode = randomBytes(3).toString('hex').toUpperCase(); // 6-char hex
      const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
      await db.query(
        'INSERT INTO client_invite (id, client_id, business_id, short_code, expires_at) VALUES ($1, $2, $3, $4, $5)',
        [uuidv4(), clientId, businessId, shortCode, expiresAt],
      );

      if (clientRow.rows[0].email) {
        const inviteUrl = `https://${env.APP_DOMAIN}/redeem?code=${shortCode}`;
        await sendClientInvite(clientRow.rows[0].email, inviteUrl);
      }

      res.json({ ok: true });
    } catch (err) { next(err); }
  },
);

// GET /api/v1/client/slots — available appointment slots for this client's business
router.get('/client/slots', requireClientAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { businessId } = (req as ClientRequest).client;

    const result = await db.query<{ id: string; starts_at: Date; service_type: string | null }>(
      `SELECT id, starts_at, service_type FROM appointment
       WHERE business_id = $1 AND status = 'available'
       ORDER BY starts_at ASC`,
      [businessId],
    );

    res.json({
      slots: result.rows.map((r) => ({
        id: r.id,
        startsAt: r.starts_at,
        serviceType: r.service_type,
      })),
    });
  } catch (err) { next(err); }
});

// POST /api/v1/client/bookings — client self-service slot booking
router.post('/client/bookings', requireClientAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id: clientId, businessId } = (req as ClientRequest).client;
    const { slotId } = req.body as { slotId?: string };

    if (!slotId) return next(createError('INVALID_INPUT', 'slotId is required.', 400));

    const slotResult = await db.query<{
      starts_at: Date; service_type: string | null; business_id: string;
    }>(
      `SELECT starts_at, service_type, business_id FROM appointment WHERE id = $1 AND status = 'available' LIMIT 1`,
      [slotId],
    );

    if (!slotResult.rows[0]) {
      return next(createError('NOT_FOUND', 'Slot not found or not available.', 404));
    }
    if (slotResult.rows[0].business_id !== businessId) {
      return next(createError('FORBIDDEN', 'Access denied.', 403));
    }

    const slot = slotResult.rows[0];

    try {
      await lockSlot(slotId, clientId);
    } catch (err) {
      if (err instanceof SlotConflictError) {
        return next(createError('SLOT_TAKEN', 'That slot is no longer available.', 409));
      }
      throw err;
    }

    const conversationId = uuidv4();
    await db.query(
      `INSERT INTO conversation (id, client_id, business_id, appointment_id, state)
       VALUES ($1, $2, $3, $4, 'confirmed')`,
      [conversationId, clientId, businessId, slotId],
    );

    const slotDate = new Intl.DateTimeFormat('en-US', {
      weekday: 'long', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date(slot.starts_at));
    const serviceLabel = slot.service_type ? `your ${slot.service_type}` : 'your appointment';
    const responseText = `Got it — I've reserved ${serviceLabel} on ${slotDate}. You're all set!`;

    const msgResult = await db.query<{ id: string; timestamp: Date }>(
      `INSERT INTO message (id, conversation_id, sender, content) VALUES ($1, $2, 'ai', $3) RETURNING id, timestamp`,
      [uuidv4(), conversationId, responseText],
    );

    const clientRow = await db.query<{ name: string }>(
      `SELECT name FROM client WHERE id = $1`,
      [clientId],
    );
    const clientName = clientRow.rows[0]?.name ?? '';

    const messageRecord: MessageRecord = {
      id: msgResult.rows[0].id,
      sender: 'ai',
      content: responseText,
      timestamp: msgResult.rows[0].timestamp.toISOString(),
    };
    emitNewMessage(businessId, clientId, conversationId, messageRecord);
    emitAppointmentConfirmed(businessId, slotId, clientName, slot.starts_at.toISOString(), slot.service_type ?? '');

    res.status(201).json({ conversationId, appointmentId: slotId });
  } catch (err) { next(err); }
});

export default router;
