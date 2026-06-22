import express from 'express';
import request from 'supertest';
import schedulesRouter from '../routes/api/schedules';
import { errorHandler } from '../middleware/errorHandler';

// ─── Module mocks ─────────────────────────────────────────────────────────────

jest.mock('../db', () => ({ db: { query: jest.fn() } }));
jest.mock('../jobs/scheduler', () => ({ scheduleOutreach: jest.fn() }));

jest.mock('../auth/middleware', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.staff = { id: 'staff-1', businessId: 'biz-1', role: 'admin', canEditSchedule: true, canTriggerOutreach: true };
    next();
  },
  requirePermission: (_flag: string) => (_req: any, _res: any, next: any) => next(),
}));

import { db } from '../db';

const mockDbQuery = db.query as jest.Mock;

const app = express();
app.use(express.json());
app.use('/api/v1', schedulesRouter);
app.use(errorHandler);

beforeEach(() => jest.resetAllMocks());

// ─── GET /schedules ───────────────────────────────────────────────────────────

test('GET /schedules: returns paginated list with appointment_count', async () => {
  mockDbQuery.mockResolvedValueOnce({
    rows: [
      { id: 's-1', date: '2026-07-01', appointment_count: '3', created_at: new Date() },
      { id: 's-2', date: '2026-07-02', appointment_count: '0', created_at: new Date() },
    ],
  });

  const res = await request(app).get('/api/v1/schedules');

  expect(res.status).toBe(200);
  expect(res.body.data).toHaveLength(2);
  expect(res.body.data[0].appointment_count).toBe(3);
  expect(res.body.limit).toBe(20);
});

// ─── POST /schedules ──────────────────────────────────────────────────────────

test('POST /schedules: creates schedule with future date', async () => {
  const futureDate = '2099-12-31';
  mockDbQuery.mockResolvedValueOnce({ rows: [] }); // dedup check
  mockDbQuery.mockResolvedValueOnce({
    rows: [{ id: 's-new', date: futureDate, created_at: new Date() }],
  });

  const res = await request(app).post('/api/v1/schedules').send({ date: futureDate });

  expect(res.status).toBe(201);
  expect(res.body.date).toBe(futureDate);
  expect(res.body.id).toBe('s-new');
});

test('POST /schedules: 400 for past date', async () => {
  const res = await request(app).post('/api/v1/schedules').send({ date: '2000-01-01' });

  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe('INVALID_INPUT');
  expect(mockDbQuery).not.toHaveBeenCalled();
});

test('POST /schedules: 400 for invalid date format', async () => {
  const res = await request(app).post('/api/v1/schedules').send({ date: 'not-a-date' });

  expect(res.status).toBe(400);
  expect(mockDbQuery).not.toHaveBeenCalled();
});

test('POST /schedules: 409 when duplicate date exists', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 'existing-s' }] }); // dedup hit

  const res = await request(app).post('/api/v1/schedules').send({ date: '2099-12-31' });

  expect(res.status).toBe(409);
  expect(res.body.error.code).toBe('SCHEDULE_EXISTS');
});

// ─── GET /schedules/:id ───────────────────────────────────────────────────────

test('GET /schedules/:id: returns schedule with appointments and client names', async () => {
  mockDbQuery.mockResolvedValueOnce({
    rows: [{ id: 's-1', date: '2026-07-01', created_at: new Date() }],
  });
  mockDbQuery.mockResolvedValueOnce({
    rows: [
      { id: 'a-1', starts_at: new Date('2026-07-01T10:00:00Z'), service_type: 'Haircut', status: 'confirmed', client_id: 'c-1', client_name: 'Alice' },
      { id: 'a-2', starts_at: new Date('2026-07-01T11:00:00Z'), service_type: null, status: 'available', client_id: null, client_name: null },
    ],
  });

  const res = await request(app).get('/api/v1/schedules/s-1');

  expect(res.status).toBe(200);
  expect(res.body.date).toBe('2026-07-01');
  expect(res.body.appointments).toHaveLength(2);
  expect(res.body.appointments[0].client_name).toBe('Alice');
  expect(res.body.appointments[1].client_name).toBeNull();
});

test('GET /schedules/:id: 404 when not found', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [] });

  const res = await request(app).get('/api/v1/schedules/ghost');

  expect(res.status).toBe(404);
});

// ─── POST /schedules/:id/appointments ────────────────────────────────────────

test('POST /schedules/:id/appointments: creates available slot when no client_id', async () => {
  const startsAt = '2099-12-31T10:00:00Z';
  mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 's-1', date: '2099-12-31' }] }); // schedule exists
  mockDbQuery.mockResolvedValueOnce({
    rows: [{ id: 'a-new', starts_at: new Date(startsAt), service_type: 'Haircut', status: 'available', client_id: null }],
  });

  const res = await request(app)
    .post('/api/v1/schedules/s-1/appointments')
    .send({ starts_at: startsAt, service_type: 'Haircut' });

  expect(res.status).toBe(201);
  expect(res.body.status).toBe('available');
  expect(res.body.client_id).toBeNull();
});

test('POST /schedules/:id/appointments: creates pending-outreach slot when client_id provided', async () => {
  const startsAt = '2099-12-31T14:00:00Z';
  mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 's-1', date: '2099-12-31' }] }); // schedule exists
  mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 'c-1' }] }); // client exists
  mockDbQuery.mockResolvedValueOnce({
    rows: [{ id: 'a-new', starts_at: new Date(startsAt), service_type: null, status: 'pending-outreach', client_id: 'c-1' }],
  });

  const res = await request(app)
    .post('/api/v1/schedules/s-1/appointments')
    .send({ starts_at: startsAt, client_id: 'c-1' });

  expect(res.status).toBe(201);
  expect(res.body.status).toBe('pending-outreach');
  expect(res.body.client_id).toBe('c-1');
});

test('POST /schedules/:id/appointments: 400 when starts_at date mismatches schedule date', async () => {
  // Schedule date is 2099-12-31 but starts_at falls on 2099-12-30
  mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 's-1', date: '2099-12-31' }] });

  const res = await request(app)
    .post('/api/v1/schedules/s-1/appointments')
    .send({ starts_at: '2099-12-30T10:00:00Z' });

  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe('INVALID_INPUT');
});

test('POST /schedules/:id/appointments: 400 when starts_at missing', async () => {
  const res = await request(app)
    .post('/api/v1/schedules/s-1/appointments')
    .send({});

  expect(res.status).toBe(400);
  expect(mockDbQuery).not.toHaveBeenCalled();
});

test('POST /schedules/:id/appointments: 404 when schedule not found', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [] });

  const res = await request(app)
    .post('/api/v1/schedules/ghost/appointments')
    .send({ starts_at: '2099-12-31T10:00:00Z' });

  expect(res.status).toBe(404);
});

// ─── DELETE /schedules/:id/appointments/:apptId ───────────────────────────────

test('DELETE /schedules/:id/appointments/:apptId: deletes available appointment', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 'a-1', status: 'available' }] }); // lookup
  mockDbQuery.mockResolvedValueOnce({ rows: [] }); // DELETE

  const res = await request(app).delete('/api/v1/schedules/s-1/appointments/a-1');

  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
});

test('DELETE /schedules/:id/appointments/:apptId: 409 when appointment is not available', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 'a-1', status: 'confirmed' }] });

  const res = await request(app).delete('/api/v1/schedules/s-1/appointments/a-1');

  expect(res.status).toBe(409);
  expect(res.body.error.code).toBe('APPOINTMENT_ACTIVE');
});

test('DELETE /schedules/:id/appointments/:apptId: 404 when appointment not found', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [] });

  const res = await request(app).delete('/api/v1/schedules/s-1/appointments/ghost');

  expect(res.status).toBe(404);
});

// ─── PUT /appointments/:id ────────────────────────────────────────────────────

test('PUT /appointments/:id: updates starts_at only (no status change)', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 'a-1', status: 'available' }] }); // lookup
  mockDbQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE

  const res = await request(app)
    .put('/api/v1/appointments/a-1')
    .send({ starts_at: '2099-12-31T11:00:00Z' });

  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  const sql = mockDbQuery.mock.calls[1][0] as string;
  expect(sql).toContain('starts_at = $');
  expect(sql).not.toContain('status = $');
});

test('PUT /appointments/:id: assigning client_id sets status to pending-outreach', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 'a-1', status: 'available' }] }); // lookup appt
  mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 'c-1' }] }); // client exists
  mockDbQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE

  const res = await request(app)
    .put('/api/v1/appointments/a-1')
    .send({ client_id: 'c-1' });

  expect(res.status).toBe(200);
  const sql = mockDbQuery.mock.calls[2][0] as string;
  expect(sql).toContain('status = $');
  const vals = mockDbQuery.mock.calls[2][1] as unknown[];
  expect(vals).toContain('pending-outreach');
});

test('PUT /appointments/:id: setting client_id=null sets status to available', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 'a-1', status: 'pending-outreach' }] }); // lookup
  mockDbQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE

  const res = await request(app)
    .put('/api/v1/appointments/a-1')
    .send({ client_id: null });

  expect(res.status).toBe(200);
  const vals = mockDbQuery.mock.calls[1][1] as unknown[];
  expect(vals).toContain('available');
});

test('PUT /appointments/:id: 409 when appointment is in non-editable status', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 'a-1', status: 'ai-active' }] });

  const res = await request(app)
    .put('/api/v1/appointments/a-1')
    .send({ service_type: 'Cut' });

  expect(res.status).toBe(409);
  expect(res.body.error.code).toBe('APPOINTMENT_ACTIVE');
});

test('PUT /appointments/:id: 404 when appointment not found', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [] });

  const res = await request(app).put('/api/v1/appointments/ghost').send({ service_type: 'Cut' });

  expect(res.status).toBe(404);
});

test('PUT /appointments/:id: 400 when no fields provided', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 'a-1', status: 'available' }] });

  const res = await request(app).put('/api/v1/appointments/a-1').send({});

  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe('INVALID_INPUT');
});
