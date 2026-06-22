import { Router, Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth, StaffRequest } from '../../auth/middleware';
import { db } from '../../db';
import { createError } from '../../middleware/errorHandler';
import { sendClientInvite } from '../../services/email';
import { env } from '../../config/env';

const router = Router();

// GET /api/v1/clients — paginated list with optional search
router.get('/clients', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { businessId } = (req as StaffRequest).staff;
    const limit  = Math.min(parseInt(req.query.limit  as string ?? '50', 10), 100);
    const offset = Math.max(parseInt(req.query.offset as string ?? '0',  10), 0);
    const search = req.query.search as string | undefined;

    const params: unknown[] = [businessId, limit, offset];
    const searchClause = search
      ? `AND (cl.name ILIKE $${params.push(`%${search}%`)} OR cl.email ILIKE $${params.push(`%${search}%`)})`
      : '';

    const result = await db.query<{
      id: string; name: string; phone: string | null; email: string | null;
      app_registered: boolean; opted_out: boolean; created_at: Date;
    }>(
      `SELECT id, name, phone, email, app_registered, opted_out, created_at
       FROM client cl
       WHERE business_id = $1 ${searchClause}
       ORDER BY name ASC
       LIMIT $2 OFFSET $3`,
      params,
    );

    res.json({ data: result.rows, limit, offset });
  } catch (err) { next(err); }
});

// POST /api/v1/clients — create client + send invite
router.post('/clients', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { businessId } = (req as StaffRequest).staff;
    const { name, phone, email } = req.body as { name?: string; phone?: string; email?: string };

    if (!name || name.trim().length === 0 || name.length > 100) {
      return next(createError('INVALID_INPUT', 'name is required (max 100 chars).', 400));
    }
    if (!phone && !email) {
      return next(createError('INVALID_INPUT', 'At least one of phone or email is required.', 400));
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return next(createError('INVALID_INPUT', 'email is not a valid address.', 400));
    }

    // Deduplication: name + email within business
    if (email) {
      const existing = await db.query<{ id: string }>(
        `SELECT id FROM client WHERE business_id = $1 AND name = $2 AND email = $3 LIMIT 1`,
        [businessId, name.trim(), email.toLowerCase()],
      );
      if (existing.rows[0]) {
        return next(createError('CLIENT_EXISTS', 'A client with this name and email already exists.', 409));
      }
    }

    const clientId = uuidv4();
    await db.query(
      `INSERT INTO client (id, business_id, name, phone, email) VALUES ($1, $2, $3, $4, $5)`,
      [clientId, businessId, name.trim(), phone ?? null, email ? email.toLowerCase() : null],
    );

    // Generate invite short code
    const shortCode = randomBytes(3).toString('hex').toUpperCase();
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
    await db.query(
      `INSERT INTO client_invite (id, client_id, business_id, short_code, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [uuidv4(), clientId, businessId, shortCode, expiresAt],
    );

    if (email) {
      const inviteUrl = `https://${env.APP_DOMAIN}/redeem?code=${shortCode}`;
      await sendClientInvite(email.toLowerCase(), inviteUrl);
    }

    res.status(201).json({ clientId, shortCode });
  } catch (err) { next(err); }
});

// GET /api/v1/clients/:id — client detail with last 5 appointments
router.get('/clients/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { businessId } = (req as StaffRequest).staff;
    const clientId = req.params.id;

    const clientResult = await db.query<{
      id: string; name: string; phone: string | null; email: string | null;
      app_registered: boolean; opted_out: boolean; created_at: Date;
    }>(
      `SELECT id, name, phone, email, app_registered, opted_out, created_at
       FROM client WHERE id = $1 AND business_id = $2 LIMIT 1`,
      [clientId, businessId],
    );

    if (!clientResult.rows[0]) return next(createError('NOT_FOUND', 'Client not found.', 404));

    const apptResult = await db.query<{
      id: string; starts_at: Date; service_type: string | null; status: string;
    }>(
      `SELECT a.id, a.starts_at, a.service_type, a.status
       FROM appointment a
       WHERE a.client_id = $1
       ORDER BY a.starts_at DESC
       LIMIT 5`,
      [clientId],
    );

    res.json({ ...clientResult.rows[0], appointments: apptResult.rows });
  } catch (err) { next(err); }
});

// PATCH /api/v1/clients/:id — edit client; opted_out=true cancels active conversations
router.patch('/clients/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { businessId } = (req as StaffRequest).staff;
    const clientId = req.params.id;
    const { name, phone, email, opted_out } = req.body as {
      name?: string; phone?: string; email?: string; opted_out?: boolean;
    };

    if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0 || name.length > 100)) {
      return next(createError('INVALID_INPUT', 'name must be a non-empty string (max 100 chars).', 400));
    }
    if (email !== undefined && email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return next(createError('INVALID_INPUT', 'email is not a valid address.', 400));
    }
    if (opted_out !== undefined && typeof opted_out !== 'boolean') {
      return next(createError('INVALID_INPUT', 'opted_out must be a boolean.', 400));
    }

    const client = await db.query<{ id: string }>(
      `SELECT id FROM client WHERE id = $1 AND business_id = $2 LIMIT 1`,
      [clientId, businessId],
    );
    if (!client.rows[0]) return next(createError('NOT_FOUND', 'Client not found.', 404));

    // Build SET clause from provided fields
    const updates: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (name      !== undefined) { updates.push(`name = $${idx++}`);      values.push(name.trim()); }
    if (phone     !== undefined) { updates.push(`phone = $${idx++}`);     values.push(phone); }
    if (email     !== undefined) { updates.push(`email = $${idx++}`);     values.push(email ? email.toLowerCase() : null); }
    if (opted_out !== undefined) { updates.push(`opted_out = $${idx++}`); values.push(opted_out); }

    if (updates.length === 0) {
      return next(createError('INVALID_INPUT', 'At least one field must be provided.', 400));
    }

    values.push(clientId, businessId);
    await db.query(
      `UPDATE client SET ${updates.join(', ')} WHERE id = $${idx++} AND business_id = $${idx}`,
      values,
    );

    // Cancel all active (non-terminal) conversations if opting out
    if (opted_out === true) {
      const TERMINAL = `('confirmed', 'cancelled', 'resolved', 'no_response')`;
      await db.query(
        `UPDATE conversation SET state = 'cancelled'
         WHERE client_id = $1 AND business_id = $2 AND state NOT IN ${TERMINAL}`,
        [clientId, businessId],
      );
    }

    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
