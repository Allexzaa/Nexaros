import { processIncomingMessage } from '../ai/messageProcessor';

// ─── Module mocks ─────────────────────────────────────────────────────────────

jest.mock('../db', () => ({ db: { query: jest.fn() } }));
jest.mock('../jobs/connection', () => ({
  redisConnection: { set: jest.fn(), del: jest.fn(), rpush: jest.fn(), lpop: jest.fn() },
}));
jest.mock('../ai/stateEngine', () => ({
  stateEngine: { applyTransition: jest.fn() },
}));
jest.mock('../ai/llmInstance', () => ({
  llmClient: { complete: jest.fn(), summarize: jest.fn() },
}));
jest.mock('../ai/keywords', () => ({ isDistressMessage: jest.fn() }));
jest.mock('../ai/contextWindow', () => ({
  getConversationContext: jest.fn(),
  regenerateSummary: jest.fn(),
}));
jest.mock('../jobs/scheduler', () => ({
  cancelJobsByConversationId: jest.fn(),
  scheduleWaitlistCheck: jest.fn(),
}));
jest.mock('../realtime/emitters', () => ({ emitAppointmentConfirmed: jest.fn() }));
jest.mock('../services/slotManager', () => ({
  findBestSlot: jest.fn(),
  findMatchingSlots: jest.fn(),
  findSlotsForDate: jest.fn(),
  lockSlot: jest.fn(),
  freeSlot: jest.fn(),
  SlotConflictError: class SlotConflictError extends Error {
    constructor() { super('Slot is no longer available'); this.name = 'SlotConflictError'; }
  },
}));

import { db } from '../db';
import { redisConnection } from '../jobs/connection';
import { stateEngine } from '../ai/stateEngine';
import { llmClient } from '../ai/llmInstance';
import { isDistressMessage } from '../ai/keywords';
import { getConversationContext, regenerateSummary } from '../ai/contextWindow';
import { cancelJobsByConversationId } from '../jobs/scheduler';
import { emitAppointmentConfirmed } from '../realtime/emitters';
import { findBestSlot, findMatchingSlots, lockSlot, freeSlot, SlotConflictError } from '../services/slotManager';

const mockDbQuery       = db.query as jest.Mock;
const mockRedisSet      = redisConnection.set as jest.Mock;
const mockRedisDel      = redisConnection.del as jest.Mock;
const mockRedisLpop     = redisConnection.lpop as jest.Mock;
const mockTransition    = stateEngine.applyTransition as jest.Mock;
const mockComplete      = llmClient.complete as jest.Mock;
const mockDistress      = isDistressMessage as jest.Mock;
const mockGetContext    = getConversationContext as jest.Mock;
const mockRegenSummary  = regenerateSummary as jest.Mock;
const mockCancel        = cancelJobsByConversationId as jest.Mock;
const mockEmitConfirmed = emitAppointmentConfirmed as jest.Mock;
const mockFindBestSlot      = findBestSlot as jest.Mock;
const mockFindMatchingSlots = findMatchingSlots as jest.Mock;
const mockLockSlot      = lockSlot as jest.Mock;
const mockFreeSlot      = freeSlot as jest.Mock;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stubLockAcquired() {
  mockRedisSet.mockResolvedValueOnce('OK');
  mockRedisDel.mockResolvedValueOnce(1);
  mockRedisLpop.mockResolvedValueOnce(null);
}

function stubConversation(overrides: Record<string, unknown> = {}) {
  mockDbQuery.mockResolvedValueOnce({
    rows: [{
      state: 'awaiting_reply',
      context_summary: null,
      consecutive_ambiguous_count: 0,
      business_id: 'biz-1',
      business_name: 'Test Salon',
      business_settings: null,
      appointment_id: 'appt-original',
      offered_slot_id: null,
      starts_at: new Date('2026-06-01T10:00:00Z'),
      service_type: 'Haircut',
      client_id: 'client-1',
      client_name: 'Alice',
      ...overrides,
    }],
  });
}

function stubNoDistress() { mockDistress.mockReturnValueOnce(false); }

function stubContext() {
  mockGetContext.mockResolvedValueOnce({ messages: [], contextSummary: null });
}

function stubMessageInsert() {
  mockDbQuery.mockResolvedValueOnce({ rows: [] });
}

function stubAvailableSlotsQuery(rows: Array<{ starts_at: Date; service_type: string | null }> = []) {
  mockDbQuery.mockResolvedValueOnce({ rows });
}

beforeEach(() => jest.resetAllMocks());

// ─── decline_intent → rescheduling ───────────────────────────────────────────

test('decline_intent from awaiting_reply → rescheduling, preference-gathering prompt stored', async () => {
  stubLockAcquired();
  stubConversation();
  stubNoDistress();
  mockTransition.mockResolvedValueOnce('processing'); // message_received
  stubContext();
  mockComplete.mockResolvedValueOnce({
    intent: 'decline',
    confidence: 0.90,
    resolvedIntent: 'decline',
    response_text: "No problem. What days or times generally work better for you?",
    extracted_preferences: null,
  });
  mockTransition.mockResolvedValueOnce('rescheduling'); // decline_intent
  stubMessageInsert();
  mockRegenSummary.mockResolvedValueOnce(undefined);

  const result = await processIncomingMessage('conv-1', "I can't make it");

  expect(result).toMatchObject({ event: 'decline_intent', newState: 'rescheduling' });
  expect(mockTransition).toHaveBeenNthCalledWith(2, 'conv-1', 'decline_intent', {});
});

// ─── reschedule_preference_given + slot found → slot_offered ─────────────────

test('reschedule_preference_given + slot found → slot_offered with offeredSlotId and template message', async () => {
  stubLockAcquired();
  stubConversation({ state: 'rescheduling' });
  stubNoDistress();
  stubContext();
  mockComplete.mockResolvedValueOnce({
    intent: 'reschedule_preference',
    confidence: 0.88,
    resolvedIntent: 'reschedule_preference',
    response_text: 'LLM response (should be overridden)',
    extracted_preferences: 'mornings preferred',
    // No preferred_date_from → open-ended path → findMatchingSlots
  });
  const foundSlot = { id: 'slot-new', starts_at: new Date('2026-06-05T14:00:00Z'), service_type: 'Haircut' };
  mockFindMatchingSlots.mockResolvedValueOnce([foundSlot]); // single match → slot_offered
  mockTransition.mockResolvedValueOnce('slot_offered'); // reschedule_preference_given
  stubMessageInsert();
  mockRegenSummary.mockResolvedValueOnce(undefined);

  const result = await processIncomingMessage('conv-1', 'I prefer mornings');

  expect(result).toMatchObject({ event: 'reschedule_preference_given', newState: 'slot_offered' });
  expect(mockFindMatchingSlots).toHaveBeenCalledWith('biz-1', 'mornings preferred', 'appt-original', expect.any(String), 3);
  expect(mockTransition).toHaveBeenCalledWith('conv-1', 'reschedule_preference_given', {
    targetState: 'slot_offered',
    offeredSlotId: 'slot-new',
  });
  // Template message used, not LLM response
  expect(result?.responseText).toContain('available');
  expect(result?.responseText).not.toBe('LLM response (should be overridden)');
  // No waitlist_entry created
  const waitlistInsert = mockDbQuery.mock.calls.find(c =>
    typeof c[0] === 'string' && c[0].includes('waitlist_entry')
  );
  expect(waitlistInsert).toBeUndefined();
});

// ─── reschedule_preference_given + no slot → waitlisted ──────────────────────

test('reschedule_preference_given + no slots → stays in rescheduling, no waitlist_entry', async () => {
  stubLockAcquired();
  stubConversation({ state: 'rescheduling' });
  stubNoDistress();
  stubContext();
  mockComplete.mockResolvedValueOnce({
    intent: 'reschedule_preference',
    confidence: 0.88,
    resolvedIntent: 'reschedule_preference',
    response_text: 'LLM response',
    extracted_preferences: 'weekend mornings',
    // No preferred_date_from → open-ended path → findMatchingSlots
  });
  mockFindMatchingSlots.mockResolvedValueOnce([]); // no slots → returns early in rescheduling
  mockDbQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE conversation SET state = 'rescheduling'
  stubMessageInsert();

  const result = await processIncomingMessage('conv-1', 'I prefer weekends');

  expect(result).toMatchObject({ event: 'reschedule_preference_given', newState: 'rescheduling' });
  expect(result?.responseText).toContain("available slots");
  // stateEngine NOT called (returns early)
  expect(mockTransition).not.toHaveBeenCalledWith('conv-1', 'reschedule_preference_given', expect.anything());
  // No waitlist_entry created
  const waitlistInsert = mockDbQuery.mock.calls.find(c =>
    typeof c[0] === 'string' && c[0].includes('waitlist_entry')
  );
  expect(waitlistInsert).toBeUndefined();
});

// ─── slot_accepted + lockSlot succeeds → confirmed ───────────────────────────

test('slot_accepted + lockSlot succeeds → confirmed, freeSlot called, emitAppointmentConfirmed fired', async () => {
  stubLockAcquired();
  stubConversation({ state: 'slot_offered', offered_slot_id: 'slot-new' });
  stubNoDistress();
  stubContext();
  mockComplete.mockResolvedValueOnce({
    intent: 'slot_accept',
    confidence: 0.95,
    resolvedIntent: 'slot_accept',
    response_text: 'Great!',
    extracted_preferences: null,
  });
  mockLockSlot.mockResolvedValueOnce(undefined);
  mockTransition.mockResolvedValueOnce('confirmed'); // slot_accepted
  mockFreeSlot.mockResolvedValueOnce(undefined);
  mockCancel.mockResolvedValueOnce(undefined);
  stubMessageInsert();
  mockRegenSummary.mockResolvedValueOnce(undefined);

  const result = await processIncomingMessage('conv-1', 'Yes that works!');

  expect(result).toMatchObject({ event: 'slot_accepted', newState: 'confirmed' });
  expect(mockLockSlot).toHaveBeenCalledWith('slot-new', 'client-1');
  expect(mockTransition).toHaveBeenCalledWith('conv-1', 'slot_accepted', {});
  expect(mockFreeSlot).toHaveBeenCalledWith('appt-original', 'biz-1');
  expect(mockCancel).toHaveBeenCalledWith('conv-1');
  expect(mockEmitConfirmed).toHaveBeenCalled();
});

// ─── slot_accepted + SlotConflictError → recovery to rescheduling ────────────

test('slot_accepted + SlotConflictError → rescheduling recovery, StateEngine NOT called with slot_accepted', async () => {
  stubLockAcquired();
  stubConversation({ state: 'slot_offered', offered_slot_id: 'slot-taken' });
  stubNoDistress();
  stubContext();
  mockComplete.mockResolvedValueOnce({
    intent: 'slot_accept',
    confidence: 0.95,
    resolvedIntent: 'slot_accept',
    response_text: 'Great!',
    extracted_preferences: null,
  });
  mockLockSlot.mockRejectedValueOnce(new SlotConflictError());
  // Raw DB update to rescheduling
  mockDbQuery.mockResolvedValueOnce({ rows: [] });
  stubMessageInsert();

  const result = await processIncomingMessage('conv-1', 'Yes');

  expect(result).toMatchObject({ event: 'slot_accepted', newState: 'rescheduling' });
  expect(result?.responseText).toContain('just taken');
  // stateEngine.applyTransition should NOT have been called with slot_accepted
  const slotAcceptedCall = mockTransition.mock.calls.find(c => c[1] === 'slot_accepted');
  expect(slotAcceptedCall).toBeUndefined();
  // Raw DB update should have set state to rescheduling
  const reschedulingUpdate = mockDbQuery.mock.calls.find(c =>
    typeof c[0] === 'string' && c[0].includes("state = 'rescheduling'")
  );
  expect(reschedulingUpdate).toBeDefined();
  expect(mockFreeSlot).not.toHaveBeenCalled();
  expect(mockEmitConfirmed).not.toHaveBeenCalled();
});

// ─── slot_declined → waitlisted ──────────────────────────────────────────────

test('slot_declined → waitlisted, waitlist_entry created', async () => {
  stubLockAcquired();
  stubConversation({ state: 'slot_offered', offered_slot_id: 'slot-new' });
  stubNoDistress();
  stubContext();
  mockComplete.mockResolvedValueOnce({
    intent: 'slot_decline',
    confidence: 0.90,
    resolvedIntent: 'slot_decline',
    response_text: "No worries — I'll add you to the waitlist.",
    extracted_preferences: 'morning slots only',
  });
  mockTransition.mockResolvedValueOnce('waitlisted'); // slot_declined
  // waitlist_entry INSERT
  mockDbQuery.mockResolvedValueOnce({ rows: [] });
  stubMessageInsert();
  mockRegenSummary.mockResolvedValueOnce(undefined);

  const result = await processIncomingMessage('conv-1', "No that doesn't work");

  expect(result).toMatchObject({ event: 'slot_declined', newState: 'waitlisted' });
  const waitlistInsert = mockDbQuery.mock.calls.find(c =>
    typeof c[0] === 'string' && c[0].includes('waitlist_entry')
  );
  expect(waitlistInsert).toBeDefined();
  expect(mockFreeSlot).not.toHaveBeenCalled();
  expect(mockLockSlot).not.toHaveBeenCalled();
});

// ─── Ambiguous in rescheduling → stays rescheduling ──────────────────────────

test('ambiguous message in rescheduling → stays rescheduling (self-loop), no waitlist created', async () => {
  stubLockAcquired();
  stubConversation({ state: 'rescheduling', consecutive_ambiguous_count: 0 });
  stubNoDistress();
  stubAvailableSlotsQuery([]);
  stubContext();
  mockComplete.mockResolvedValueOnce({
    intent: 'ambiguous',
    confidence: 0.40,
    resolvedIntent: 'ambiguous',
    response_text: 'Could you clarify your preference?',
    extracted_preferences: null,
  });
  mockTransition.mockResolvedValueOnce('rescheduling'); // ambiguous_message self-loop
  // ambiguous count increment
  mockDbQuery.mockResolvedValueOnce({ rows: [] });
  stubMessageInsert();
  mockRegenSummary.mockResolvedValueOnce(undefined);

  const result = await processIncomingMessage('conv-1', 'hmm');

  expect(result).toMatchObject({ event: 'ambiguous_message', newState: 'rescheduling' });
  expect(mockTransition).toHaveBeenCalledWith('conv-1', 'ambiguous_message', { targetState: 'rescheduling' });
  const waitlistInsert = mockDbQuery.mock.calls.find(c =>
    typeof c[0] === 'string' && c[0].includes('waitlist_entry')
  );
  expect(waitlistInsert).toBeUndefined();
});

// ─── extracted_preferences passed to findBestSlot ────────────────────────────

test('findMatchingSlots receives extracted_preferences from LLM response', async () => {
  stubLockAcquired();
  stubConversation({ state: 'rescheduling' });
  stubNoDistress();
  stubContext();
  mockComplete.mockResolvedValueOnce({
    intent: 'reschedule_preference',
    confidence: 0.85,
    resolvedIntent: 'reschedule_preference',
    response_text: 'Noted!',
    extracted_preferences: 'Tuesday afternoons',
    // No preferred_date_from → open-ended path → findMatchingSlots
  });
  mockFindMatchingSlots.mockResolvedValueOnce([]); // no slots → stays in rescheduling
  mockDbQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE conversation SET state = 'rescheduling'
  stubMessageInsert();

  await processIncomingMessage('conv-1', 'Tuesdays work');

  expect(mockFindMatchingSlots).toHaveBeenCalledWith('biz-1', 'Tuesday afternoons', 'appt-original', expect.any(String), 3);
});

// ─── slot_offered state — available slots not queried (only queried in rescheduling) ───────

test('slot_offered state: LLM called directly without message_received transition', async () => {
  stubLockAcquired();
  stubConversation({ state: 'slot_offered', offered_slot_id: 'slot-new' });
  stubNoDistress();
  // No available-slots query (only for rescheduling state)
  stubContext();
  mockComplete.mockResolvedValueOnce({
    intent: 'question',
    confidence: 0.85,
    resolvedIntent: 'question',
    response_text: "Yes, parking is available.",
    extracted_preferences: null,
  });
  mockTransition.mockResolvedValueOnce('slot_offered'); // question_intent self-loop
  stubMessageInsert();
  mockRegenSummary.mockResolvedValueOnce(undefined);

  const result = await processIncomingMessage('conv-1', 'Is there parking?');

  // message_received should NOT have been called
  const msgReceivedCall = mockTransition.mock.calls.find(c => c[1] === 'message_received');
  expect(msgReceivedCall).toBeUndefined();
  expect(result).toMatchObject({ event: 'question_intent', newState: 'slot_offered' });
});
