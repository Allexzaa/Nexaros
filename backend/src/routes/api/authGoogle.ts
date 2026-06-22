import { Router, Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';
import { hash } from 'bcryptjs';
import { db } from '../../db';
import { getAuthUrl, getGoogleProfile } from '../../auth/google';
import { issueStaffAccessToken, refreshTokenExpiresAt } from '../../auth/tokens';
import { setRefreshCookie } from '../../auth/cookies';
import { createError } from '../../middleware/errorHandler';
import { env } from '../../config/env';

const router = Router();

// GET /api/v1/auth/google — redirect to Google consent screen
router.get('/auth/google', (_req: Request, res: Response) => {
  if (!env.GOOGLE_OAUTH_CLIENT_ID) {
    return res.status(503).json({ error: { code: 'SSO_NOT_CONFIGURED', message: 'Google SSO is not configured on this server.' } });
  }
  res.redirect(getAuthUrl());
});

// GET /api/v1/auth/google/callback — handle OAuth2 response
router.get('/auth/google/callback', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code, error } = req.query as { code?: string; error?: string };

    if (error || !code) {
      return res.redirect(`${env.STAFF_APP_URL}/login?error=google_denied`);
    }

    const profile = await getGoogleProfile(code);

    // Only allow SSO for existing accounts (Admin must invite first)
    const result = await db.query<{
      id: string; business_id: string; role: string;
      can_trigger_outreach: boolean; can_edit_schedule: boolean; google_id: string | null;
    }>(
      `SELECT id, business_id, role, can_trigger_outreach, can_edit_schedule, google_id
       FROM staff_user WHERE email = $1 LIMIT 1`,
      [profile.email.toLowerCase()],
    );

    const user = result.rows[0];
    if (!user) {
      return res.redirect(`${env.STAFF_APP_URL}/login?error=google_no_account`);
    }

    // Link Google ID on first SSO login
    if (!user.google_id) {
      await db.query('UPDATE staff_user SET google_id = $1 WHERE id = $2', [profile.sub, user.id]);
    }

    const accessToken = issueStaffAccessToken({
      sub: user.id, businessId: user.business_id,
      role: user.role as 'admin' | 'staff' | 'viewer',
      can_trigger_outreach: user.can_trigger_outreach,
      can_edit_schedule: user.can_edit_schedule,
    });

    const rawRefresh = randomBytes(48).toString('hex');
    const refreshHash = await hash(rawRefresh, 10);
    await db.query(
      'UPDATE staff_user SET refresh_token_hash = $1, refresh_token_expires_at = $2 WHERE id = $3',
      [refreshHash, refreshTokenExpiresAt(), user.id],
    );

    setRefreshCookie(res, rawRefresh);
    // Redirect staff web app with token in URL fragment (never in query string)
    res.redirect(`${env.STAFF_APP_URL}/auth/callback#token=${accessToken}`);
  } catch (err) {
    next(err);
  }
});

export default router;
