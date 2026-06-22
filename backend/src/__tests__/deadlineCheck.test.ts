import { processDeadlineCheck } from '../jobs/processors/deadlineCheck';
import { Job } from 'bullmq';
import { DeadlineCheckData } from '../jobs/types';

// ─── Module mocks ─────────────────────────────────────────────────────────────

jest.mock('../db', () => ({ db: { query: jest.fn() } }));
jest.mock('../ai/stateEngine', () => ({ stateEngine: { applyTransition: jest.fn() } }));
jest.mock('../jobs/scheduler', () => ({ scheduleWaitlistCheck: jest.fn() }));
jest.mock('../realtime/emitters', () => ({ emitDeadlineReached: jest.fn() }));

import { db } from '../db';
import { stateEngine } from '../ai/stateEngine';
import { scheduleWaitlistCheck } from '../jobs/scheduler';
import { emitDeadlineReached } from '../realtime/emitters';

const mockDbQuery     = db.query as jest.Mock;
const mockTransition  = stateEngine.applyTransition as jest.Mock;
const mockWaitlist    = scheduleWaitlistCheck as jest.Mock;
const mockEmit        = emitDeadlineReached as jest.Mock;

function makeJob(data: DeadlineCheckData): Job<DeadlineCheckData> {
  return { data } as Job<DeadlineCheckData>;
}

const JOB_DATA: DeadlineCheckData = { conversationId: 'conv-1', appointmentId: 'appt-1' };

function stubConvRow(state = 'awaiting_reply') {
  mockDbQuery.mockResolvedValueOnce({
    rows: [{ state, client_id: 'client-1', business_id: 'biz-1', client_name: 'Alice' }],
  });
}

function stubStatusUpdate() {
  mockDbQuery.mockResolvedValueOnce({ rows: [] });
}

beforeEach(() => jest.resetAllMocks());

// ─── Tests ────────────────────────────────────────────────────────────────────

test('awaiting_reply → deadline_reached: transitions state, marks appointment, emits, triggers waitlist', async () => {
  stubConvRow('awaiting_reply');
  mockTransition.mockResolvedValueOnce('no_response');
  stubStatusUpdate();

  await processDeadlineCheck(makeJob(JOB_DATA));

  expect(mockTransition).toHaveBeenCalledWith('conv-1', 'deadline_reached');
  expect(mockDbQuery).toHaveBeenCalledWith(
    expect.stringContaining("status = 'no-response'"),
    ['appt-1'],
  );
  expect(mockEmit).toHaveBeenCalledWith('biz-1', 'conv-1', 'Alice');
  expect(mockWaitlist).toHaveBeenCalledWith('appt-1', 'biz-1');
});

test('confirming state → also fires deadline', async () => {
  stubConvRow('confirming');
  mockTransition.mockResolvedValueOnce('no_response');
  stubStatusUpdate();

  await processDeadlineCheck(makeJob(JOB_DATA));

  expect(mockTransition).toHaveBeenCalledWith('conv-1', 'deadline_reached');
});

test('skips when conversation is already in terminal state', async () => {
  stubConvRow('confirmed');

  await processDeadlineCheck(makeJob(JOB_DATA));

  expect(mockTransition).not.toHaveBeenCalled();
  expect(mockEmit).not.toHaveBeenCalled();
  expect(mockWaitlist).not.toHaveBeenCalled();
});

test('skips escalated conversations', async () => {
  stubConvRow('escalated');

  await processDeadlineCheck(makeJob(JOB_DATA));

  expect(mockTransition).not.toHaveBeenCalled();
});

test('returns early without error when conversation not found', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [] });

  await expect(processDeadlineCheck(makeJob(JOB_DATA))).resolves.toBeUndefined();
  expect(mockTransition).not.toHaveBeenCalled();
});
