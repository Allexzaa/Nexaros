/**
 * F016 — Conversational AI: Agent loop (Phase 4 — active path)
 *
 * This file is the active AI processor. messageProcessor.ts is retained
 * for its existing tests but is no longer called from any route.
 */

import { db } from '../db';
import { redisConnection } from '../jobs/connection';
import { llmClient } from './llmInstance';
import { isDistressMessage } from './keywords';
import { getConversationContext, regenerateSummary } from './contextWindow';
import { fetchBusinessContext, buildAgentSystemPrompt } from './prompts';
import { TOOL_DEFINITIONS, ToolName, ToolContext, dispatchTool, ToolResult } from './tools';
import { validateToolCall, StateGuardError } from './stateGuard';
import { ConversationState, AgentMessage, AgentResult, ToolCall } from './types';
import { LLMParseError, LLMTimeoutError } from './types';
import { emitEscalation } from '../realtime/emitters';

const MAX_TOOL_ITERATIONS = 5;
const LOCK_TTL_SECONDS = 30;
const LOCK_PREFIX = 'agent:lock:';
const QUEUE_PREFIX = 'agent:queue:';

interface ConvRow {
  state: ConversationState;
  context_summary: string | null;
  business_id: string;
  business_name: string;
  business_settings: Record<string, unknown> | null;
  business_timezone: string;
  appointment_id: string;
  offered_slot_id: string | null;
  starts_at: Date;
  service_type: string | null;
  client_id: string;
  client_name: string;
}

export async function runConversationAgent(
  conversationId: string,
  messageText: string,
): Promise<AgentResult | null> {
  const lockKey = `${LOCK_PREFIX}${conversationId}`;
  const queueKey = `${QUEUE_PREFIX}${conversationId}`;

  const acquired = await redisConnection.set(lockKey, '1', 'EX', LOCK_TTL_SECONDS, 'NX');
  if (!acquired) {
    await redisConnection.rpush(queueKey, messageText);
    return null;
  }

  try {
    return await _runAgent(conversationId, messageText);
  } finally {
    await redisConnection.del(lockKey);
    const next = await redisConnection.lpop(queueKey);
    if (next) {
      runConversationAgent(conversationId, next).catch((err) =>
        console.error(`[Agent] queue drain error for ${conversationId}:`, err),
      );
    }
  }
}

async function _runAgent(
  conversationId: string,
  messageText: string,
): Promise<AgentResult> {
  const convResult = await db.query<ConvRow>(
    `SELECT c.state, c.context_summary, c.business_id, c.appointment_id,
            c.offered_slot_id, c.client_id,
            b.name AS business_name, b.settings AS business_settings, b.timezone AS business_timezone,
            a.starts_at, a.service_type,
            cl.name AS client_name
     FROM conversation c
     JOIN business b ON b.id = c.business_id
     JOIN appointment a ON a.id = c.appointment_id
     JOIN client cl ON cl.id = c.client_id
     WHERE c.id = $1`,
    [conversationId],
  );

  if (!convResult.rows.length) throw new Error(`Conversation not found: ${conversationId}`);
  const conv = convResult.rows[0];
  const tz = conv.business_timezone || 'America/Los_Angeles';
  const businessKeywords: string[] = (conv.business_settings?.escalation_keywords as string[]) ?? [];
  const tag = `[Agent:${conversationId.slice(0, 8)}]`;

  console.log(`${tag} ── incoming ──────────────────────────────────────`);
  console.log(`${tag} client="${conv.client_name}" state="${conv.state}"`);
  console.log(`${tag} message: "${messageText.slice(0, 150).replace(/\n/g, ' ')}"`);

  // Persist client message
  await db.query(
    `INSERT INTO message (conversation_id, sender, content) VALUES ($1, 'client', $2)`,
    [conversationId, messageText],
  );

  // Distress bypass — runs before agent loop
  if (isDistressMessage(messageText, businessKeywords)) {
    console.log(`${tag} → DISTRESS — escalating immediately`);
    await db.query(`UPDATE conversation SET state = 'escalated' WHERE id = $1`, [conversationId]);
    const reply = "I'll connect you with our team right away.";
    await storeAiMessage(conversationId, reply);
    emitEscalation(conv.business_id, conversationId, conv.client_name, 'distress_keyword');
    return { responseText: reply, newState: 'escalated', toolsUsed: [] };
  }

  // Build tool context (passed to every executor)
  const toolCtx: ToolContext = {
    conversationId,
    appointmentId: conv.appointment_id,
    businessId: conv.business_id,
    clientId: conv.client_id,
    clientName: conv.client_name,
    timezone: tz,
    currentState: conv.state,
  };

  // Load conversation history
  const { messages: historyMessages } = await getConversationContext(conversationId);

  // Build agent message history (convert ConversationMessage → AgentMessage)
  const agentMessages: AgentMessage[] = [
    ...historyMessages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user', content: messageText },
  ];

  // Build system prompt with live business context
  const bizCtx = await fetchBusinessContext(conv.business_id, conv.appointment_id, conv.client_name, tz);
  const systemPrompt = buildAgentSystemPrompt(bizCtx);

  // ── Agent loop ────────────────────────────────────────────────────────────
  const toolsUsed: string[] = [];
  let currentState = conv.state;
  let iterations = 0;

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;
    console.log(`${tag} → agent iteration ${iterations}`);

    let llmResponse;
    try {
      llmResponse = await llmClient.completeWithTools(systemPrompt, agentMessages, [...TOOL_DEFINITIONS]);
    } catch (err) {
      if (err instanceof LLMParseError || err instanceof LLMTimeoutError) {
        console.error(`${tag} ✖ LLM failure — escalating`);
        await db.query(`UPDATE conversation SET state = 'escalated' WHERE id = $1`, [conversationId]);
        const reply = "I'm having trouble right now. Our team has been notified.";
        await storeAiMessage(conversationId, reply);
        emitEscalation(conv.business_id, conversationId, conv.client_name, 'llm_api_failure');
        return { responseText: reply, newState: 'escalated', toolsUsed };
      }
      throw err;
    }

    // Text reply — agent is done
    if (!llmResponse.tool_calls && llmResponse.content) {
      console.log(`${tag} ✔ agent done | iterations=${iterations} | tools=[${toolsUsed.join(', ')}]`);
      await storeAiMessage(conversationId, llmResponse.content);
      await regenerateSummary(conversationId, (msgs) => llmClient.summarize(msgs));
      return { responseText: llmResponse.content, newState: currentState, toolsUsed };
    }

    // No tool calls and no content — shouldn't happen; send safe fallback
    if (!llmResponse.tool_calls) {
      const fallback = "I'm not sure how to help with that. Would you like me to connect you with our team?";
      await storeAiMessage(conversationId, fallback);
      return { responseText: fallback, newState: currentState, toolsUsed };
    }

    // Append the assistant's tool-call turn to history
    agentMessages.push({
      role: 'assistant',
      content: llmResponse.content,
      tool_calls: llmResponse.tool_calls,
    });

    // Execute each tool call
    for (const toolCall of llmResponse.tool_calls) {
      const toolName = toolCall.function.name as ToolName;
      console.log(`${tag} → tool call: ${toolName}(${toolCall.function.arguments.slice(0, 120)})`);

      let toolResultContent: string;

      // State guard check
      try {
        validateToolCall(toolName, currentState);
      } catch (err) {
        if (err instanceof StateGuardError) {
          console.warn(`${tag} ⚠ StateGuard blocked: ${err.message}`);
          toolResultContent = JSON.stringify({ error: err.message });
          agentMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolName,
            content: toolResultContent,
          });
          continue;
        }
        throw err;
      }

      // Execute
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch {
        args = {};
      }

      const result: ToolResult = await dispatchTool(toolName, args, toolCtx);
      toolsUsed.push(toolName);
      toolResultContent = JSON.stringify(result);

      // Update local state tracking based on confirmed tool outcomes
      currentState = applyStateChange(toolName, result, currentState);
      toolCtx.currentState = currentState;

      console.log(`${tag} ← tool result: ${toolResultContent.slice(0, 150)}`);

      agentMessages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        name: toolName,
        content: toolResultContent,
      });
    }
  }

  // Max iterations hit — escalate
  console.warn(`${tag} ⚠ max iterations (${MAX_TOOL_ITERATIONS}) reached — escalating`);
  await db.query(`UPDATE conversation SET state = 'escalated' WHERE id = $1`, [conversationId]);
  const reply = "Let me connect you with our team who can help further.";
  await storeAiMessage(conversationId, reply);
  emitEscalation(conv.business_id, conversationId, conv.client_name, 'agent_max_iterations');
  return { responseText: reply, newState: 'escalated', toolsUsed };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function storeAiMessage(conversationId: string, content: string): Promise<void> {
  await db.query(
    `INSERT INTO message (conversation_id, sender, content) VALUES ($1, 'ai', $2)`,
    [conversationId, content],
  );
}

function applyStateChange(
  toolName: ToolName,
  result: ToolResult,
  current: ConversationState,
): ConversationState {
  if (toolName === 'confirm_appointment' && result.tool === 'confirm_appointment' && result.success) {
    return 'confirmed';
  }
  if (toolName === 'cancel_appointment' && result.tool === 'cancel_appointment' && result.success) {
    return 'cancelled';
  }
  if (toolName === 'reschedule_appointment' && result.tool === 'reschedule_appointment' && result.success) {
    return 'confirmed';
  }
  if (toolName === 'opt_out_client' && result.tool === 'opt_out_client' && result.success) {
    return 'resolved';
  }
  if (toolName === 'request_human_takeover' && result.tool === 'request_human_takeover' && result.success) {
    return 'escalated';
  }
  return current;
}

