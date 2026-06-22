import 'dotenv/config';
import { Pool } from 'pg';
import { hash } from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';

if (process.env.NODE_ENV === 'production') {
  console.log('Seed script is disabled in production.');
  process.exit(0);
}

const businessName = process.env.SEED_BUSINESS_NAME;
const adminEmail = process.env.SEED_ADMIN_EMAIL;
const adminPassword = process.env.SEED_ADMIN_PASSWORD;

if (!businessName || !adminEmail || !adminPassword) {
  console.error('Missing SEED_BUSINESS_NAME, SEED_ADMIN_EMAIL, or SEED_ADMIN_PASSWORD.');
  process.exit(1);
}

const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function seed(): Promise<void> {
  const existing = await db.query('SELECT id FROM business WHERE name = $1 LIMIT 1', [businessName]);
  if (existing.rowCount && existing.rowCount > 0) {
    console.log(`Business "${businessName}" already exists — skipping seed.`);
    return;
  }

  const businessId = uuidv4();
  const adminId = uuidv4();
  const passwordHash = await hash(adminPassword!, 12);

  await db.query('BEGIN');
  try {
    await db.query(
      `INSERT INTO business (id, name, plan, timezone, settings) VALUES ($1, $2, 'free', 'America/Los_Angeles', '{}')`,
      [businessId, businessName],
    );
    await db.query(
      `INSERT INTO staff_user (id, business_id, email, role, password_hash) VALUES ($1, $2, $3, 'admin', $4)`,
      [adminId, businessId, adminEmail, passwordHash],
    );
    await db.query('COMMIT');
    console.log(`Seeded business "${businessName}" (${businessId}) and admin "${adminEmail}" (${adminId}).`);
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

seed()
  .catch((err: Error) => {
    console.error('Seed failed:', err.message);
    process.exit(1);
  })
  .finally(() => db.end());
