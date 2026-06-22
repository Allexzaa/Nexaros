export type ConversationState =
  | 'idle'
  | 'awaiting_reply'
  | 'processing'
  | 'confirming'
  | 'rescheduling'
  | 'slot_offered'
  | 'waitlisted'
  | 'escalated'
  | 'staff_active'
  | 'confirmed'
  | 'no_response'
  | 'cancelled'
  | 'awaiting_approval'
  | 'resolved';

export type ConversationEvent =
  | 'outreach_triggered'
  | 'message_received'
  | 'follow_up_timer_fired'
  | 'deadline_reached'
  | 'staff_takeover'
  | 'confirmation_intent'
  | 'decline_intent'
  | 'question_intent'
  | 'reschedule_preference_given'
  | 'off_topic_message'
  | 'ambiguous_message'
  | 'human_requested'
  | 'opt_out'
  | 'llm_api_failure'
  | 'booking_routed_to_staff'
  | 'slot_accepted'
  | 'slot_declined'
  | 'waitlist_match_found'
  | 'waitlist_no_match'
  | 'staff_returns_to_ai'
  | 'staff_forces_close'
  | 'staff_resumes_after_no_response'
  | 'staff_approved_booking'
  | 'staff_rejected_booking'
  | 'approval_timeout';

export interface TransitionExtras {
  targetState?: ConversationState;
  escalationReason?: string;
  offeredSlotId?: string | null;
}

export class InvalidTransitionError extends Error {
  constructor(fromState: string, event: string) {
    super(`Invalid transition: ${event} from state ${fromState}`);
    this.name = 'InvalidTransitionError';
  }
}

export interface ProcessingResult {
  event: ConversationEvent;
  newState: ConversationState;
  responseText: string;
  extractedPreferences: string | null;
}

export type LLMIntent =
  | 'confirm'
  | 'decline'
  | 'question'
  | 'reschedule_preference'
  | 'slot_accept'
  | 'slot_decline'
  | 'opt_out'
  | 'off_topic'
  | 'ambiguous'
  | 'human_requested'
  | 'booking_request';

export type TimeOfDay = 'morning' | 'afternoon' | 'evening' | 'any';

export interface LLMResponse {
  intent: LLMIntent;
  confidence: number;        // 0.0 – 1.0 as returned by LLM
  resolvedIntent: LLMIntent; // after confidence threshold applied
  response_text: string;
  extracted_preferences: string | null;
  preferred_date_from: string | null; // YYYY-MM-DD — start of date range (LLM resolves relative dates)
  preferred_date_to:   string | null; // YYYY-MM-DD — end of date range
  preferred_time_of_day: TimeOfDay;   // bucket fallback — time bounds parsed by timeParser, not LLM
}

// Mirrors F003 LLM input protocol
export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

// ── F016 agent message types ──────────────────────────────────────────────────

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export type AgentMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; name: string; content: string };

export interface AgentLLMResponse {
  content: string | null;
  tool_calls: ToolCall[] | null;
}

export interface AgentResult {
  responseText: string;
  newState: ConversationState;
  toolsUsed: string[];
}

export class LLMParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LLMParseError';
  }
}

export class LLMTimeoutError extends Error {
  constructor() {
    super('LLM request timed out');
    this.name = 'LLMTimeoutError';
  }
}
