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

import { db } from '../db';
import { redisConnection } from '../jobs/connection';
import { stateEngine } from '../ai/stateEngine';
import { llmClient } from '../ai/llmInstance';
import { isDistressMessage } from '../ai/keywords';
import { getConversationContext, regenerateSummary } from '../ai/contextWindow';

const mockDbQuery      = db.query as jest.Mock;
const mockRedisSet     = redisConnection.set as jest.Mock;
const mockRedisDel     = redisConnection.del as jest.Mock;
const mockRedisRpush   = redisConnection.rpush as jest.Mock;
const mockRedisLpop    = redisConnection.lpop as jest.Mock;
const mockTransition   = stateEngine.applyTransition as jest.Mock;
const mockComplete     = llmClient.complete as jest.Mock;
const mockSummarize    = llmClient.summarize as jest.Mock;
const mockDistress     = isDistressMessage as jest.Mock;
const mockGetContext   = getConversationContext as jest.Mock;
const mockRegenSummary = regenerateSummary as jest.Mock;

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
      starts_at: new Date('2026-06-01T10:00:00Z'),
      service_type: 'Haircut',
      client_id: 'client-1',
      client_name: 'Alice',
      ...overrides,
    }],
  });
}

function stubLLMResponse(intent: string, confidence: number, responseText = 'AI reply') {
  mockComplete.mockResolvedValueOnce({
    intent,
    confidence,
    resolvedIntent: confidence >= 0.75 ? intent : 'ambiguous',
    response_text: responseText,
    extracted_preferences: null,
  });
}

function stubContext() {
  mockGetContext.mockResolvedValueOnce({ messages: [], contextSummary: null });
}

function stubMessageInsert() {
  mockDbQuery.mockResolvedValueOnce({ rows: [] });
}

function stubNoDistress() {
  mockDistress.mockReturnValueOnce(false);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => jest.resetAllMocks());

// ─── Concurrency guard ───────────────────────────────────────────────────────

test('returns null and queues message when lock is already held', async () => {
  mockRedisSet.mockResolvedValueOnce(null); // lock not acquired
  const result = await processIncomingMessage('conv-1', 'hello');
  expect(result).toBeNull();
  expect(mockRedisRpush).toHaveBeenCalledWith('queue:conversation:conv-1', 'hello');
});

// ─── Happy path: high-confidence confirm ─────────────────────────────────────

test('high-confidence confirm intent → confirmation_intent event → confirming state', async () => {
  stubLockAcquired();
  stubConversation();
  stubNoDistress();
  mockTransition.mockResolvedValueOnce('processing'); // message_received
  stubContext();
  stubLLMResponse('confirm', 0.95, 'Just to confirm — your haircut on June 1st. Shall I lock it in?');
  mockTransition.mockResolvedValueOnce('confirming'); // confirmation_intent
  stubMessageInsert();
  mockRegenSummary.mockResolvedValueOnce(undefined);

  const result = await processIncomingMessage('conv-1', 'yes');

  expect(result).toMatchObject({
    event: 'confirmation_intent',
    newState: 'confirming',
    responseText: 'Just to confirm — your haircut on June 1st. Shall I lock it in?',
  });
  expect(mockTransition).toHaveBeenNthCalledWith(1, 'conv-1', 'message_received');
  expect(mockTransition).toHaveBeenNthCalledWith(2, 'conv-1', 'confirmation_intent', {});
});

// ─── Confidence routing ───────────────────────────────────────────────────────

test('confidence 0.60 → intent overridden to ambiguous → first occurrence → awaiting_reply', async () => {
  stubLockAcquired();
  stubConversation({ consecutive_ambiguous_count: 0 });
  stubNoDistress();
  mockTransition.mockResolvedValueOnce('processing');
  stubContext();
  // LLMClient already applies threshold internally; resolvedIntent = 'ambiguous' for conf < 0.75
  mockComplete.mockResolvedValueOnce({
    intent: 'confirm',
    confidence: 0.60,
    resolvedIntent: 'ambiguous',
    response_text: 'Sorry, could you confirm — are you able to make it?',
    extracted_preferences: null,
  });
  mockTransition.mockResolvedValueOnce('awaiting_reply'); // ambiguous_message first occurrence
  mockDbQuery.mockResolvedValueOnce({ rows: [] }); // increment ambiguous count
  stubMessageInsert();
  mockRegenSummary.mockResolvedValueOnce(undefined);

  const result = await processIncomingMessage('conv-1', 'maybe');

  expect(result).toMatchObject({ event: 'ambiguous_message', newState: 'awaiting_reply' });
  expect(mockTransition).toHaveBeenNthCalledWith(2, 'conv-1', 'ambiguous_message', { targetState: 'awaiting_reply' });
});

// ─── Ambiguous second occurrence → escalation ────────────────────────────────

test('second ambiguous message → escalated with repeated_ambiguous_message reason', async () => {
  stubLockAcquired();
  stubConversation({ consecutive_ambiguous_count: 1 });
  stubNoDistress();
  mockTransition.mockResolvedValueOnce('processing');
  stubContext();
  mockComplete.mockResolvedValueOnce({
    intent: 'ambiguous',
    confidence: 0.40,
    resolvedIntent: 'ambiguous',
    response_text: 'Escalating...',
    extracted_preferences: null,
  });
  mockTransition.mockResolvedValueOnce('escalated');
  stubMessageInsert();
  mockRegenSummary.mockResolvedValueOnce(undefined);

  const result = await processIncomingMessage('conv-1', 'hmm');

  expect(result).toMatchObject({ event: 'ambiguous_message', newState: 'escalated' });
  expect(mockTransition).toHaveBeenNthCalledWith(2, 'conv-1', 'ambiguous_message', {
    targetState: 'escalated',
    escalationReason: 'repeated_ambiguous_message',
  });
});

// ─── Off-topic second occurrence → escalation ────────────────────────────────

test('second off_topic message → escalated with repeated_off_topic_message reason', async () => {
  stubLockAcquired();
  stubConversation({ consecutive_ambiguous_count: 1 });
  stubNoDistress();
  mockTransition.mockResolvedValueOnce('processing');
  stubContext();
  mockComplete.mockResolvedValueOnce({
    intent: 'off_topic',
    confidence: 0.90,
    resolvedIntent: 'off_topic',
    response_text: 'Escalating...',
    extracted_preferences: null,
  });
  mockTransition.mockResolvedValueOnce('escalated');
  stubMessageInsert();
  mockRegenSummary.mockResolvedValueOnce(undefined);

  const result = await processIncomingMessage('conv-1', 'what is the weather today?');

  expect(mockTransition).toHaveBeenNthCalledWith(2, 'conv-1', 'off_topic_message', {
    targetState: 'escalated',
    escalationReason: 'repeated_off_topic_message',
  });
  expect(result?.newState).toBe('escalated');
});

// ─── Distress keyword → escalation, bypasses LLM ────────────────────────────

test('distress keyword → human_requested fired without LLM call', async () => {
  stubLockAcquired();
  stubConversation();
  mockDistress.mockReturnValueOnce(true);
  mockTransition.mockResolvedValueOnce('processing');  // message_received
  mockTransition.mockResolvedValueOnce('escalated');   // human_requested
  stubMessageInsert();

  const result = await processIncomingMessage('conv-1', 'I need a lawyer');

  expect(mockComplete).not.toHaveBeenCalled();
  expect(mockTransition).toHaveBeenNthCalledWith(2, 'conv-1', 'human_requested', {
    escalationReason: 'distress_keyword',
  });
  expect(result).toMatchObject({ event: 'human_requested', newState: 'escalated' });
});

// ─── LLM failure → escalation ────────────────────────────────────────────────

test('LLMTimeoutError → llm_api_failure event → escalated', async () => {
  const { LLMTimeoutError } = await import('../ai/types');
  stubLockAcquired();
  stubConversation();
  stubNoDistress();
  mockTransition.mockResolvedValueOnce('processing');
  stubContext();
  mockComplete.mockRejectedValueOnce(new LLMTimeoutError());
  mockTransition.mockResolvedValueOnce('escalated');
  stubMessageInsert();

  const result = await processIncomingMessage('conv-1', 'hello');

  expect(result).toMatchObject({ event: 'llm_api_failure', newState: 'escalated' });
  expect(mockTransition).toHaveBeenNthCalledWith(2, 'conv-1', 'llm_api_failure', {
    escalationReason: 'llm_api_failure',
  });
});

test('LLMParseError → llm_api_failure event → escalated', async () => {
  const { LLMParseError } = await import('../ai/types');
  stubLockAcquired();
  stubConversation();
  stubNoDistress();
  mockTransition.mockResolvedValueOnce('processing');
  stubContext();
  mockComplete.mockRejectedValueOnce(new LLMParseError('bad json'));
  mockTransition.mockResolvedValueOnce('escalated');
  stubMessageInsert();

  const result = await processIncomingMessage('conv-1', 'hello');

  expect(result).toMatchObject({ event: 'llm_api_failure', newState: 'escalated' });
});

// ─── awaiting_approval → holding reply ───────────────────────────────────────

test('awaiting_approval state → holding reply without LLM call', async () => {
  stubLockAcquired();
  stubConversation({ state: 'awaiting_approval' });
  mockTransition.mockResolvedValueOnce('awaiting_approval');
  stubMessageInsert();

  const result = await processIncomingMessage('conv-1', 'anything');

  expect(mockComplete).not.toHaveBeenCalled();
  expect(mockDistress).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    event: 'message_received',
    newState: 'awaiting_approval',
    responseText: expect.stringContaining('still waiting'),
  });
});

// ─── Context summary regenerated ─────────────────────────────────────────────

test('regenerateSummary is called after storing AI message', async () => {
  stubLockAcquired();
  stubConversation();
  stubNoDistress();
  mockTransition.mockResolvedValueOnce('processing');
  stubContext();
  stubLLMResponse('confirm', 0.90);
  mockTransition.mockResolvedValueOnce('confirming');
  stubMessageInsert();
  mockRegenSummary.mockResolvedValueOnce(undefined);

  await processIncomingMessage('conv-1', 'yes');

  expect(mockRegenSummary).toHaveBeenCalledWith('conv-1', expect.any(Function));
});

// ─── human_requested intent → escalation_reason set ─────────────────────────

test('human_requested intent sets client_requested_human escalation reason', async () => {
  stubLockAcquired();
  stubConversation();
  stubNoDistress();
  mockTransition.mockResolvedValueOnce('processing');
  stubContext();
  mockComplete.mockResolvedValueOnce({
    intent: 'human_requested',
    confidence: 0.95,
    resolvedIntent: 'human_requested',
    response_text: "I'll connect you with our team.",
    extracted_preferences: null,
  });
  mockTransition.mockResolvedValueOnce('escalated');
  stubMessageInsert();
  mockRegenSummary.mockResolvedValueOnce(undefined);

  const result = await processIncomingMessage('conv-1', 'I want to talk to a person');

  expect(mockTransition).toHaveBeenNthCalledWith(2, 'conv-1', 'human_requested', {
    escalationReason: 'client_requested_human',
  });
  expect(result).toMatchObject({ event: 'human_requested', newState: 'escalated' });
});

// ─── booking_request intent ───────────────────────────────────────────────────

test('booking_request intent → booking_routed_to_staff event', async () => {
  stubLockAcquired();
  stubConversation();
  stubNoDistress();
  mockTransition.mockResolvedValueOnce('processing');
  stubContext();
  mockComplete.mockResolvedValueOnce({
    intent: 'booking_request',
    confidence: 0.85,
    resolvedIntent: 'booking_request',
    response_text: "I've passed your request to the office.",
    extracted_preferences: null,
  });
  mockTransition.mockResolvedValueOnce('awaiting_approval');
  stubMessageInsert();
  mockRegenSummary.mockResolvedValueOnce(undefined);

  const result = await processIncomingMessage('conv-1', 'Can I book a 90-min session?');

  expect(mockTransition).toHaveBeenNthCalledWith(2, 'conv-1', 'booking_routed_to_staff', {});
  expect(result).toMatchObject({ event: 'booking_routed_to_staff', newState: 'awaiting_approval' });
});

// ─── Distress from non-awaiting_reply state (e.g. confirming) ────────────────

test('distress in confirming state → escalates without message_received transition', async () => {
  stubLockAcquired();
  stubConversation({ state: 'confirming' });
  mockDistress.mockReturnValueOnce(true);
  mockTransition.mockResolvedValueOnce('escalated'); // human_requested directly from confirming
  stubMessageInsert();

  const result = await processIncomingMessage('conv-1', 'I need a lawyer');

  // Should NOT have fired message_received first
  expect(mockTransition).toHaveBeenCalledTimes(1);
  expect(mockTransition).toHaveBeenCalledWith('conv-1', 'human_requested', { escalationReason: 'distress_keyword' });
  expect(result).toMatchObject({ event: 'human_requested', newState: 'escalated' });
});
