import express from 'express';
import request from 'supertest';
import staffRouter from '../routes/api/staff';
import { errorHandler } from '../middleware/errorHandler';

// ─── Module mocks ─────────────────────────────────────────────────────────────

jest.mock('../db', () => ({ db: { query: jest.fn() } }));

jest.mock('../auth/middleware', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.staff = { id: 'admin-1', businessId: 'biz-1', role: 'admin' };
    next();
  },
  requireRole: (..._roles: string[]) => (_req: any, _res: any, next: any) => next(),
}));

import { db } from '../db';
const mockDbQuery = db.query as jest.Mock;

const app = express();
app.use(express.json());
app.use('/api/v1', staffRouter);
app.use(errorHandler);

beforeEach(() => jest.resetAllMocks());

// ─── PATCH /staff/:id/role ────────────────────────────────────────────────────

test('PATCH /staff/:id/role: changes role to staff', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 'staff-2', role: 'viewer' }] }); // SELECT
  mockDbQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE

  const res = await request(app).patch('/api/v1/staff/staff-2/role').send({ role: 'staff' });

  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(mockDbQuery).toHaveBeenCalledWith(
    expect.stringContaining('SET role'),
    ['staff', 'staff-2'],
  );
});

test('PATCH /staff/:id/role: setting viewer clears permissions', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 'staff-2', role: 'staff' }] });
  mockDbQuery.mockResolvedValueOnce({ rows: [] });

  const res = await request(app).patch('/api/v1/staff/staff-2/role').send({ role: 'viewer' });

  expect(res.status).toBe(200);
  const updateSql = mockDbQuery.mock.calls[1][0] as string;
  expect(updateSql).toContain('can_trigger_outreach = false');
  expect(updateSql).toContain('can_edit_schedule = false');
});

test('PATCH /staff/:id/role: 403 when changing own role', async () => {
  const res = await request(app).patch('/api/v1/staff/admin-1/role').send({ role: 'staff' });

  expect(res.status).toBe(403);
  expect(res.body.error.code).toBe('FORBIDDEN');
  expect(mockDbQuery).not.toHaveBeenCalled();
});

test('PATCH /staff/:id/role: 404 when staff not found', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [] });

  const res = await request(app).patch('/api/v1/staff/ghost/role').send({ role: 'staff' });

  expect(res.status).toBe(404);
});

test('PATCH /staff/:id/role: 403 cannot change role of deactivated account', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 'staff-2', role: 'deactivated' }] });

  const res = await request(app).patch('/api/v1/staff/staff-2/role').send({ role: 'staff' });

  expect(res.status).toBe(403);
});

test('PATCH /staff/:id/role: 400 for invalid role value', async () => {
  const res = await request(app).patch('/api/v1/staff/staff-2/role').send({ role: 'superuser' });

  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe('INVALID_INPUT');
});

// ─── DELETE /staff/:id ────────────────────────────────────────────────────────

test('DELETE /staff/:id: soft-deletes staff, clears tokens', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 'staff-2' }] }); // SELECT
  mockDbQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE

  const res = await request(app).delete('/api/v1/staff/staff-2');

  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  const updateSql = mockDbQuery.mock.calls[1][0] as string;
  expect(updateSql).toContain("role = 'deactivated'");
  expect(updateSql).toContain('refresh_token_hash = NULL');
  expect(updateSql).toContain('invite_token_hash = NULL');
});

test('DELETE /staff/:id: 403 when deactivating own account', async () => {
  const res = await request(app).delete('/api/v1/staff/admin-1');

  expect(res.status).toBe(403);
  expect(res.body.error.code).toBe('FORBIDDEN');
  expect(mockDbQuery).not.toHaveBeenCalled();
});

test('DELETE /staff/:id: 404 when staff not found', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [] });

  const res = await request(app).delete('/api/v1/staff/ghost');

  expect(res.status).toBe(404);
});
