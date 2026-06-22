import { Router, Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';
import { hash, compare } from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../db';
import { requireAuth, requireRole, StaffRequest } from '../../auth/middleware';
import { authRateLimiter } from '../../middleware/rateLimiter';
import { createError } from '../../middleware/errorHandler';
import { env } from '../../config/env';
import { sendStaffInvite, sendPasswordReset } from '../../services/email';

const router = Router();

// POST /api/v1/staff/invite — Admin only
router.post(
  '/staff/invite',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { businessId } = (req as StaffRequest).staff;
      const { email, role } = req.body as { email?: string; role?: string };

      if (!email || !role) {
        return next(createError('INVALID_INPUT', 'email and role are required.', 400));
      }
      if (!['admin', 'staff', 'viewer'].includes(role)) {
        return next(createError('INVALID_INPUT', 'role must be admin, staff, or viewer.', 400));
      }

      // Prevent duplicate accounts
      const existing = await db.query(
        'SELECT id FROM staff_user WHERE email = $1 AND business_id = $2 LIMIT 1',
        [email.toLowerCase(), businessId],
      );
      if (existing.rows[0]) {
        return next(createError('ALREADY_EXISTS', 'A staff account with this email already exists.', 409));
      }

      const rawToken = randomBytes(48).toString('hex');
      const tokenHash = await hash(rawToken, 10);
      const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
      const staffId = uuidv4();

      await db.query(
        `INSERT INTO staff_user (id, business_id, email, role, invite_token_hash, invite_token_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [staffId, businessId, email.toLowerCase(), role, tokenHash, expiresAt],
      );

      const inviteUrl = `${env.STAFF_APP_URL}/accept-invite?token=${rawToken}&id=${staffId}`;
      await sendStaffInvite(email, inviteUrl);

      res.status(201).json({ staffId });
    } catch (err) { next(err); }
  },
);

// POST /api/v1/auth/accept-invite — public
router.post('/auth/accept-invite', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, staffId, password } = req.body as { token?: string; staffId?: string; password?: string };

    if (!token || !staffId || !password) {
      return next(createError('INVALID_INPUT', 'token, staffId, and password are required.', 400));
    }
    if (password.length < 8) {
      return next(createError('INVALID_INPUT', 'Password must be at least 8 characters.', 400));
    }

    const result = await db.query<{
      id: string; invite_token_hash: string | null; invite_token_expires_at: Date | null; password_hash: string | null;
    }>(
      'SELECT id, invite_token_hash, invite_token_expires_at, password_hash FROM staff_user WHERE id = $1 LIMIT 1',
      [staffId],
    );

    const user = result.rows[0];
    if (!user || !user.invite_token_hash) {
      return next(createError('INVALID_TOKEN', 'Invalid or already used invite link.', 400));
    }
    if (!user.invite_token_expires_at || user.invite_token_expires_at < new Date()) {
      return next(createError('TOKEN_EXPIRED', 'Invite link has expired. Ask your admin to resend.', 400));
    }
    const valid = await compare(token, user.invite_token_hash);
    if (!valid) {
      return next(createError('INVALID_TOKEN', 'Invalid invite link.', 400));
    }

    const passwordHash = await hash(password, 12);
    await db.query(
      'UPDATE staff_user SET password_hash = $1, invite_token_hash = NULL, invite_token_expires_at = NULL WHERE id = $2',
      [passwordHash, staffId],
    );

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/v1/auth/forgot-password — rate-limited, public
router.post('/auth/forgot-password', authRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = req.body as { email?: string };
    if (!email) return next(createError('INVALID_INPUT', 'email is required.', 400));

    // Always return 200 to avoid email enumeration
    const result = await db.query<{ id: string }>(
      'SELECT id FROM staff_user WHERE email = $1 AND password_hash IS NOT NULL LIMIT 1',
      [email.toLowerCase()],
    );

    if (result.rows[0]) {
      const rawToken = randomBytes(48).toString('hex');
      const tokenHash = await hash(rawToken, 10);
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await db.query(
        'UPDATE staff_user SET password_reset_token_hash = $1, password_reset_token_expires_at = $2 WHERE id = $3',
        [tokenHash, expiresAt, result.rows[0].id],
      );

      const resetUrl = `${env.STAFF_APP_URL}/reset-password?token=${rawToken}&id=${result.rows[0].id}`;
      await sendPasswordReset(email, resetUrl);
    }

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/v1/auth/reset-password — public
router.post('/auth/reset-password', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, staffId, password } = req.body as { token?: string; staffId?: string; password?: string };

    if (!token || !staffId || !password) {
      return next(createError('INVALID_INPUT', 'token, staffId, and password are required.', 400));
    }
    if (password.length < 8) {
      return next(createError('INVALID_INPUT', 'Password must be at least 8 characters.', 400));
    }

    const result = await db.query<{
      id: string; password_reset_token_hash: string | null; password_reset_token_expires_at: Date | null;
    }>(
      'SELECT id, password_reset_token_hash, password_reset_token_expires_at FROM staff_user WHERE id = $1 LIMIT 1',
      [staffId],
    );

    const user = result.rows[0];
    if (!user || !user.password_reset_token_hash) {
      return next(createError('INVALID_TOKEN', 'Invalid or expired reset link.', 400));
    }
    if (!user.password_reset_token_expires_at || user.password_reset_token_expires_at < new Date()) {
      return next(createError('TOKEN_EXPIRED', 'Reset link has expired. Please request a new one.', 400));
    }
    const valid = await compare(token, user.password_reset_token_hash);
    if (!valid) {
      return next(createError('INVALID_TOKEN', 'Invalid reset link.', 400));
    }

    const passwordHash = await hash(password, 12);
    // Invalidate all existing refresh tokens by clearing them
    await db.query(
      `UPDATE staff_user
       SET password_hash = $1,
           password_reset_token_hash = NULL,
           password_reset_token_expires_at = NULL,
           refresh_token_hash = NULL,
           refresh_token_expires_at = NULL
       WHERE id = $2`,
      [passwordHash, staffId],
    );

    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
