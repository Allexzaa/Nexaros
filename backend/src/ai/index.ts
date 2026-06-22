export { llmClient } from './llmInstance';

export { LLMClient } from './client';
export { isDistressMessage } from './keywords';
export { getConversationContext, regenerateSummary } from './contextWindow';
export { stateEngine, StateEngine } from './stateEngine';
export { processIncomingMessage } from './messageProcessor';
export { runConversationAgent } from './conversationAgent';
export { LLMParseError, LLMTimeoutError, InvalidTransitionError } from './types';
export type {
  LLMResponse,
  LLMIntent,
  ConversationMessage,
  ConversationState,
  ConversationEvent,
  TransitionExtras,
  ProcessingResult,
} from './types';
