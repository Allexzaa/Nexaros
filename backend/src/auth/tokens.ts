import { sign, verify, JsonWebTokenError, TokenExpiredError } from 'jsonwebtoken';
import { env } from '../config/env';
import { StaffTokenPayload, ClientTokenPayload } from '../realtime/types';

const STAFF_ACCESS_TTL  = 5 * 60;       // 5 minutes
const REFRESH_TTL_DAYS  = 30;

export interface StaffAccessClaims extends StaffTokenPayload {
  exp: number;
}

export interface ClientAccessClaims extends ClientTokenPayload {
  session_version: number;
}

export interface StaffTokenInput {
  sub: string;
  businessId: string;
  role: 'admin' | 'staff' | 'viewer';
  can_trigger_outreach: boolean;
  can_edit_schedule: boolean;
}

export function issueStaffAccessToken(payload: StaffTokenInput): string {
  return sign({ ...payload, type: 'staff' }, env.JWT_SECRET, { expiresIn: STAFF_ACCESS_TTL });
}

export function issueClientToken(clientId: string, businessId: string, sessionVersion: number): string {
  // No expiry — session controlled via session_version
  return sign(
    { sub: clientId, businessId, type: 'client', session_version: sessionVersion },
    env.JWT_SECRET,
  );
}

export function verifyStaffToken(token: string): StaffAccessClaims {
  return verify(token, env.JWT_SECRET) as StaffAccessClaims;
}

export function verifyClientToken(token: string): ClientAccessClaims {
  return verify(token, env.JWT_SECRET) as ClientAccessClaims;
}

export function refreshTokenExpiresAt(): Date {
  const d = new Date();
  d.setDate(d.getDate() + REFRESH_TTL_DAYS);
  return d;
}

export { JsonWebTokenError, TokenExpiredError };
