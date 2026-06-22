import express from 'express';
import request from 'supertest';
import conversationsRouter from '../routes/api/conversations';

// ─── Module mocks ─────────────────────────────────────────────────────────────

jest.mock('../db', () => ({ db: { query: jest.fn() } }));
jest.mock('../ai/stateEngine', () => ({ stateEngine: { applyTransition: jest.fn() } }));
jest.mock('../jobs/scheduler', () => ({ cancelJobsByConversationId: jest.fn() }));
jest.mock('../realtime/emitters', () => ({ emitTakeoverStarted: jest.fn() }));
jest.mock('../ai/conversationAgent', () => ({ runConversationAgent: jest.fn() }));

// Stub auth middleware so we can test the route logic directly
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
import { emitTakeoverStarted } from '../realtime/emitters';
import { runConversationAgent } from '../ai/conversationAgent';

const mockDbQuery      = db.query as jest.Mock;
const mockTransition   = stateEngine.applyTransition as jest.Mock;
const mockCancel       = cancelJobsByConversationId as jest.Mock;
const mockEmitTakeover = emitTakeoverStarted as jest.Mock;
const mockProcessMsg   = runConversationAgent as jest.Mock;

const app = express();
app.use(express.json());
app.use('/api/v1', conversationsRouter);

beforeEach(() => jest.resetAllMocks());

// ─── GET /conversations — escalated sorted to top ────────────────────────────

test('GET /conversations: escalated conversations appear in results', async () => {
  mockDbQuery.mockResolvedValueOnce({
    rows: [
      { id: 'conv-esc', state: 'escalated', client_name: 'Alice', escalation_reason: 'distress_keyword' },
      { id: 'conv-2',   state: 'awaiting_reply', client_name: 'Bob', escalation_reason: null },
    ],
  });

  const res = await request(app).get('/api/v1/conversations');

  expect(res.status).toBe(200);
  expect(res.body.data[0].state).toBe('escalated');
  // Verify ORDER BY clause in query includes escalated priority
  const sqlCall = mockDbQuery.mock.calls[0][0] as string;
  expect(sqlCall).toContain("CASE WHEN c.state = 'escalated'");
});

// ─── PATCH /conversations/:id/takeover ───────────────────────────────────────

test('takeover: transitions to staff_active, cancels jobs, emits to client', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ client_id: 'client-1', state: 'escalated' }] }); // conv lookup
  mockTransition.mockResolvedValueOnce('staff_active');
  mockDbQuery.mockResolvedValueOnce({ rows: [] }); // taken_over_by update
  mockCancel.mockResolvedValueOnce(undefined);

  const res = await request(app).patch('/api/v1/conversations/conv-1/takeover');

  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ conversationId: 'conv-1', state: 'staff_active' });
  expect(mockTransition).toHaveBeenCalledWith('conv-1', 'staff_takeover');
  expect(mockDbQuery).toHaveBeenCalledWith(
    expect.stringContaining('taken_over_by'),
    ['staff-1', 'conv-1'],
  );
  expect(mockCancel).toHaveBeenCalledWith('conv-1');
  expect(mockEmitTakeover).toHaveBeenCalledWith('client-1', 'conv-1');
});

test('takeover: 404 when conversation not found', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [] });

  const res = await request(app).patch('/api/v1/conversations/ghost/takeover');

  expect(res.status).toBe(404);
  expect(mockTransition).not.toHaveBeenCalled();
});

// ─── PATCH /conversations/:id/return ─────────────────────────────────────────

test('return: staff_active → awaiting_reply, clears taken_over_by', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ state: 'staff_active' }] }); // conv lookup
  mockTransition.mockResolvedValueOnce('awaiting_reply');
  mockDbQuery.mockResolvedValueOnce({ rows: [] }); // clear taken_over_by
  // Last message was from AI (no re-engagement)
  mockDbQuery.mockResolvedValueOnce({ rows: [{ sender: 'ai', content: 'See you then.' }] });

  const res = await request(app).patch('/api/v1/conversations/conv-1/return');

  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ conversationId: 'conv-1', state: 'awaiting_reply' });
  expect(mockTransition).toHaveBeenCalledWith('conv-1', 'staff_returns_to_ai');
  expect(mockDbQuery).toHaveBeenCalledWith(
    expect.stringContaining('taken_over_by = NULL'),
    ['conv-1'],
  );
  expect(mockProcessMsg).not.toHaveBeenCalled();
});

test('return: last message from client → processIncomingMessage called fire-and-forget', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ state: 'staff_active' }] });
  mockTransition.mockResolvedValueOnce('awaiting_reply');
  mockDbQuery.mockResolvedValueOnce({ rows: [] }); // clear taken_over_by
  mockDbQuery.mockResolvedValueOnce({ rows: [{ sender: 'client', content: 'Can we reschedule?' }] });
  mockProcessMsg.mockResolvedValueOnce(null);

  const res = await request(app).patch('/api/v1/conversations/conv-1/return');

  expect(res.status).toBe(200);
  // Allow the fire-and-forget to settle
  await new Promise(r => setTimeout(r, 10));
  expect(mockProcessMsg).toHaveBeenCalledWith('conv-1', 'Can we reschedule?');
});

test('return: 409 when conversation is not in staff_active state', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ state: 'awaiting_reply' }] });

  const res = await request(app).patch('/api/v1/conversations/conv-1/return');

  expect(res.status).toBe(409);
  expect(mockTransition).not.toHaveBeenCalled();
});

test('return: 404 when conversation not found', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [] });

  const res = await request(app).patch('/api/v1/conversations/ghost/return');

  expect(res.status).toBe(404);
});

// ─── PATCH /conversations/:id/close ──────────────────────────────────────────

test('close: transitions to resolved, cancels jobs', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ state: 'escalated' }] });
  mockTransition.mockResolvedValueOnce('resolved');
  mockCancel.mockResolvedValueOnce(undefined);

  const res = await request(app).patch('/api/v1/conversations/conv-1/close');

  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ conversationId: 'conv-1', state: 'resolved' });
  expect(mockTransition).toHaveBeenCalledWith('conv-1', 'staff_forces_close');
  expect(mockCancel).toHaveBeenCalledWith('conv-1');
});

test('close: 404 when conversation not found', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [] });

  const res = await request(app).patch('/api/v1/conversations/ghost/close');

  expect(res.status).toBe(404);
});
