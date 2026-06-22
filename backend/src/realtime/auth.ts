import { verify, JsonWebTokenError } from 'jsonwebtoken';
import { env } from '../config/env';
import { TokenPayload } from './types';

export function verifyWsToken(authHeader: string | undefined): TokenPayload | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  try {
    return verify(token, env.JWT_SECRET) as TokenPayload;
  } catch (err) {
    if (err instanceof JsonWebTokenError) return null;
    throw err;
  }
}
