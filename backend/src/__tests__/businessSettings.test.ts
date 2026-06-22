import express from 'express';
import request from 'supertest';
import businessRouter from '../routes/api/business';
import { errorHandler } from '../middleware/errorHandler';

// ─── Module mocks ─────────────────────────────────────────────────────────────

jest.mock('../db', () => ({ db: { query: jest.fn() } }));

jest.mock('../auth/middleware', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.staff = { id: 'staff-1', businessId: 'biz-1', role: 'admin' };
    next();
  },
  requireRole: (..._roles: string[]) => (_req: any, _res: any, next: any) => next(),
}));

import { db } from '../db';
const mockDbQuery = db.query as jest.Mock;

const app = express();
app.use(express.json());
app.use('/api/v1', businessRouter);
app.use(errorHandler);

beforeEach(() => jest.resetAllMocks());

// ─── GET /business/settings ───────────────────────────────────────────────────

test('GET /business/settings: returns name and settings', async () => {
  mockDbQuery.mockResolvedValueOnce({
    rows: [{
      name: 'Test Salon',
      settings: {
        outreach_response_window_hours: 24,
        outreach_hours_start: '09:00',
        outreach_hours_end: '18:00',
        auto_pickup_interval_minutes: 5,
        escalation_keywords: [],
        booking_approval_timeout_hours: 2,
      },
    }],
  });

  const res = await request(app).get('/api/v1/business/settings');

  expect(res.status).toBe(200);
  expect(res.body.name).toBe('Test Salon');
  expect(res.body.settings.outreach_response_window_hours).toBe(24);
});

// ─── PATCH /business/settings ─────────────────────────────────────────────────

test('PATCH /business/settings: updates name only', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [] });

  const res = await request(app).patch('/api/v1/business/settings').send({ name: 'New Salon' });

  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(mockDbQuery).toHaveBeenCalledWith(
    expect.stringContaining('SET name'),
    ['New Salon', 'biz-1'],
  );
});

test('PATCH /business/settings: updates settings fields via JSONB merge', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [] });

  const res = await request(app)
    .patch('/api/v1/business/settings')
    .send({ outreach_response_window_hours: 48, escalation_keywords: ['urgent', 'help'] });

  expect(res.status).toBe(200);
  const sql = mockDbQuery.mock.calls[0][0] as string;
  expect(sql).toContain('settings || $1::jsonb');
  const patch = JSON.parse(mockDbQuery.mock.calls[0][1][0] as string);
  expect(patch.outreach_response_window_hours).toBe(48);
  expect(patch.escalation_keywords).toEqual(['urgent', 'help']);
});

test('PATCH /business/settings: updates both name and settings in one query', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [] });

  const res = await request(app)
    .patch('/api/v1/business/settings')
    .send({ name: 'Renamed', auto_pickup_interval_minutes: 10 });

  expect(res.status).toBe(200);
  const sql = mockDbQuery.mock.calls[0][0] as string;
  expect(sql).toContain('name = $1');
  expect(sql).toContain('settings || $2::jsonb');
});

test('PATCH /business/settings: rejects outreach_hours_start >= end', async () => {
  const res = await request(app)
    .patch('/api/v1/business/settings')
    .send({ outreach_hours_start: '18:00', outreach_hours_end: '09:00' });

  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe('INVALID_INPUT');
});

test('PATCH /business/settings: rejects window_hours out of range', async () => {
  const res = await request(app)
    .patch('/api/v1/business/settings')
    .send({ outreach_response_window_hours: 200 });

  expect(res.status).toBe(400);
});

test('PATCH /business/settings: rejects empty escalation_keywords item', async () => {
  const res = await request(app)
    .patch('/api/v1/business/settings')
    .send({ escalation_keywords: ['valid', ''] });

  expect(res.status).toBe(400);
});

test('PATCH /business/settings: rejects empty body', async () => {
  const res = await request(app).patch('/api/v1/business/settings').send({});

  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe('INVALID_INPUT');
});
