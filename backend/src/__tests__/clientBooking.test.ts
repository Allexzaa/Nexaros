import express from 'express';
import request from 'supertest';
import clientAuthRouter from '../routes/api/clientAuth';
import { errorHandler } from '../middleware/errorHandler';

// ─── Module mocks ─────────────────────────────────────────────────────────────

jest.mock('../db', () => ({ db: { query: jest.fn() } }));
jest.mock('../jobs/scheduler', () => ({
  cancelJobsByConversationId: jest.fn(),
  scheduleOutreach: jest.fn(),
}));
jest.mock('../realtime/emitters', () => ({
  emitNewMessage: jest.fn(),
  emitAppointmentConfirmed: jest.fn(),
}));
jest.mock('../services/slotManager', () => ({
  lockSlot: jest.fn(),
  SlotConflictError: class SlotConflictError extends Error {
    constructor() { super('Slot is no longer available'); this.name = 'SlotConflictError'; }
  },
}));
jest.mock('../ai/messageProcessor', () => ({ processIncomingMessage: jest.fn() }));
jest.mock('../auth/tokens', () => ({ issueClientToken: jest.fn(), verifyClientToken: jest.fn() }));
jest.mock('../services/email', () => ({ sendClientInvite: jest.fn() }));

// Stub client auth middleware
jest.mock('../auth/clientMiddleware', () => ({
  requireClientAuth: (req: any, _res: any, next: any) => {
    req.client = { id: 'client-1', businessId: 'biz-1', sessionVersion: 1 };
    next();
  },
}));

import { db } from '../db';
import { lockSlot } from '../services/slotManager';
import { emitNewMessage, emitAppointmentConfirmed } from '../realtime/emitters';

const mockDbQuery   = db.query as jest.Mock;
const mockLockSlot  = lockSlot as jest.Mock;
const mockEmitMsg   = emitNewMessage as jest.Mock;
const mockEmitAppt  = emitAppointmentConfirmed as jest.Mock;

const app = express();
app.use(express.json());
app.use('/api/v1', clientAuthRouter);
app.use(errorHandler);

beforeEach(() => jest.resetAllMocks());

// ─── GET /client/slots ────────────────────────────────────────────────────────

test('GET /client/slots: returns available slots for business', async () => {
  mockDbQuery.mockResolvedValueOnce({
    rows: [
      { id: 'slot-1', starts_at: new Date('2026-07-01T10:00:00Z'), service_type: 'Haircut' },
      { id: 'slot-2', starts_at: new Date('2026-07-02T14:00:00Z'), service_type: null },
    ],
  });

  const res = await request(app).get('/api/v1/client/slots');

  expect(res.status).toBe(200);
  expect(res.body.slots).toHaveLength(2);
  expect(res.body.slots[0]).toMatchObject({ id: 'slot-1', serviceType: 'Haircut' });
  expect(res.body.slots[1]).toMatchObject({ id: 'slot-2', serviceType: null });
});

// ─── POST /client/bookings ────────────────────────────────────────────────────

test('POST /client/bookings: success → conversation created, 201 returned', async () => {
  // slot lookup
  mockDbQuery.mockResolvedValueOnce({
    rows: [{ starts_at: new Date('2026-07-01T10:00:00Z'), service_type: 'Haircut', business_id: 'biz-1' }],
  });
  mockLockSlot.mockResolvedValueOnce(undefined);
  mockDbQuery.mockResolvedValueOnce({ rows: [] }); // INSERT conversation
  mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 'msg-1', timestamp: new Date() }] }); // INSERT message
  mockDbQuery.mockResolvedValueOnce({ rows: [{ name: 'Alice' }] }); // client name

  const res = await request(app).post('/api/v1/client/bookings').send({ slotId: 'slot-1' });

  expect(res.status).toBe(201);
  expect(res.body).toMatchObject({ appointmentId: 'slot-1' });
  expect(res.body.conversationId).toBeDefined();
  expect(mockLockSlot).toHaveBeenCalledWith('slot-1', 'client-1');
  expect(mockEmitAppt).toHaveBeenCalledWith('biz-1', 'slot-1', 'Alice', expect.any(String), 'Haircut');
  expect(mockEmitMsg).toHaveBeenCalled();
});

test('POST /client/bookings: slot conflict → 409 SLOT_TAKEN', async () => {
  const { SlotConflictError } = await import('../services/slotManager');
  mockDbQuery.mockResolvedValueOnce({
    rows: [{ starts_at: new Date(), service_type: null, business_id: 'biz-1' }],
  });
  mockLockSlot.mockRejectedValueOnce(new SlotConflictError());

  const res = await request(app).post('/api/v1/client/bookings').send({ slotId: 'slot-taken' });

  expect(res.status).toBe(409);
  expect(res.body.error.code).toBe('SLOT_TAKEN');
  expect(mockEmitMsg).not.toHaveBeenCalled();
});

test('POST /client/bookings: slot not found → 404', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [] });

  const res = await request(app).post('/api/v1/client/bookings').send({ slotId: 'ghost' });

  expect(res.status).toBe(404);
  expect(mockLockSlot).not.toHaveBeenCalled();
});

test('POST /client/bookings: missing slotId → 400', async () => {
  const res = await request(app).post('/api/v1/client/bookings').send({});

  expect(res.status).toBe(400);
  expect(mockLockSlot).not.toHaveBeenCalled();
});
