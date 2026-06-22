import { Request, Response, NextFunction } from 'express';

export interface AppError extends Error {
  statusCode?: number;
  code?: string;
}

export function createError(code: string, message: string, statusCode = 400): AppError {
  const err: AppError = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: AppError, _req: Request, res: Response, _next: NextFunction): void {
  const statusCode = err.statusCode ?? 500;
  const code = err.code ?? 'INTERNAL_ERROR';
  const message = statusCode === 500 ? 'An unexpected error occurred.' : err.message;

  if (statusCode === 500) console.error(err);

  res.status(statusCode).json({ error: { code, message } });
}
