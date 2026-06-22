import { StateEngine, InvalidTransitionError } from '../ai/stateEngine';
import { ConversationState, ConversationEvent } from '../ai/types';

jest.mock('../db', () => ({
  db: { query: jest.fn() },
}));

import { db } from '../db';
const mockQuery = db.query as jest.Mock;

function stubState(state: ConversationState, ambiguousCount = 0) {
  mockQuery.mockResolvedValueOnce({ rows: [{ state, consecutive_ambiguous_count: ambiguousCount }] });
  mockQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE
}

function stubMissing() {
  mockQuery.mockResolvedValueOnce({ rows: [] });
}

let engine: StateEngine;
beforeEach(() => {
  engine = new StateEngine();
  jest.resetAllMocks();
});

// ─── Helper ──────────────────────────────────────────────────────────────────

async function transition(
  from: ConversationState,
  event: ConversationEvent,
  extras: Parameters<StateEngine['applyTransition']>[2] = {},
) {
  stubState(from);
  return engine.applyTransition('conv-1', event, extras);
}

// ─── All valid single-target transitions ─────────────────────────────────────

describe('single-target transitions', () => {
  const cases: [ConversationState, ConversationEvent, ConversationState][] = [
    ['idle',              'outreach_triggered',             'awaiting_reply'],
    ['awaiting_reply',    'message_received',               'processing'],
    ['awaiting_reply',    'follow_up_timer_fired',          'awaiting_reply'],
    ['awaiting_reply',    'deadline_reached',               'no_response'],
    ['awaiting_reply',    'staff_takeover',                 'staff_active'],
    ['processing',        'confirmation_intent',            'confirming'],
    ['processing',        'decline_intent',                 'rescheduling'],
    ['processing',        'question_intent',                'awaiting_reply'],
    ['processing',        'reschedule_preference_given',    'rescheduling'],
    ['processing',        'human_requested',                'escalated'],
    ['processing',        'opt_out',                        'cancelled'],
    ['processing',        'llm_api_failure',                'escalated'],
    ['processing',        'booking_routed_to_staff',        'awaiting_approval'],
    ['confirming',        'confirmation_intent',            'confirmed'],
    ['confirming',        'decline_intent',                 'rescheduling'],
    ['confirming',        'ambiguous_message',              'confirming'],
    ['confirming',        'message_received',               'confirming'],
    ['confirming',        'deadline_reached',               'no_response'],
    ['confirming',        'staff_takeover',                 'staff_active'],
    ['rescheduling',      'staff_takeover',                 'staff_active'],
    ['slot_offered',      'slot_accepted',                  'confirmed'],
    ['slot_offered',      'slot_declined',                  'waitlisted'],
    ['slot_offered',      'staff_takeover',                 'staff_active'],
    ['waitlisted',        'waitlist_match_found',           'slot_offered'],
    ['waitlisted',        'waitlist_no_match',              'waitlisted'],
    ['waitlisted',        'staff_takeover',                 'staff_active'],
    ['escalated',         'staff_takeover',                 'staff_active'],
    ['escalated',         'staff_forces_close',             'resolved'],
    ['staff_active',      'staff_returns_to_ai',            'awaiting_reply'],
    ['staff_active',      'staff_forces_close',             'resolved'],
    ['no_response',       'staff_resumes_after_no_response','awaiting_reply'],
    ['no_response',       'staff_forces_close',             'resolved'],
    ['awaiting_approval', 'message_received',               'awaiting_approval'],
    ['awaiting_approval', 'staff_approved_booking',         'slot_offered'],
    ['awaiting_approval', 'staff_takeover',                 'staff_active'],
    ['confirmed',         'message_received',               'confirmed'],
    ['confirmed',         'staff_forces_close',             'resolved'],
    ['cancelled',         'staff_forces_close',             'resolved'],
    // Spec escalation overrides — valid from any state where client messages arrive
    ['confirming',        'human_requested',                'escalated'],
    ['confirming',        'llm_api_failure',                'escalated'],
    ['confirming',        'opt_out',                        'cancelled'],
    ['rescheduling',      'human_requested',                'escalated'],
    ['rescheduling',      'llm_api_failure',                'escalated'],
    ['rescheduling',      'opt_out',                        'cancelled'],
    ['slot_offered',      'human_requested',                'escalated'],
    ['slot_offered',      'llm_api_failure',                'escalated'],
    ['slot_offered',      'opt_out',                        'cancelled'],
  ];

  test.each(cases)('%s + %s → %s', async (from, event, expected) => {
    const result = await transition(from, event);
    expect(result).toBe(expected);
  });
});

// ─── Multi-target conditional transitions (caller must specify targetState) ──

describe('conditional transitions', () => {
  test('processing + off_topic_message → awaiting_reply', async () => {
    const result = await transition('processing', 'off_topic_message', { targetState: 'awaiting_reply' });
    expect(result).toBe('awaiting_reply');
  });

  test('processing + off_topic_message → escalated', async () => {
    const result = await transition('processing', 'off_topic_message', { targetState: 'escalated' });
    expect(result).toBe('escalated');
  });

  test('processing + ambiguous_message → awaiting_reply', async () => {
    const result = await transition('processing', 'ambiguous_message', { targetState: 'awaiting_reply' });
    expect(result).toBe('awaiting_reply');
  });

  test('processing + ambiguous_message → escalated', async () => {
    const result = await transition('processing', 'ambiguous_message', { targetState: 'escalated' });
    expect(result).toBe('escalated');
  });

  test('rescheduling + reschedule_preference_given → slot_offered', async () => {
    const result = await transition('rescheduling', 'reschedule_preference_given', { targetState: 'slot_offered' });
    expect(result).toBe('slot_offered');
  });

  test('rescheduling + reschedule_preference_given → waitlisted', async () => {
    const result = await transition('rescheduling', 'reschedule_preference_given', { targetState: 'waitlisted' });
    expect(result).toBe('waitlisted');
  });

  test('awaiting_approval + staff_rejected_booking → slot_offered', async () => {
    const result = await transition('awaiting_approval', 'staff_rejected_booking', { targetState: 'slot_offered' });
    expect(result).toBe('slot_offered');
  });

  test('awaiting_approval + staff_rejected_booking → waitlisted', async () => {
    const result = await transition('awaiting_approval', 'staff_rejected_booking', { targetState: 'waitlisted' });
    expect(result).toBe('waitlisted');
  });

  test('awaiting_approval + approval_timeout → slot_offered', async () => {
    const result = await transition('awaiting_approval', 'approval_timeout', { targetState: 'slot_offered' });
    expect(result).toBe('slot_offered');
  });

  test('awaiting_approval + approval_timeout → waitlisted', async () => {
    const result = await transition('awaiting_approval', 'approval_timeout', { targetState: 'waitlisted' });
    expect(result).toBe('waitlisted');
  });

  test('ambiguous multi-target with no targetState throws', async () => {
    stubState('processing');
    await expect(engine.applyTransition('conv-1', 'off_topic_message')).rejects.toThrow('Ambiguous transition');
  });

  test('targetState not in allowed list throws InvalidTransitionError', async () => {
    stubState('processing');
    await expect(
      engine.applyTransition('conv-1', 'off_topic_message', { targetState: 'confirmed' }),
    ).rejects.toThrow(InvalidTransitionError);
  });
});

// ─── Invalid transitions ──────────────────────────────────────────────────────

describe('invalid transitions throw InvalidTransitionError', () => {
  const invalid: [ConversationState, ConversationEvent][] = [
    ['idle',       'message_received'],
    ['confirmed',  'outreach_triggered'],
    ['resolved',   'message_received'],
    ['cancelled',  'message_received'],
    ['confirmed',  'confirmation_intent'],
    ['no_response','confirmation_intent'],
  ];

  test.each(invalid)('%s + %s → throws', async (from, event) => {
    stubState(from);
    await expect(engine.applyTransition('conv-1', event)).rejects.toThrow(InvalidTransitionError);
  });
});

// ─── Missing conversation ─────────────────────────────────────────────────────

test('throws when conversation not found', async () => {
  stubMissing();
  await expect(engine.applyTransition('missing-id', 'outreach_triggered')).rejects.toThrow('Conversation not found');
});

// ─── consecutive_ambiguous_count reset ───────────────────────────────────────

describe('consecutive_ambiguous_count resets on clear intent', () => {
  const clearIntentCases: [ConversationState, ConversationEvent][] = [
    ['processing', 'confirmation_intent'],
    ['processing', 'decline_intent'],
    ['processing', 'question_intent'],
    ['processing', 'human_requested'],
    ['processing', 'opt_out'],
    ['slot_offered', 'slot_accepted'],
    ['slot_offered', 'slot_declined'],
  ];

  test.each(clearIntentCases)('%s + %s resets count', async (from, event) => {
    stubState(from, 2);
    await engine.applyTransition('conv-1', event);
    const updateCall = mockQuery.mock.calls[1];
    const resetFlag = updateCall[1][3]; // 4th param = resetAmbiguous
    expect(resetFlag).toBe(true);
  });

  test('off_topic_message does NOT reset count', async () => {
    stubState('processing', 1);
    await engine.applyTransition('conv-1', 'off_topic_message', { targetState: 'awaiting_reply' });
    const updateCall = mockQuery.mock.calls[1];
    const resetFlag = updateCall[1][3];
    expect(resetFlag).toBe(false);
  });

  test('ambiguous_message does NOT reset count', async () => {
    stubState('processing', 1);
    await engine.applyTransition('conv-1', 'ambiguous_message', { targetState: 'awaiting_reply' });
    const updateCall = mockQuery.mock.calls[1];
    const resetFlag = updateCall[1][3];
    expect(resetFlag).toBe(false);
  });
});

// ─── Extras passed through to DB ─────────────────────────────────────────────

test('escalationReason is written on escalation transition', async () => {
  stubState('processing');
  await engine.applyTransition('conv-1', 'human_requested', { escalationReason: 'client_requested_human' });
  const updateCall = mockQuery.mock.calls[1];
  expect(updateCall[1][1]).toBe('client_requested_human');
});

test('offeredSlotId is written when provided', async () => {
  stubState('rescheduling');
  const slotId = 'slot-uuid-123';
  await engine.applyTransition('conv-1', 'reschedule_preference_given', {
    targetState: 'slot_offered',
    offeredSlotId: slotId,
  });
  const updateCall = mockQuery.mock.calls[1];
  expect(updateCall[1][2]).toBe(slotId);
});
