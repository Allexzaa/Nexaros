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
jest.mock('../jobs/scheduler', () => ({ cancelJobsByConversationId: jest.fn() }));
jest.mock('../realtime/emitters', () => ({
  emitAppointmentConfirmed: jest.fn(),
  emitEscalation: jest.fn(),
  emitBookingRequestPending: jest.fn(),
}));
jest.mock('../services/slotManager', () => ({
  findBestSlot: jest.fn(),
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
import { emitEscalation, emitBookingRequestPending } from '../realtime/emitters';

const mockDbQuery      = db.query as jest.Mock;
const mockRedisSet     = redisConnection.set as jest.Mock;
const mockRedisDel     = redisConnection.del as jest.Mock;
const mockRedisLpop    = redisConnection.lpop as jest.Mock;
const mockTransition   = stateEngine.applyTransition as jest.Mock;
const mockComplete     = llmClient.complete as jest.Mock;
const mockDistress     = isDistressMessage as jest.Mock;
const mockGetContext   = getConversationContext as jest.Mock;
const mockRegenSummary = regenerateSummary as jest.Mock;
const mockEmitEsc      = emitEscalation as jest.Mock;
const mockEmitBooking  = emitBookingRequestPending as jest.Mock;

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
      appointment_id: 'appt-1',
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
function stubDistress()   { mockDistress.mockReturnValueOnce(true); }

function stubContext() {
  mockGetContext.mockResolvedValueOnce({ messages: [], contextSummary: null });
}

function stubMessageInsert() {
  mockDbQuery.mockResolvedValueOnce({ rows: [] });
}

beforeEach(() => jest.resetAllMocks());

// ─── Escalation: human_requested intent ──────────────────────────────────────

test('human_requested intent → escalated, emitEscalation with client_requested_human', async () => {
  stubLockAcquired();
  stubConversation();
  stubNoDistress();
  mockTransition.mockResolvedValueOnce('processing'); // message_received
  stubContext();
  mockComplete.mockResolvedValueOnce({
    intent: 'human_requested', confidence: 0.95, resolvedIntent: 'human_requested',
    response_text: "I'll connect you with our team.",
    extracted_preferences: null,
  });
  mockTransition.mockResolvedValueOnce('escalated'); // human_requested
  stubMessageInsert();
  mockRegenSummary.mockResolvedValueOnce(undefined);

  const result = await processIncomingMessage('conv-1', 'I want to talk to a person');

  expect(result).toMatchObject({ event: 'human_requested', newState: 'escalated' });
  expect(mockEmitEsc).toHaveBeenCalledWith('biz-1', 'conv-1', 'Alice', 'client_requested_human');
});

// ─── Escalation: distress keyword ────────────────────────────────────────────

test('distress keyword → escalated, emitEscalation with distress_keyword', async () => {
  stubLockAcquired();
  stubConversation();
  stubDistress();
  mockTransition.mockResolvedValueOnce('processing'); // message_received
  mockTransition.mockResolvedValueOnce('escalated');  // human_requested
  stubMessageInsert();

  await processIncomingMessage('conv-1', 'I need help now');

  expect(mockEmitEsc).toHaveBeenCalledWith('biz-1', 'conv-1', 'Alice', 'distress_keyword');
  expect(mockComplete).not.toHaveBeenCalled();
});

// ─── Escalation: LLM failure ─────────────────────────────────────────────────

test('LLMParseError → escalated, emitEscalation with llm_api_failure', async () => {
  const { LLMParseError } = await import('../ai/types');
  stubLockAcquired();
  stubConversation();
  stubNoDistress();
  mockTransition.mockResolvedValueOnce('processing');
  stubContext();
  mockComplete.mockRejectedValueOnce(new LLMParseError('bad json'));
  mockTransition.mockResolvedValueOnce('escalated');
  stubMessageInsert();

  await processIncomingMessage('conv-1', 'hello');

  expect(mockEmitEsc).toHaveBeenCalledWith('biz-1', 'conv-1', 'Alice', 'llm_api_failure');
});

// ─── Escalation: second ambiguous message ────────────────────────────────────

test('second ambiguous → escalated, emitEscalation with repeated_ambiguous_message', async () => {
  stubLockAcquired();
  stubConversation({ consecutive_ambiguous_count: 1 });
  stubNoDistress();
  mockTransition.mockResolvedValueOnce('processing');
  stubContext();
  mockComplete.mockResolvedValueOnce({
    intent: 'ambiguous', confidence: 0.40, resolvedIntent: 'ambiguous',
    response_text: 'Escalating...', extracted_preferences: null,
  });
  mockTransition.mockResolvedValueOnce('escalated'); // ambiguous_message
  stubMessageInsert();
  mockRegenSummary.mockResolvedValueOnce(undefined);

  await processIncomingMessage('conv-1', 'hmm');

  expect(mockEmitEsc).toHaveBeenCalledWith('biz-1', 'conv-1', 'Alice', 'repeated_ambiguous_message');
});

// ─── Escalation: second off_topic message ────────────────────────────────────

test('second off_topic → escalated, emitEscalation with repeated_off_topic_message', async () => {
  stubLockAcquired();
  stubConversation({ consecutive_ambiguous_count: 1 });
  stubNoDistress();
  mockTransition.mockResolvedValueOnce('processing');
  stubContext();
  mockComplete.mockResolvedValueOnce({
    intent: 'off_topic', confidence: 0.90, resolvedIntent: 'off_topic',
    response_text: 'Escalating...', extracted_preferences: null,
  });
  mockTransition.mockResolvedValueOnce('escalated'); // off_topic_message
  stubMessageInsert();
  mockRegenSummary.mockResolvedValueOnce(undefined);

  await processIncomingMessage('conv-1', 'what is the weather?');

  expect(mockEmitEsc).toHaveBeenCalledWith('biz-1', 'conv-1', 'Alice', 'repeated_off_topic_message');
});

// ─── opt_out → cancelled, NOT escalated ──────────────────────────────────────

test('opt_out → cancelled, emitEscalation NOT called', async () => {
  stubLockAcquired();
  stubConversation();
  stubNoDistress();
  mockTransition.mockResolvedValueOnce('processing');
  stubContext();
  mockComplete.mockResolvedValueOnce({
    intent: 'opt_out', confidence: 0.95, resolvedIntent: 'opt_out',
    response_text: "You've been unsubscribed.", extracted_preferences: null,
  });
  mockTransition.mockResolvedValueOnce('cancelled'); // opt_out
  stubMessageInsert();
  mockRegenSummary.mockResolvedValueOnce(undefined);

  const result = await processIncomingMessage('conv-1', 'STOP');

  expect(result).toMatchObject({ event: 'opt_out', newState: 'cancelled' });
  expect(mockEmitEsc).not.toHaveBeenCalled();
});

// ─── booking_routed_to_staff → emitBookingRequestPending ────────────────────

test('booking_routed_to_staff → awaiting_approval, emitBookingRequestPending fired', async () => {
  stubLockAcquired();
  stubConversation();
  stubNoDistress();
  mockTransition.mockResolvedValueOnce('processing');
  stubContext();
  mockComplete.mockResolvedValueOnce({
    intent: 'booking_request', confidence: 0.88, resolvedIntent: 'booking_request',
    response_text: "I've passed your request to the office.",
    extracted_preferences: null,
  });
  mockTransition.mockResolvedValueOnce('awaiting_approval'); // booking_routed_to_staff
  stubMessageInsert();
  mockRegenSummary.mockResolvedValueOnce(undefined);

  const result = await processIncomingMessage('conv-1', 'Can I book a 2-hour session?');

  expect(result).toMatchObject({ event: 'booking_routed_to_staff', newState: 'awaiting_approval' });
  expect(mockEmitBooking).toHaveBeenCalledWith('biz-1', 'conv-1', 'Alice');
  expect(mockEmitEsc).not.toHaveBeenCalled();
});
