import express from 'express';
import request from 'supertest';
import clientsRouter from '../routes/api/clients';
import { errorHandler } from '../middleware/errorHandler';

// ─── Module mocks ─────────────────────────────────────────────────────────────

jest.mock('../db', () => ({ db: { query: jest.fn() } }));
jest.mock('../services/email', () => ({ sendClientInvite: jest.fn() }));
jest.mock('../config/env', () => ({ env: { APP_DOMAIN: 'app.example.com' } }));

jest.mock('../auth/middleware', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.staff = { id: 'staff-1', businessId: 'biz-1', role: 'staff' };
    next();
  },
}));

import { db } from '../db';
import { sendClientInvite } from '../services/email';

const mockDbQuery   = db.query as jest.Mock;
const mockSendInvite = sendClientInvite as jest.Mock;

const app = express();
app.use(express.json());
app.use('/api/v1', clientsRouter);
app.use(errorHandler);

beforeEach(() => jest.resetAllMocks());

// ─── GET /clients ─────────────────────────────────────────────────────────────

test('GET /clients: returns paginated client list', async () => {
  mockDbQuery.mockResolvedValueOnce({
    rows: [
      { id: 'c-1', name: 'Alice', phone: null, email: 'alice@ex.com', app_registered: true, opted_out: false },
      { id: 'c-2', name: 'Bob',   phone: '+1555', email: null, app_registered: false, opted_out: false },
    ],
  });

  const res = await request(app).get('/api/v1/clients');

  expect(res.status).toBe(200);
  expect(res.body.data).toHaveLength(2);
  expect(res.body.limit).toBe(50);
});

test('GET /clients: search param included in SQL', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [] });

  await request(app).get('/api/v1/clients?search=alice');

  const sql = mockDbQuery.mock.calls[0][0] as string;
  expect(sql).toContain('ILIKE');
});

// ─── POST /clients ────────────────────────────────────────────────────────────

test('POST /clients: creates client, inserts invite, sends email', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [] }); // dedup check
  mockDbQuery.mockResolvedValueOnce({ rows: [] }); // INSERT client
  mockDbQuery.mockResolvedValueOnce({ rows: [] }); // INSERT client_invite
  mockSendInvite.mockResolvedValueOnce(undefined);

  const res = await request(app)
    .post('/api/v1/clients')
    .send({ name: 'Alice', email: 'alice@ex.com' });

  expect(res.status).toBe(201);
  expect(res.body.clientId).toBeDefined();
  expect(res.body.shortCode).toBeDefined();
  expect(res.body.shortCode).toMatch(/^[0-9A-F]{6}$/);
  expect(mockSendInvite).toHaveBeenCalledWith('alice@ex.com', expect.stringContaining('redeem'));
});

test('POST /clients: no email → invite not sent, shortCode still returned', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [] }); // INSERT client
  mockDbQuery.mockResolvedValueOnce({ rows: [] }); // INSERT client_invite

  const res = await request(app)
    .post('/api/v1/clients')
    .send({ name: 'Bob', phone: '+15551234567' });

  expect(res.status).toBe(201);
  expect(res.body.shortCode).toBeDefined();
  expect(mockSendInvite).not.toHaveBeenCalled();
});

test('POST /clients: 409 when name+email already exists', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 'existing-client' }] }); // dedup hit

  const res = await request(app)
    .post('/api/v1/clients')
    .send({ name: 'Alice', email: 'alice@ex.com' });

  expect(res.status).toBe(409);
  expect(res.body.error.code).toBe('CLIENT_EXISTS');
});

test('POST /clients: 400 when neither phone nor email provided', async () => {
  const res = await request(app).post('/api/v1/clients').send({ name: 'Alice' });

  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe('INVALID_INPUT');
  expect(mockDbQuery).not.toHaveBeenCalled();
});

test('POST /clients: 400 when name missing', async () => {
  const res = await request(app).post('/api/v1/clients').send({ email: 'x@ex.com' });

  expect(res.status).toBe(400);
});

test('POST /clients: 400 for invalid email format', async () => {
  const res = await request(app)
    .post('/api/v1/clients')
    .send({ name: 'Alice', email: 'not-an-email' });

  expect(res.status).toBe(400);
});

// ─── GET /clients/:id ─────────────────────────────────────────────────────────

test('GET /clients/:id: returns client detail with appointments', async () => {
  mockDbQuery.mockResolvedValueOnce({
    rows: [{ id: 'c-1', name: 'Alice', phone: null, email: 'alice@ex.com', app_registered: true, opted_out: false, created_at: new Date() }],
  });
  mockDbQuery.mockResolvedValueOnce({
    rows: [
      { id: 'a-1', starts_at: new Date('2026-07-01T10:00:00Z'), service_type: 'Haircut', status: 'confirmed' },
    ],
  });

  const res = await request(app).get('/api/v1/clients/c-1');

  expect(res.status).toBe(200);
  expect(res.body.name).toBe('Alice');
  expect(res.body.appointments).toHaveLength(1);
  expect(res.body.appointments[0].service_type).toBe('Haircut');
});

test('GET /clients/:id: 404 when not found', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [] });

  const res = await request(app).get('/api/v1/clients/ghost');

  expect(res.status).toBe(404);
});

// ─── PATCH /clients/:id ───────────────────────────────────────────────────────

test('PATCH /clients/:id: updates name and phone', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 'c-1' }] }); // client exists
  mockDbQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE

  const res = await request(app)
    .patch('/api/v1/clients/c-1')
    .send({ name: 'Alicia', phone: '+15559999' });

  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  const sql = mockDbQuery.mock.calls[1][0] as string;
  expect(sql).toContain('name = $');
  expect(sql).toContain('phone = $');
});

test('PATCH /clients/:id: opted_out=true cancels active conversations', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 'c-1' }] }); // client exists
  mockDbQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE client
  mockDbQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE conversations

  const res = await request(app)
    .patch('/api/v1/clients/c-1')
    .send({ opted_out: true });

  expect(res.status).toBe(200);
  const cancelSql = mockDbQuery.mock.calls[2][0] as string;
  expect(cancelSql).toContain("state = 'cancelled'");
  expect(cancelSql).toContain('state NOT IN');
});

test('PATCH /clients/:id: opted_out=false does NOT cancel conversations', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 'c-1' }] });
  mockDbQuery.mockResolvedValueOnce({ rows: [] });

  await request(app).patch('/api/v1/clients/c-1').send({ opted_out: false });

  expect(mockDbQuery).toHaveBeenCalledTimes(2); // no conversation cancel
});

test('PATCH /clients/:id: 404 when client not found', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [] });

  const res = await request(app).patch('/api/v1/clients/ghost').send({ name: 'X' });

  expect(res.status).toBe(404);
});

test('PATCH /clients/:id: 400 when no fields provided', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 'c-1' }] });

  const res = await request(app).patch('/api/v1/clients/c-1').send({});

  expect(res.status).toBe(400);
});
