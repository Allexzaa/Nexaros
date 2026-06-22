import { Response } from 'express';
import { env } from '../config/env';

export const REFRESH_COOKIE = 'refresh_token';
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: 'strict',
    maxAge: REFRESH_TTL_MS,
    path: '/',
  });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, { httpOnly: true, secure: env.isProduction, sameSite: 'strict', path: '/' });
}
