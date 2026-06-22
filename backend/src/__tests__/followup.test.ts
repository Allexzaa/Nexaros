import { processSendFollowup } from '../jobs/processors/sendFollowup';
import { Job } from 'bullmq';
import { SendFollowupData } from '../jobs/types';

// ─── Module mocks ─────────────────────────────────────────────────────────────

jest.mock('../db', () => ({ db: { query: jest.fn() } }));
jest.mock('../realtime/emitters', () => ({ emitNewMessage: jest.fn() }));

import { db } from '../db';
import { emitNewMessage } from '../realtime/emitters';

const mockDbQuery = db.query as jest.Mock;
const mockEmit    = emitNewMessage as jest.Mock;

function makeJob(data: SendFollowupData): Job<SendFollowupData> {
  return { data } as Job<SendFollowupData>;
}

function stubConvRow(state = 'awaiting_reply') {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ client_id: 'client-1', business_id: 'biz-1', state }] });
}

function stubMessageInsert() {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 'msg-1', timestamp: new Date() }] });
}

function stubCountUpdate() {
  mockDbQuery.mockResolvedValueOnce({ rows: [] });
}

beforeEach(() => jest.resetAllMocks());

// ─── Tests ────────────────────────────────────────────────────────────────────

test('follow-up 1: stores message, increments follow_up_count, emits', async () => {
  stubConvRow();
  stubMessageInsert();
  stubCountUpdate();

  await processSendFollowup(makeJob({ conversationId: 'conv-1', followupCount: 1 }));

  const insertCall = mockDbQuery.mock.calls.find(c =>
    typeof c[0] === 'string' && c[0].includes("sender, content")
  );
  expect(insertCall?.[1][2]).toContain('quick reminder');

  const updateCall = mockDbQuery.mock.calls.find(c =>
    typeof c[0] === 'string' && c[0].includes('follow_up_count')
  );
  expect(updateCall?.[1]).toEqual([1, 'conv-1']);

  expect(mockEmit).toHaveBeenCalledWith('biz-1', 'client-1', 'conv-1', expect.objectContaining({ sender: 'ai' }));
});

test('follow-up 2: different message text', async () => {
  stubConvRow();
  stubMessageInsert();
  stubCountUpdate();

  await processSendFollowup(makeJob({ conversationId: 'conv-1', followupCount: 2 }));

  const insertCall = mockDbQuery.mock.calls.find(c =>
    typeof c[0] === 'string' && c[0].includes("sender, content")
  );
  expect(insertCall?.[1][2]).toContain('Checking in');
});

test('follow-up 3: last-chance message text', async () => {
  stubConvRow();
  stubMessageInsert();
  stubCountUpdate();

  await processSendFollowup(makeJob({ conversationId: 'conv-1', followupCount: 3 }));

  const insertCall = mockDbQuery.mock.calls.find(c =>
    typeof c[0] === 'string' && c[0].includes("sender, content")
  );
  expect(insertCall?.[1][2]).toContain('last reminder');
});

test('skips when conversation not in awaiting_reply', async () => {
  stubConvRow('confirmed');

  await processSendFollowup(makeJob({ conversationId: 'conv-1', followupCount: 1 }));

  expect(mockEmit).not.toHaveBeenCalled();
  // Only one query (the state lookup) was made
  expect(mockDbQuery).toHaveBeenCalledTimes(1);
});

test('returns early without error when conversation not found', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [] });

  await expect(processSendFollowup(makeJob({ conversationId: 'ghost', followupCount: 1 }))).resolves.toBeUndefined();
  expect(mockEmit).not.toHaveBeenCalled();
});

