import { processSendOutreach } from '../jobs/processors/sendOutreach';
import { Job } from 'bullmq';
import { SendOutreachData } from '../jobs/types';

// ─── Module mocks ─────────────────────────────────────────────────────────────

jest.mock('../db', () => ({ db: { query: jest.fn() } }));
jest.mock('../ai/stateEngine', () => ({ stateEngine: { applyTransition: jest.fn() } }));
jest.mock('../jobs/scheduler', () => ({
  scheduleFollowup:     jest.fn(),
  scheduleDeadlineCheck: jest.fn(),
}));
jest.mock('../realtime/emitters', () => ({ emitNewMessage: jest.fn() }));

import { db } from '../db';
import { stateEngine } from '../ai/stateEngine';
import { scheduleFollowup, scheduleDeadlineCheck } from '../jobs/scheduler';
import { emitNewMessage } from '../realtime/emitters';

const mockDbQuery      = db.query as jest.Mock;
const mockTransition   = stateEngine.applyTransition as jest.Mock;
const mockFollowup     = scheduleFollowup as jest.Mock;
const mockDeadline     = scheduleDeadlineCheck as jest.Mock;
const mockEmit         = emitNewMessage as jest.Mock;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeJob(data: SendOutreachData): Job<SendOutreachData> {
  return { data } as Job<SendOutreachData>;
}

interface ConvRow {
  conversation_id: string;
  client_id: string;
  business_id: string;
  starts_at: Date;
  service_type: string | null;
  client_name: string;
  timezone: string;
  business_settings: Record<string, unknown> | null;
}

const CONV_ROW: ConvRow = {
  conversation_id: 'conv-1',
  client_id: 'client-1',
  business_id: 'biz-1',
  starts_at: new Date('2026-06-10T10:00:00Z'),
  service_type: 'Haircut',
  client_name: 'Alice',
  timezone: 'UTC',
  business_settings: { outreach_response_window_hours: 12 },
};

function stubConvRow(overrides: Partial<ConvRow> = {}) {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ ...CONV_ROW, ...overrides }] });
}

function stubMessageInsert() {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 'msg-1', timestamp: new Date() }] });
}

function stubStatusUpdate() {
  mockDbQuery.mockResolvedValueOnce({ rows: [] });
}

beforeEach(() => jest.resetAllMocks());

// ─── Tests ────────────────────────────────────────────────────────────────────

test('happy path: transitions idle→awaiting_reply, stores message, emits, schedules jobs', async () => {
  stubConvRow();
  mockTransition.mockResolvedValueOnce('awaiting_reply');
  stubStatusUpdate(); // appointment set to ai-active
  stubMessageInsert();

  await processSendOutreach(makeJob({ appointmentId: 'appt-1' }));

  expect(mockTransition).toHaveBeenCalledWith('conv-1', 'outreach_triggered');
  expect(mockDbQuery).toHaveBeenCalledWith(
    expect.stringContaining("status = 'ai-active'"),
    ['appt-1'],
  );
  expect(mockEmit).toHaveBeenCalledWith('biz-1', 'client-1', 'conv-1', expect.objectContaining({
    sender: 'ai',
    content: expect.stringContaining('Alice'),
  }));
  expect(mockFollowup).toHaveBeenCalledTimes(3);
  expect(mockFollowup).toHaveBeenCalledWith('conv-1', 1, 5 * 60 * 1000);
  expect(mockFollowup).toHaveBeenCalledWith('conv-1', 2, 65 * 60 * 1000);
  expect(mockFollowup).toHaveBeenCalledWith('conv-1', 3, 12 * 3600000 - 5 * 60 * 1000);
  expect(mockDeadline).toHaveBeenCalledWith('conv-1', 'appt-1', 12 * 3600000);
});

test('uses default 24h window when business_settings is null', async () => {
  stubConvRow({ business_settings: null });
  mockTransition.mockResolvedValueOnce('awaiting_reply');
  stubStatusUpdate();
  stubMessageInsert();

  await processSendOutreach(makeJob({ appointmentId: 'appt-2' }));

  expect(mockDeadline).toHaveBeenCalledWith('conv-1', 'appt-2', 24 * 3600000);
  expect(mockFollowup).toHaveBeenCalledWith('conv-1', 3, 24 * 3600000 - 5 * 60 * 1000);
});

test('includes service type in message content', async () => {
  stubConvRow({ service_type: 'Massage' });
  mockTransition.mockResolvedValueOnce('awaiting_reply');
  stubStatusUpdate();
  stubMessageInsert();

  await processSendOutreach(makeJob({ appointmentId: 'appt-3' }));

  const insertCall = mockDbQuery.mock.calls.find(c =>
    typeof c[0] === 'string' && c[0].includes("sender, content")
  );
  expect(insertCall?.[1][2]).toContain('Massage');
});

test('generic label used when service_type is null', async () => {
  stubConvRow({ service_type: null });
  mockTransition.mockResolvedValueOnce('awaiting_reply');
  stubStatusUpdate();
  stubMessageInsert();

  await processSendOutreach(makeJob({ appointmentId: 'appt-4' }));

  const insertCall = mockDbQuery.mock.calls.find(c =>
    typeof c[0] === 'string' && c[0].includes("sender, content")
  );
  expect(insertCall?.[1][2]).toContain('your appointment');
});

test('returns early without error when no conversation found', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [] });

  await expect(processSendOutreach(makeJob({ appointmentId: 'ghost' }))).resolves.toBeUndefined();
  expect(mockTransition).not.toHaveBeenCalled();
  expect(mockEmit).not.toHaveBeenCalled();
});
