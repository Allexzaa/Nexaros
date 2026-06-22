import { Pool } from 'pg';
import { env } from '../config/env';

export const db = new Pool({ connectionString: env.DATABASE_URL });

db.on('error', (err) => {
  console.error('Unexpected database error:', err);
});
