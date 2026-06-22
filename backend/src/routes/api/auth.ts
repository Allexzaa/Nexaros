import { Router, Request, Response, NextFunction } from 'express';
import { compare, hash } from 'bcryptjs';
import { randomBytes } from 'crypto';
import { db } from '../../db';
import { createError } from '../../middleware/errorHandler';
import { authRateLimiter } from '../../middleware/rateLimiter';
import { issueStaffAccessToken, refreshTokenExpiresAt, verifyStaffToken, TokenExpiredError, JsonWebTokenError } from '../../auth/tokens';
import { setRefreshCookie, clearRefreshCookie, REFRESH_COOKIE } from '../../auth/cookies';
import { requireAuth, StaffRequest } from '../../auth/middleware';

const router = Router();

// POST /api/v1/auth/login
router.post('/auth/login', authRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) {
      return next(createError('INVALID_INPUT', 'email and password are required.', 400));
    }

    const result = await db.query<{
      id: string; business_id: string; role: string;
      can_trigger_outreach: boolean; can_edit_schedule: boolean; password_hash: string | null;
    }>(
      `SELECT id, business_id, role, can_trigger_outreach, can_edit_schedule, password_hash
       FROM staff_user WHERE email = $1 LIMIT 1`,
      [email.toLowerCase().trim()],
    );

    const user = result.rows[0];
    if (!user || !user.password_hash || user.role === 'deactivated') {
      return next(createError('INVALID_CREDENTIALS', 'Invalid email or password.', 401));
    }

    const valid = await compare(password, user.password_hash);
    if (!valid) {
      return next(createError('INVALID_CREDENTIALS', 'Invalid email or password.', 401));
    }

    const accessToken = issueStaffAccessToken({
      sub: user.id,
      businessId: user.business_id,
      role: user.role as 'admin' | 'staff' | 'viewer',
      can_trigger_outreach: user.can_trigger_outreach,
      can_edit_schedule: user.can_edit_schedule,
    });

    const rawRefresh = randomBytes(48).toString('hex');
    const refreshHash = await hash(rawRefresh, 10);
    const expiresAt = refreshTokenExpiresAt();

    await db.query(
      'UPDATE staff_user SET refresh_token_hash = $1, refresh_token_expires_at = $2 WHERE id = $3',
      [refreshHash, expiresAt, user.id],
    );

    setRefreshCookie(res, rawRefresh);
    res.json({ accessToken });
  } catch (err) { next(err); }
});

// POST /api/v1/auth/refresh
router.post('/auth/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawRefresh = req.cookies?.[REFRESH_COOKIE];
    if (!rawRefresh) return next(createError('UNAUTHORIZED', 'No refresh token.', 401));

    // We need to find which user owns this token — we store a hash so we must
    // look up candidates by checking expiry first, then verify hash
    const result = await db.query<{
      id: string; business_id: string; role: string;
      can_trigger_outreach: boolean; can_edit_schedule: boolean;
      refresh_token_hash: string | null; refresh_token_expires_at: Date | null;
    }>(
      `SELECT id, business_id, role, can_trigger_outreach, can_edit_schedule,
              refresh_token_hash, refresh_token_expires_at
       FROM staff_user
       WHERE refresh_token_hash IS NOT NULL AND refresh_token_expires_at > now()`,
    );

    let matched: typeof result.rows[0] | null = null;
    for (const row of result.rows) {
      if (row.refresh_token_hash && await compare(rawRefresh, row.refresh_token_hash)) {
        matched = row;
        break;
      }
    }

    if (!matched) return next(createError('UNAUTHORIZED', 'Invalid or expired refresh token.', 401));

    // Rotate refresh token
    const newRaw = randomBytes(48).toString('hex');
    const newHash = await hash(newRaw, 10);
    const expiresAt = refreshTokenExpiresAt();

    await db.query(
      'UPDATE staff_user SET refresh_token_hash = $1, refresh_token_expires_at = $2 WHERE id = $3',
      [newHash, expiresAt, matched.id],
    );

    const accessToken = issueStaffAccessToken({
      sub: matched.id,
      businessId: matched.business_id,
      role: matched.role as 'admin' | 'staff' | 'viewer',
      can_trigger_outreach: matched.can_trigger_outreach,
      can_edit_schedule: matched.can_edit_schedule,
    });

    setRefreshCookie(res, newRaw);
    res.json({ accessToken });
  } catch (err) { next(err); }
});

// POST /api/v1/auth/logout
router.post('/auth/logout', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawRefresh = req.cookies?.[REFRESH_COOKIE];
    if (rawRefresh) {
      // Best-effort: clear token for whichever user owns it
      const result = await db.query<{ id: string; refresh_token_hash: string | null }>(
        'SELECT id, refresh_token_hash FROM staff_user WHERE refresh_token_hash IS NOT NULL',
      );
      for (const row of result.rows) {
        if (row.refresh_token_hash && await compare(rawRefresh, row.refresh_token_hash)) {
          await db.query(
            'UPDATE staff_user SET refresh_token_hash = null, refresh_token_expires_at = null WHERE id = $1',
            [row.id],
          );
          break;
        }
      }
    }
    clearRefreshCookie(res);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// GET /api/v1/auth/me
router.get('/auth/me', requireAuth, (req: Request, res: Response) => {
  const { staff } = req as StaffRequest;
  res.json(staff);
});

export default router;
