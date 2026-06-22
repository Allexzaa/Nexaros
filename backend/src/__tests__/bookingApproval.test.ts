import express from 'express';
import request from 'supertest';
import conversationsRouter from '../routes/api/conversations';
import { processBookingApprovalTimeout } from '../jobs/processors/bookingApprovalTimeout';

// ─── Module mocks ─────────────────────────────────────────────────────────────

jest.mock('../db', () => ({ db: { query: jest.fn() } }));
jest.mock('../ai/stateEngine', () => ({ stateEngine: { applyTransition: jest.fn() } }));
jest.mock('../jobs/scheduler', () => ({
  cancelJobsByConversationId: jest.fn(),
  scheduleWaitlistCheck: jest.fn(),
}));
jest.mock('../realtime/emitters', () => ({
  emitNewMessage: jest.fn(),
  emitTakeoverStarted: jest.fn(),
}));
jest.mock('../ai/messageProcessor', () => ({ processIncomingMessage: jest.fn() }));
jest.mock('../services/slotManager', () => ({
  findBestSlot: jest.fn(),
  lockSlot: jest.fn(),
  freeSlot: jest.fn(),
  SlotConflictError: class SlotConflictError extends Error {
    constructor() { super('Slot is no longer available'); this.name = 'SlotConflictError'; }
  },
}));

jest.mock('../auth/middleware', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.staff = { id: 'staff-1', businessId: 'biz-1', role: 'staff' };
    next();
  },
  requireRole: (..._roles: string[]) => (_req: any, _res: any, next: any) => next(),
}));

import { db } from '../db';
import { stateEngine } from '../ai/stateEngine';
import { cancelJobsByConversationId } from '../jobs/scheduler';
import { findBestSlot } from '../services/slotManager';
import { emitNewMessage } from '../realtime/emitters';

const mockDbQuery  = db.query as jest.Mock;
const mockTransition = stateEngine.applyTransition as jest.Mock;
const mockCancel   = cancelJobsByConversationId as jest.Mock;
const mockFindSlot = findBestSlot as jest.Mock;
const mockEmitMsg  = emitNewMessage as jest.Mock;

const app = express();
app.use(express.json());
app.use('/api/v1', conversationsRouter);

beforeEach(() => jest.resetAllMocks());

// ─── PATCH /conversations/:id/booking — approve ───────────────────────────────

test('approve: slot found → slot_offered, slot offer message sent to client', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ state: 'awaiting_approval', client_id: 'client-1', appointment_id: 'appt-1' }] });
  mockCancel.mockResolvedValueOnce(undefined);
  mockFindSlot.mockResolvedValueOnce({ id: 'slot-2', starts_at: new Date('2026-07-01T10:00:00Z'), service_type: 'Massage' });
  mockTransition.mockResolvedValueOnce('slot_offered');
  mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 'msg-1', timestamp: new Date() }] }); // INSERT message

  const res = await request(app).patch('/api/v1/conversations/conv-1/booking').send({ action: 'approve' });

  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ conversationId: 'conv-1', state: 'slot_offered' });
  expect(mockTransition).toHaveBeenCalledWith('conv-1', 'staff_approved_booking', {
    targetState: 'slot_offered',
    offeredSlotId: 'slot-2',
  });
  expect(mockEmitMsg).toHaveBeenCalledWith('biz-1', 'client-1', 'conv-1', expect.any(Object));
});

test('approve: no slot → waitlisted, waitlist_entry inserted', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ state: 'awaiting_approval', client_id: 'client-1', appointment_id: 'appt-1' }] });
  mockCancel.mockResolvedValueOnce(undefined);
  mockFindSlot.mockResolvedValueOnce(null);
  mockTransition.mockResolvedValueOnce('waitlisted');
  mockDbQuery.mockResolvedValueOnce({ rows: [] }); // INSERT waitlist_entry
  mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 'msg-1', timestamp: new Date() }] }); // INSERT message

  const res = await request(app).patch('/api/v1/conversations/conv-1/booking').send({ action: 'approve' });

  expect(res.status).toBe(200);
  expect(res.body.state).toBe('waitlisted');
  expect(mockDbQuery).toHaveBeenCalledWith(
    expect.stringContaining('INSERT INTO waitlist_entry'),
    expect.any(Array),
  );
});

// ─── PATCH /conversations/:id/booking — reject ────────────────────────────────

test('reject: slot found → slot_offered with apologetic message', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ state: 'awaiting_approval', client_id: 'client-1', appointment_id: 'appt-1' }] });
  mockCancel.mockResolvedValueOnce(undefined);
  mockFindSlot.mockResolvedValueOnce({ id: 'slot-2', starts_at: new Date('2026-07-02T14:00:00Z'), service_type: null });
  mockTransition.mockResolvedValueOnce('slot_offered');
  mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 'msg-1', timestamp: new Date() }] });

  const res = await request(app).patch('/api/v1/conversations/conv-1/booking').send({ action: 'reject' });

  expect(res.status).toBe(200);
  expect(mockTransition).toHaveBeenCalledWith('conv-1', 'staff_rejected_booking', {
    targetState: 'slot_offered',
    offeredSlotId: 'slot-2',
  });
});

test('reject: no slot → waitlisted', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ state: 'awaiting_approval', client_id: 'client-1', appointment_id: 'appt-1' }] });
  mockCancel.mockResolvedValueOnce(undefined);
  mockFindSlot.mockResolvedValueOnce(null);
  mockTransition.mockResolvedValueOnce('waitlisted');
  mockDbQuery.mockResolvedValueOnce({ rows: [] }); // INSERT waitlist_entry
  mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 'msg-1', timestamp: new Date() }] });

  const res = await request(app).patch('/api/v1/conversations/conv-1/booking').send({ action: 'reject' });

  expect(res.status).toBe(200);
  expect(res.body.state).toBe('waitlisted');
});

test('booking action: 404 when conversation not found', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [] });

  const res = await request(app).patch('/api/v1/conversations/ghost/booking').send({ action: 'approve' });

  expect(res.status).toBe(404);
});

test('booking action: 409 when not in awaiting_approval state', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ state: 'escalated', client_id: 'client-1', appointment_id: 'appt-1' }] });

  const res = await request(app).patch('/api/v1/conversations/conv-1/booking').send({ action: 'approve' });

  expect(res.status).toBe(409);
  expect(mockTransition).not.toHaveBeenCalled();
});

test('booking action: 400 for invalid action', async () => {
  const res = await request(app).patch('/api/v1/conversations/conv-1/booking').send({ action: 'maybe' });

  expect(res.status).toBe(400);
});

// ─── GET /conversations?state= ────────────────────────────────────────────────

test('GET /conversations?state=awaiting_approval: returns only awaiting_approval conversations', async () => {
  mockDbQuery.mockResolvedValueOnce({
    rows: [{ id: 'conv-1', state: 'awaiting_approval', client_name: 'Alice', escalation_reason: null }],
  });

  const res = await request(app).get('/api/v1/conversations?state=awaiting_approval');

  expect(res.status).toBe(200);
  expect(res.body.data).toHaveLength(1);
  const sql = mockDbQuery.mock.calls[0][0] as string;
  expect(sql).toContain('c.state = $');
});

// ─── bookingApprovalTimeout processor ────────────────────────────────────────

test('bookingApprovalTimeout: slot found → approval_timeout → slot_offered, message emitted', async () => {
  mockDbQuery.mockResolvedValueOnce({
    rows: [{ state: 'awaiting_approval', business_id: 'biz-1', appointment_id: 'appt-1', client_id: 'client-1' }],
  });
  mockFindSlot.mockResolvedValueOnce({ id: 'slot-2', starts_at: new Date('2026-07-01T10:00:00Z'), service_type: 'Haircut' });
  mockTransition.mockResolvedValueOnce('slot_offered');
  mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 'msg-1', timestamp: new Date() }] });

  await processBookingApprovalTimeout({ data: { conversationId: 'conv-1' } } as any);

  expect(mockTransition).toHaveBeenCalledWith('conv-1', 'approval_timeout', {
    targetState: 'slot_offered',
    offeredSlotId: 'slot-2',
  });
  expect(mockEmitMsg).toHaveBeenCalledWith('biz-1', 'client-1', 'conv-1', expect.any(Object));
});

test('bookingApprovalTimeout: no slot → waitlisted, waitlist_entry inserted', async () => {
  mockDbQuery.mockResolvedValueOnce({
    rows: [{ state: 'awaiting_approval', business_id: 'biz-1', appointment_id: 'appt-1', client_id: 'client-1' }],
  });
  mockFindSlot.mockResolvedValueOnce(null);
  mockTransition.mockResolvedValueOnce('waitlisted');
  mockDbQuery.mockResolvedValueOnce({ rows: [] }); // INSERT waitlist_entry
  mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 'msg-1', timestamp: new Date() }] });

  await processBookingApprovalTimeout({ data: { conversationId: 'conv-1' } } as any);

  expect(mockTransition).toHaveBeenCalledWith('conv-1', 'approval_timeout', { targetState: 'waitlisted' });
  expect(mockDbQuery).toHaveBeenCalledWith(
    expect.stringContaining('INSERT INTO waitlist_entry'),
    expect.any(Array),
  );
});

test('bookingApprovalTimeout: skips if not in awaiting_approval state', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ state: 'confirmed', business_id: 'biz-1', appointment_id: 'appt-1', client_id: 'client-1' }] });

  await processBookingApprovalTimeout({ data: { conversationId: 'conv-1' } } as any);

  expect(mockFindSlot).not.toHaveBeenCalled();
  expect(mockTransition).not.toHaveBeenCalled();
});
