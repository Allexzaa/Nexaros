import { Router, Request, Response, NextFunction } from 'express';
import { hash } from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../db';
import { env } from '../../config/env';
import { createError } from '../../middleware/errorHandler';

const router = Router();

router.post('/internal/bootstrap', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const secret = req.headers['x-bootstrap-secret'];
    if (!secret || secret !== env.BOOTSTRAP_SECRET) {
      return next(createError('UNAUTHORIZED', 'Invalid or missing bootstrap secret.', 401));
    }

    const { businessName, adminEmail, adminPassword } = req.body as {
      businessName?: string;
      adminEmail?: string;
      adminPassword?: string;
    };

    if (!businessName || !adminEmail || !adminPassword) {
      return next(createError('INVALID_INPUT', 'businessName, adminEmail, and adminPassword are required.', 400));
    }

    const existing = await db.query('SELECT id FROM business LIMIT 1');
    if (existing.rowCount && existing.rowCount > 0) {
      return next(createError('ALREADY_EXISTS', 'A business already exists. Bootstrap is a one-time operation.', 409));
    }

    const businessId = uuidv4();
    const adminId = uuidv4();
    const passwordHash = await hash(adminPassword, 12);

    await db.query('BEGIN');
    try {
      await db.query(
        `INSERT INTO business (id, name, plan, timezone, settings)
         VALUES ($1, $2, 'free', 'UTC', '{}')`,
        [businessId, businessName],
      );

      await db.query(
        `INSERT INTO staff_user (id, business_id, email, role, password_hash)
         VALUES ($1, $2, $3, 'admin', $4)`,
        [adminId, businessId, adminEmail, passwordHash],
      );

      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }

    res.status(201).json({ businessId, adminId });
  } catch (err) {
    next(err);
  }
});

export default router;
