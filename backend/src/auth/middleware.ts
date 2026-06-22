import { Request, Response, NextFunction } from 'express';
import { verifyStaffToken, TokenExpiredError, JsonWebTokenError } from './tokens';
import { createError } from '../middleware/errorHandler';

export interface StaffRequest extends Request {
  staff: {
    id: string;
    businessId: string;
    role: 'admin' | 'staff' | 'viewer';
    canTriggerOutreach: boolean;
    canEditSchedule: boolean;
  };
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers['authorization'];
  if (!header?.startsWith('Bearer ')) {
    return next(createError('UNAUTHORIZED', 'Missing access token.', 401));
  }

  const token = header.slice(7);
  try {
    const claims = verifyStaffToken(token);
    const c = claims as any;
    (req as StaffRequest).staff = {
      id:                  claims.sub,
      businessId:          claims.businessId,
      role:                claims.role,
      canTriggerOutreach:  c.can_trigger_outreach ?? false,
      canEditSchedule:     c.can_edit_schedule ?? false,
    };
    next();
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      return next(createError('TOKEN_EXPIRED', 'Access token expired.', 401));
    }
    if (err instanceof JsonWebTokenError) {
      return next(createError('INVALID_TOKEN', 'Invalid access token.', 401));
    }
    next(err);
  }
}

export function requireRole(...roles: Array<'admin' | 'staff' | 'viewer'>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const { role } = (req as StaffRequest).staff;
    if (!roles.includes(role)) {
      return next(createError('FORBIDDEN', 'You do not have permission to perform this action.', 403));
    }
    next();
  };
}

export function requirePermission(flag: 'canTriggerOutreach' | 'canEditSchedule') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const staff = (req as StaffRequest).staff;
    // Admin always passes
    if (staff.role === 'admin') return next();
    if (!staff[flag]) {
      return next(createError('FORBIDDEN', 'You do not have permission to perform this action.', 403));
    }
    next();
  };
}
