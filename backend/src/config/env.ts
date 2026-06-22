import 'dotenv/config';

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  PORT: parseInt(process.env.PORT ?? '3001', 10),
  DATABASE_URL: required('DATABASE_URL'),
  BOOTSTRAP_SECRET: required('BOOTSTRAP_SECRET'),
  JWT_SECRET: required('JWT_SECRET'),
  REDIS_URL: required('REDIS_URL'),
  GOOGLE_OAUTH_CLIENT_ID:     process.env.GOOGLE_OAUTH_CLIENT_ID ?? '',
  GOOGLE_OAUTH_CLIENT_SECRET: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '',
  GOOGLE_OAUTH_REDIRECT_URI:  process.env.GOOGLE_OAUTH_REDIRECT_URI ?? 'http://localhost:3001/api/v1/auth/google/callback',
  SENDGRID_API_KEY:           process.env.SENDGRID_API_KEY ?? '',
  APP_DOMAIN:                 process.env.APP_DOMAIN ?? 'localhost:3000',
  STAFF_APP_URL:              process.env.STAFF_APP_URL ?? 'http://localhost:3000',
  LLM_BASE_URL: required('LLM_BASE_URL'),
  LLM_API_KEY: required('LLM_API_KEY'),
  LLM_MODEL: required('LLM_MODEL'),
  BULL_CONCURRENCY: parseInt(process.env.BULL_CONCURRENCY ?? '10', 10),
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ?? 'http://localhost:3000',
  isProduction: process.env.NODE_ENV === 'production',
  isTest: process.env.NODE_ENV === 'test',
};
