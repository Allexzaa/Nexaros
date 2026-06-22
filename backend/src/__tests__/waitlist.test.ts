import { processWaitlistCheck } from '../jobs/processors/waitlistCheck';
import { processWaitlistReminder } from '../jobs/processors/waitlistReminder';

// ─── Module mocks ─────────────────────────────────────────────────────────────

jest.mock('../db', () => ({ db: { query: jest.fn() } }));
jest.mock('../ai/stateEngine', () => ({ stateEngine: { applyTransition: jest.fn() } }));
jest.mock('../ai/llmInstance', () => ({ llmClient: { rankSlots: jest.fn() } }));
jest.mock('../realtime/emitters', () => ({ emitNewMessage: jest.fn() }));
jest.mock('../jobs/scheduler', () => ({
  scheduleWaitlistReminder: jest.fn(),
  scheduleWaitlistTimeout:  jest.fn(),
  scheduleWaitlistCheck:    jest.fn(),
}));

import { db } from '../db';
import { stateEngine } from '../ai/stateEngine';
import { llmClient } from '../ai/llmInstance';
import { scheduleWaitlistReminder, scheduleWaitlistTimeout, scheduleWaitlistCheck } from '../jobs/scheduler';

const mockDbQuery       = db.query as jest.Mock;
const mockTransition    = stateEngine.applyTransition as jest.Mock;
const mockRankSlots     = llmClient.rankSlots as jest.Mock;
const mockSchedReminder = scheduleWaitlistReminder as jest.Mock;
const mockSchedTimeout  = scheduleWaitlistTimeout as jest.Mock;
const mockSchedCheck    = scheduleWaitlistCheck as jest.Mock;

beforeEach(() => jest.resetAllMocks());

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeJob<T>(data: T) { return { data } as any; }

function stubSlot() {
  mockDbQuery.mockResolvedValueOnce({
    rows: [{ starts_at: new Date('2026-07-01T10:00:00Z'), service_type: 'Haircut' }],
  });
}

function stubEntries(entries: Array<{ id: string; client_id: string; preferences: string }>) {
  mockDbQuery.mockResolvedValueOnce({ rows: entries });
}

function stubConversation(conversationId = 'conv-1', clientId = 'client-1') {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ id: conversationId, client_id: clientId }] });
}

function stubMessageInsert() {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 'msg-1', timestamp: new Date() }] });
}

function stubWaitlistUpdate() {
  mockDbQuery.mockResolvedValueOnce({ rows: [] });
}

// ─── waitlistCheck ────────────────────────────────────────────────────────────

test('waitlistCheck: LLM match → slot_offered, entry notified, reminders scheduled', async () => {
  stubSlot();
  stubEntries([{ id: 'entry-1', client_id: 'client-1', preferences: 'morning haircut' }]);
  mockRankSlots.mockResolvedValueOnce('slot-1');
  stubConversation();
  mockTransition.mockResolvedValueOnce('slot_offered');
  stubMessageInsert();
  stubWaitlistUpdate();

  await processWaitlistCheck(makeJob({ slotId: 'slot-1', businessId: 'biz-1' }));

  expect(mockTransition).toHaveBeenCalledWith('conv-1', 'waitlist_match_found', { offeredSlotId: 'slot-1' });
  expect(mockSchedReminder).toHaveBeenCalledWith('conv-1', 'slot-1', 'biz-1', 25 * 60 * 1000);
  expect(mockSchedTimeout).toHaveBeenCalledWith('conv-1', 'slot-1', 'biz-1', 30 * 60 * 1000);
  expect(mockDbQuery).toHaveBeenCalledWith(
    expect.stringContaining("status = 'notified'"),
    ['entry-1'],
  );
});

test('waitlistCheck: LLM returns no match → nothing scheduled', async () => {
  stubSlot();
  stubEntries([{ id: 'entry-1', client_id: 'client-1', preferences: 'evening only' }]);
  mockRankSlots.mockResolvedValueOnce(null);

  await processWaitlistCheck(makeJob({ slotId: 'slot-1', businessId: 'biz-1' }));

  expect(mockTransition).not.toHaveBeenCalled();
  expect(mockSchedReminder).not.toHaveBeenCalled();
});

test('waitlistCheck: skips entries with no waitlisted conversation, moves to next', async () => {
  stubSlot();
  stubEntries([
    { id: 'entry-1', client_id: 'client-no-conv', preferences: 'morning' },
    { id: 'entry-2', client_id: 'client-1', preferences: 'morning' },
  ]);
  mockRankSlots.mockResolvedValueOnce('slot-1'); // entry-1 matches
  mockDbQuery.mockResolvedValueOnce({ rows: [] }); // no waitlisted conv for client-no-conv
  mockRankSlots.mockResolvedValueOnce('slot-1'); // entry-2 matches
  stubConversation();
  mockTransition.mockResolvedValueOnce('slot_offered');
  stubMessageInsert();
  stubWaitlistUpdate();

  await processWaitlistCheck(makeJob({ slotId: 'slot-1', businessId: 'biz-1' }));

  expect(mockTransition).toHaveBeenCalledWith('conv-1', 'waitlist_match_found', { offeredSlotId: 'slot-1' });
});

test('waitlistCheck: slot not found → returns immediately', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [] }); // slot gone

  await processWaitlistCheck(makeJob({ slotId: 'slot-gone', businessId: 'biz-1' }));

  expect(mockRankSlots).not.toHaveBeenCalled();
});

test('waitlistCheck: no waiting entries → returns immediately', async () => {
  stubSlot();
  stubEntries([]);

  await processWaitlistCheck(makeJob({ slotId: 'slot-1', businessId: 'biz-1' }));

  expect(mockRankSlots).not.toHaveBeenCalled();
  expect(mockTransition).not.toHaveBeenCalled();
});

// ─── waitlistReminder (non-final) ────────────────────────────────────────────

test('waitlistReminder final=false: sends reminder if conversation is slot_offered', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ client_id: 'client-1', state: 'slot_offered' }] });
  stubMessageInsert();

  await processWaitlistReminder(makeJob({
    conversationId: 'conv-1', slotId: 'slot-1', businessId: 'biz-1', final: false,
  }));

  expect(mockDbQuery).toHaveBeenCalledWith(
    expect.stringContaining('INSERT INTO message'),
    expect.arrayContaining(['conv-1']),
  );
  expect(mockSchedCheck).not.toHaveBeenCalled();
});

test('waitlistReminder final=false: skips if conversation not in slot_offered', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ client_id: 'client-1', state: 'confirmed' }] });

  await processWaitlistReminder(makeJob({
    conversationId: 'conv-1', slotId: 'slot-1', businessId: 'biz-1', final: false,
  }));

  // Only the SELECT — no message insert
  expect(mockDbQuery).toHaveBeenCalledTimes(1);
});

// ─── waitlistReminder (final) ─────────────────────────────────────────────────

test('waitlistReminder final=true: marks expired, re-queues waitlist-check', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ client_id: 'client-1' }] }); // conv lookup
  mockDbQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE waitlist_entry

  await processWaitlistReminder(makeJob({
    conversationId: 'conv-1', slotId: 'slot-1', businessId: 'biz-1', final: true,
  }));

  expect(mockDbQuery).toHaveBeenCalledWith(
    expect.stringContaining("status = 'expired'"),
    ['client-1', 'biz-1'],
  );
  expect(mockSchedCheck).toHaveBeenCalledWith('slot-1', 'biz-1');
});
