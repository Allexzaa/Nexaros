import { db } from '../db';
import {
  ConversationState,
  ConversationEvent,
  TransitionExtras,
  InvalidTransitionError,
} from './types';

export { InvalidTransitionError };

// Valid target states for each (fromState, event) pair.
// Single-element arrays are auto-resolved; multi-element require caller to specify targetState.
const TRANSITIONS: Partial<Record<string, ConversationState[]>> = {
  'idle:outreach_triggered':                    ['awaiting_reply'],
  'awaiting_reply:message_received':            ['processing'],
  'awaiting_reply:follow_up_timer_fired':       ['awaiting_reply'],
  'awaiting_reply:deadline_reached':            ['no_response'],
  'awaiting_reply:staff_takeover':              ['staff_active'],
  'processing:confirmation_intent':             ['confirming'],
  'processing:decline_intent':                  ['rescheduling'],
  'processing:question_intent':                 ['awaiting_reply'],
  'processing:reschedule_preference_given':     ['rescheduling'],
  'processing:off_topic_message':               ['awaiting_reply', 'escalated'],
  'processing:ambiguous_message':               ['awaiting_reply', 'escalated'],
  'processing:human_requested':                 ['escalated'],
  'processing:opt_out':                         ['cancelled'],
  'processing:llm_api_failure':                 ['escalated'],
  'processing:booking_routed_to_staff':         ['awaiting_approval'],
  'confirming:confirmation_intent':             ['confirmed'],
  'confirming:decline_intent':                  ['rescheduling'],
  'confirming:ambiguous_message':               ['confirming'],
  'confirming:message_received':                ['confirming'],
  'confirming:deadline_reached':                ['no_response'],
  'confirming:staff_takeover':                  ['staff_active'],
  'rescheduling:reschedule_preference_given':   ['slot_offered', 'waitlisted'],
  'rescheduling:staff_takeover':                ['staff_active'],
  'slot_offered:slot_accepted':                 ['confirmed'],
  'slot_offered:slot_declined':                 ['waitlisted'],
  'slot_offered:staff_takeover':                ['staff_active'],
  'waitlisted:waitlist_match_found':            ['slot_offered'],
  'waitlisted:waitlist_no_match':               ['waitlisted'],
  'waitlisted:staff_takeover':                  ['staff_active'],
  'escalated:staff_takeover':                   ['staff_active'],
  'escalated:staff_forces_close':               ['resolved'],
  'staff_active:staff_returns_to_ai':           ['awaiting_reply'],
  'staff_active:staff_forces_close':            ['resolved'],
  'no_response:staff_resumes_after_no_response': ['awaiting_reply'],
  'no_response:staff_forces_close':             ['resolved'],
  'awaiting_approval:message_received':         ['awaiting_approval'],
  'awaiting_approval:staff_approved_booking':   ['slot_offered'],
  'awaiting_approval:staff_rejected_booking':   ['slot_offered', 'waitlisted'],
  'awaiting_approval:approval_timeout':         ['slot_offered', 'waitlisted'],
  'awaiting_approval:staff_takeover':           ['staff_active'],
  // Self-loops for rescheduling — keep collecting prefs when client is ambiguous/off-topic
  'rescheduling:ambiguous_message':             ['rescheduling'],
  'rescheduling:off_topic_message':             ['rescheduling', 'escalated'],
  'rescheduling:question_intent':               ['rescheduling'],
  // Self-loops for slot_offered — re-prompt when client is unclear about accept/decline
  'slot_offered:ambiguous_message':             ['slot_offered'],
  'slot_offered:off_topic_message':             ['slot_offered', 'escalated'],
  'slot_offered:question_intent':               ['slot_offered'],
  // Spec escalation rule: "override any state" — distress / LLM failure / opt-out
  // from states where a client message can still arrive after the processing state
  'confirming:human_requested':                 ['escalated'],
  'confirming:llm_api_failure':                 ['escalated'],
  'confirming:opt_out':                         ['cancelled'],
  'rescheduling:human_requested':               ['escalated'],
  'rescheduling:llm_api_failure':               ['escalated'],
  'rescheduling:opt_out':                       ['cancelled'],
  'slot_offered:human_requested':               ['escalated'],
  'slot_offered:llm_api_failure':               ['escalated'],
  'slot_offered:opt_out':                       ['cancelled'],
  'confirmed:message_received':                 ['confirmed'],
  'confirmed:staff_forces_close':               ['resolved'],
  'cancelled:staff_forces_close':               ['resolved'],
};

// Events that represent a clear client intent — reset consecutive_ambiguous_count to 0.
const CLEAR_INTENT_EVENTS = new Set<ConversationEvent>([
  'confirmation_intent',
  'decline_intent',
  'question_intent',
  'reschedule_preference_given',
  'slot_accepted',
  'slot_declined',
  'opt_out',
  'human_requested',
  'outreach_triggered',
]);

export class StateEngine {
  async applyTransition(
    conversationId: string,
    event: ConversationEvent,
    extras: TransitionExtras = {},
  ): Promise<ConversationState> {
    const { rows } = await db.query<{ state: ConversationState; consecutive_ambiguous_count: number }>(
      'SELECT state, consecutive_ambiguous_count FROM conversation WHERE id = $1',
      [conversationId],
    );

    if (rows.length === 0) throw new Error(`Conversation not found: ${conversationId}`);

    const fromState = rows[0].state;
    const key = `${fromState}:${event}`;
    const allowed = TRANSITIONS[key];

    if (!allowed) throw new InvalidTransitionError(fromState, event);

    let toState: ConversationState;

    if (allowed.length === 1) {
      toState = allowed[0];
    } else if (extras.targetState && allowed.includes(extras.targetState)) {
      toState = extras.targetState;
    } else if (extras.targetState) {
      throw new InvalidTransitionError(fromState, `${event} → ${extras.targetState} (not in allowed targets: ${allowed.join(', ')})`);
    } else {
      throw new Error(`Ambiguous transition ${key}: multiple targets ${allowed.join(', ')} — caller must specify targetState`);
    }

    const resetAmbiguous = CLEAR_INTENT_EVENTS.has(event);

    await db.query(
      `UPDATE conversation SET
        state = $1,
        escalation_reason    = CASE WHEN $2::text IS NOT NULL THEN $2::text ELSE escalation_reason END,
        offered_slot_id      = CASE WHEN $3::uuid IS NOT NULL THEN $3::uuid ELSE offered_slot_id END,
        consecutive_ambiguous_count = CASE WHEN $4 THEN 0 ELSE consecutive_ambiguous_count END
       WHERE id = $5`,
      [toState, extras.escalationReason ?? null, extras.offeredSlotId ?? null, resetAmbiguous, conversationId],
    );

    return toState;
  }
}

export const stateEngine = new StateEngine();
