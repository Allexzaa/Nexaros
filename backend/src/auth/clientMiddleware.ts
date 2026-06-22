import { Request, Response, NextFunction } from 'express';
import { verifyClientToken, JsonWebTokenError } from './tokens';
import { db } from '../db';
import { createError } from '../middleware/errorHandler';

export interface ClientRequest extends Request {
  client: {
    id: string;
    businessId: string;
    sessionVersion: number;
  };
}

export async function requireClientAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers['authorization'];
  if (!header?.startsWith('Bearer ')) {
    return next(createError('UNAUTHORIZED', 'Missing access token.', 401));
  }

  const token = header.slice(7);
  try {
    const claims = verifyClientToken(token);

    // Check session version against DB
    const result = await db.query<{ session_version: number }>(
      'SELECT session_version FROM client WHERE id = $1 AND business_id = $2 LIMIT 1',
      [claims.sub, claims.businessId],
    );

    if (!result.rows[0]) {
      return next(createError('UNAUTHORIZED', 'Client not found.', 401));
    }

    if (result.rows[0].session_version !== claims.session_version) {
      return next(createError('SESSION_EXPIRED', 'Your session has expired. Please check your email for a new invite.', 401));
    }

    (req as ClientRequest).client = {
      id: claims.sub,
      businessId: claims.businessId,
      sessionVersion: claims.session_version,
    };
    next();
  } catch (err) {
    if (err instanceof JsonWebTokenError) {
      return next(createError('INVALID_TOKEN', 'Invalid access token.', 401));
    }
    next(err);
  }
}
