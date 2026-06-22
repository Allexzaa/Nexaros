import { Router } from 'express';
import { db } from '../db';

const router = Router();

router.get('/health', async (_req, res, next) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    next(err);
  }
});

export default router;
