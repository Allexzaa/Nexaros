/**
 * F016 — Conversational AI: State guard
 *
 * Validates whether a tool call is permitted in the current conversation state.
 * The LLM drives the conversation; this guard prevents impossible or dangerous actions.
 */

import { ConversationState } from './types';
import { ToolName } from './tools';

// States where the AI agent is actively in control
const ACTIVE_STATES = new Set<ConversationState>([
  'awaiting_reply',
  'processing',
  'rescheduling',
  'slot_offered',
  'confirming',
  'awaiting_approval',
]);

// Per-tool allowlists
const TOOL_ALLOWED_STATES: Record<ToolName, Set<ConversationState> | 'any'> = {
  // Read-only — always safe
  get_appointment_details: 'any',
  check_availability:      'any',

  // Destructive — only when AI is actively managing the conversation
  confirm_appointment:       ACTIVE_STATES,
  reschedule_appointment:    ACTIVE_STATES,
  cancel_appointment:        ACTIVE_STATES,

  // Always valid regardless of state
  opt_out_client:            'any',
  request_human_takeover:    'any',
};

export class StateGuardError extends Error {
  constructor(tool: ToolName, state: ConversationState) {
    super(`Tool "${tool}" is not allowed in state "${state}"`);
    this.name = 'StateGuardError';
  }
}

export function validateToolCall(tool: ToolName, state: ConversationState): void {
  const allowed = TOOL_ALLOWED_STATES[tool];
  if (allowed === 'any') return;
  if (!allowed.has(state)) throw new StateGuardError(tool, state);
}

export function isAllowed(tool: ToolName, state: ConversationState): boolean {
  const allowed = TOOL_ALLOWED_STATES[tool];
  if (allowed === 'any') return true;
  return allowed.has(state);
}
