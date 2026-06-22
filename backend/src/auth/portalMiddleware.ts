import { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { createError } from '../middleware/errorHandler';

// Extended ClientRequest for portal (cookie-based) sessions
export interface PortalRequest extends Request {
  client: {
    clientId: string;
    businessId: string;
  };
}

export async function requirePortalAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies?.client_session;
  if (!token) {
    return next(createError('UNAUTHORIZED', 'Not logged in.', 401));
  }

  const result = await db.query<{ client_id: string; business_id: string; expires_at: Date }>(
    `SELECT client_id, business_id, expires_at FROM client_session WHERE session_token = $1 LIMIT 1`,
    [token],
  ).catch(() => ({ rows: [] as any[] }));

  const session = result.rows[0];
  if (!session) return next(createError('UNAUTHORIZED', 'Session not found. Please log in again.', 401));
  if (new Date() > new Date(session.expires_at)) {
    await db.query(`DELETE FROM client_session WHERE session_token = $1`, [token]).catch(() => {});
    return next(createError('SESSION_EXPIRED', 'Session expired. Please log in again.', 401));
  }

  (req as PortalRequest).client = {
    clientId:   session.client_id,
    businessId: session.business_id,
  };
  next();
}
