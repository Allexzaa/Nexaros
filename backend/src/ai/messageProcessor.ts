import { db } from '../db';
import { redisConnection } from '../jobs/connection';
import { stateEngine } from './stateEngine';
import { llmClient } from './llmInstance';
import { isDistressMessage } from './keywords';
import { getConversationContext, regenerateSummary } from './contextWindow';
import { buildSystemPrompt } from './prompts';
import { cancelJobsByConversationId } from '../jobs/scheduler';
import { emitAppointmentConfirmed, emitEscalation, emitBookingRequestPending } from '../realtime/emitters';
import { findBestSlot, findMatchingSlots, findSlotsForDate, lockSlot, freeSlot, SlotConflictError } from '../services/slotManager';
import { parseTimeExpression } from './timeParser';
import { v4 as uuidv4 } from 'uuid';
import {
  ConversationState,
  ConversationEvent,
  LLMIntent,
  LLMParseError,
  LLMTimeoutError,
  InvalidTransitionError,
  ProcessingResult,
  TransitionExtras,
} from './types';

const LOCK_TTL_SECONDS = 30;
const LOCK_PREFIX = 'lock:conversation:';
const QUEUE_PREFIX = 'queue:conversation:';

interface ConvRow {
  state: ConversationState;
  context_summary: string | null;
  consecutive_ambiguous_count: number;
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

// States where a client message triggers LLM directly (no message_received transition)
const DIRECT_LLM_STATES = new Set<ConversationState>(['rescheduling', 'slot_offered']);

export async function processIncomingMessage(
  conversationId: string,
  messageText: string,
): Promise<ProcessingResult | null> {
  const lockKey = `${LOCK_PREFIX}${conversationId}`;
  const queueKey = `${QUEUE_PREFIX}${conversationId}`;

  const acquired = await redisConnection.set(lockKey, '1', 'EX', LOCK_TTL_SECONDS, 'NX');
  if (!acquired) {
    await redisConnection.rpush(queueKey, messageText);
    return null;
  }

  try {
    return await _process(conversationId, messageText);
  } finally {
    await redisConnection.del(lockKey);
    const next = await redisConnection.lpop(queueKey);
    if (next) {
      processIncomingMessage(conversationId, next).catch((err) =>
        console.error(`[messageProcessor] queue drain error for ${conversationId}:`, err),
      );
    }
  }
}

async function _process(conversationId: string, messageText: string): Promise<ProcessingResult> {
  const convResult = await db.query<ConvRow>(
    `SELECT c.state, c.context_summary, c.consecutive_ambiguous_count,
            c.business_id, c.appointment_id, c.offered_slot_id, c.client_id,
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
  const businessKeywords: string[] = (conv.business_settings?.escalation_keywords as string[]) ?? [];
  const tz = conv.business_timezone || 'America/Los_Angeles';
  let state = conv.state;

  const convTag = `[AI:${conversationId.slice(0, 8)}]`;
  console.log(`${convTag} ── incoming message ──────────────────────────`);
  console.log(`${convTag} client="${conv.client_name}" state="${state}"`);
  console.log(`${convTag} message: "${messageText.slice(0, 150).replace(/\n/g, ' ')}"`);


  function fmtDatetime(date: Date | string): string {
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'long', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
      timeZone: tz,
    }).format(new Date(date));
  }

  function fmtDateOnly(date: Date | string): string {
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'long', month: 'long', day: 'numeric',
      timeZone: tz,
    }).format(new Date(date));
  }

  // Always persist the incoming client message first
  await db.query(
    `INSERT INTO message (conversation_id, sender, content) VALUES ($1, 'client', $2)`,
    [conversationId, messageText],
  );

  // Holding reply — no LLM needed
  if (state === 'awaiting_approval') {
    console.log(`${convTag} → awaiting_approval: holding reply, no LLM`);
    const responseText = "We're still waiting on confirmation from the office — I'll update you shortly.";
    await stateEngine.applyTransition(conversationId, 'message_received');
    await storeMessage(conversationId, responseText);
    return { event: 'message_received', newState: 'awaiting_approval', responseText, extractedPreferences: null };
  }

  // Friendly ack for already-confirmed conversations
  if (state === 'confirmed') {
    console.log(`${convTag} → confirmed: already confirmed, no LLM`);
    const responseText = 'Your appointment is confirmed. See you then!';
    await stateEngine.applyTransition(conversationId, 'message_received');
    await storeMessage(conversationId, responseText);
    return { event: 'message_received', newState: 'confirmed', responseText, extractedPreferences: null };
  }

  // Distress check — always runs before LLM, bypasses normal pipeline
  if (isDistressMessage(messageText, businessKeywords)) {
    console.log(`${convTag} → DISTRESS KEYWORD detected — escalating immediately`);
    if (state === 'awaiting_reply') {
      await stateEngine.applyTransition(conversationId, 'message_received');
    }
    const newState = await stateEngine.applyTransition(conversationId, 'human_requested', {
      escalationReason: 'distress_keyword',
    });
    const responseText = "I'll connect you with our team right away.";
    await storeMessage(conversationId, responseText);
    emitEscalation(conv.business_id, conversationId, conv.client_name, 'distress_keyword');
    return { event: 'human_requested', newState, responseText, extractedPreferences: null };
  }

  // Transition awaiting_reply → processing (not needed for direct-LLM states)
  if (state === 'awaiting_reply') {
    state = (await stateEngine.applyTransition(conversationId, 'message_received')) as ConversationState;
  }

  // Load conversation context (last 10 messages + summary)
  const { messages, contextSummary } = await getConversationContext(conversationId);

  const appointmentDetails = conv.service_type
    ? `${conv.service_type} on ${fmtDatetime(conv.starts_at)}`
    : `Appointment on ${fmtDatetime(conv.starts_at)}`;

  // LLM #1 runs first with no slot context in rescheduling state.
  // Its job here is purely to extract the clean preference string from the client message.
  // Slots are fetched AFTER LLM #1 returns, using extracted_preferences — not the raw message.
  // LLM #1's response_text is always overridden in the reschedule_preference_given handler anyway.
  const availableSlotsContext = '';

  // Call LLM
  console.log(`${convTag} → calling LLM (state="${state}", appt="${appointmentDetails}")`);
  let llmResponse;
  try {
    llmResponse = await llmClient.complete(
      { businessName: conv.business_name, state, appointmentDetails, availableSlots: availableSlotsContext, contextSummary },
      messages,
    );
    console.log(`${convTag} LLM result: intent="${llmResponse.intent}" resolved="${llmResponse.resolvedIntent}" conf=${llmResponse.confidence.toFixed(2)}`);
    console.log(`${convTag} LLM response: "${llmResponse.response_text.slice(0, 120).replace(/\n/g, ' ')}"`);
  } catch (err) {
    if (!(err instanceof LLMParseError) && !(err instanceof LLMTimeoutError)) throw err;
    console.error(`${convTag} ✖ LLM FAILURE — escalating conversation`);
    const newState = await stateEngine.applyTransition(conversationId, 'llm_api_failure', {
      escalationReason: 'llm_api_failure',
    });
    const responseText = "I'm having trouble processing your message. Our team has been notified.";
    await storeMessage(conversationId, responseText);
    emitEscalation(conv.business_id, conversationId, conv.client_name, 'llm_api_failure');
    return { event: 'llm_api_failure', newState, responseText, extractedPreferences: null };
  }

  // Map resolved intent → event + extras (ambiguous count-aware)
  let { event, extras } = mapIntentToEvent(llmResponse.resolvedIntent, conv.consecutive_ambiguous_count, state);

  // ── Pre-transition: reschedule_preference_given ──────────────────────────────
  // Find best slot before transitioning so we know the target state
  let overrideResponseText: string | null = null;

  if (event === 'reschedule_preference_given') {
    const preferences  = llmResponse.extracted_preferences?.trim() || messageText.trim();
    const dateFrom     = llmResponse.preferred_date_from;
    const dateTo       = llmResponse.preferred_date_to;

    // Parse time bounds from the raw preference text — deterministic, no LLM needed.
    const timeParsed   = parseTimeExpression(preferences);
    const preferredTod = timeParsed.bucket;
    const timeFrom     = timeParsed.from;
    const timeTo       = timeParsed.to;

    console.log(`${convTag} time parsed from "${preferences}" → bucket=${preferredTod} from=${timeFrom ?? 'none'} to=${timeTo ?? 'none'}`);

    let matchingSlots;

    if (dateFrom && dateTo) {
      // LLM resolved to a concrete date range — query DB directly, no rankSlots needed.
      console.log(`${convTag} → date range path | ${dateFrom} → ${dateTo} | time: ${timeFrom ? `${timeFrom}–${timeTo ?? 'end'}` : preferredTod}`);
      matchingSlots = await findSlotsForDate(
        conv.business_id, dateFrom, dateTo, preferredTod, conv.appointment_id, tz,
        timeFrom, timeTo,
      );
    } else {
      // Truly open-ended (no date) — fall back to LLM rankSlots.
      console.log(`${convTag} → open-ended path | preference="${preferences}"`);
      matchingSlots = await findMatchingSlots(conv.business_id, preferences, conv.appointment_id, tz, 3);
    }

    console.log(`${convTag} slots found: ${matchingSlots.length} | ${matchingSlots.map(s => new Date(s.starts_at).toISOString()).join(', ') || 'none'}`);

    if (matchingSlots.length === 0) {
      // No slots for that date/time — tell the client directly. Do NOT waitlist or look elsewhere.
      // Stay in rescheduling so client can suggest a different date.
      const noAvailMsg = dateFrom
        ? `I'm sorry, we don't have any availability for that date and time. Is there another date or time that works for you?`
        : `I wasn't able to find any available slots matching your preferences. Is there another date or time that works for you?`;
      console.log(`${convTag} → no slots for requested date/time — staying in rescheduling`);

      await db.query(`UPDATE conversation SET state = 'rescheduling' WHERE id = $1`, [conversationId]);
      await storeMessage(conversationId, noAvailMsg);
      return { event: 'reschedule_preference_given', newState: 'rescheduling', responseText: noAvailMsg, extractedPreferences: preferences };

    } else if (matchingSlots.length === 1) {
      // Single match — offer it directly and move to slot_offered
      const slot = matchingSlots[0];
      const label = slot.service_type ? `a ${slot.service_type} appointment` : 'an appointment';
      overrideResponseText =
        `I found ${label} available on ${fmtDatetime(slot.starts_at)}. Would that work for you?`;
      extras = { targetState: 'slot_offered', offeredSlotId: slot.id };

    } else {
      // Multiple matches — list ALL of them, stay in rescheduling so client can pick one.
      const list = matchingSlots
        .map((s, i) => {
          const label = s.service_type ? `${s.service_type} — ` : '';
          return `${i + 1}. ${label}${fmtDatetime(s.starts_at)}`;
        })
        .join('\n');

      const responseText =
        `Here are the available times that match your request:\n\n${list}\n\nWhich one works best for you?`;

      await db.query(
        `UPDATE conversation SET state = 'rescheduling', offered_slot_id = $1 WHERE id = $2`,
        [matchingSlots[0].id, conversationId],
      );
      await storeMessage(conversationId, responseText);
      console.log(`${convTag} ✔ state: "rescheduling" (${matchingSlots.length} slots offered)`);
      return { event: 'reschedule_preference_given', newState: 'rescheduling', responseText, extractedPreferences: preferences };
    }
  }

  // ── Pre-transition: slot_accepted — lock the slot before committing state ────
  if (event === 'slot_accepted') {
    let targetSlotId = conv.offered_slot_id;

    // In rescheduling state multiple slots were listed — re-query to find the exact one the client picked.
    if (state === 'rescheduling') {
      const dateFrom = llmResponse.preferred_date_from;
      const dateTo   = llmResponse.preferred_date_to ?? dateFrom;
      const timeParsed = parseTimeExpression(llmResponse.extracted_preferences ?? messageText);
      if (dateFrom) {
        const candidates = await findSlotsForDate(
          conv.business_id, dateFrom, dateTo!, timeParsed.bucket, conv.appointment_id, tz,
          timeParsed.from, timeParsed.to,
        );
        if (candidates.length > 0) targetSlotId = candidates[0].id;
      }
    }

    if (!targetSlotId) {
      // No slot to lock — treat as ambiguous (defensive guard)
      event = 'ambiguous_message';
      extras = { targetState: conv.offered_slot_id ? 'slot_offered' : 'awaiting_reply' };
    } else {
      try {
        await lockSlot(targetSlotId, conv.client_id);
        conv.offered_slot_id = targetSlotId; // keep reference for post-transition side effects
      } catch (err) {
        if (!(err instanceof SlotConflictError)) throw err;
        // Slot was taken — recover to rescheduling without StateEngine
        await db.query(`UPDATE conversation SET state = 'rescheduling' WHERE id = $1`, [conversationId]);
        const responseText =
          "That slot was just taken — I'm looking for another option. What times generally work better for you?";
        await storeMessage(conversationId, responseText);
        return { event: 'slot_accepted', newState: 'rescheduling', responseText, extractedPreferences: null };
      }
    }
  }

  // Apply transition (with fallback to ambiguous if intent is invalid for current state)
  let newState: ConversationState;
  console.log(`${convTag} → applying transition: event="${event}" extras=${JSON.stringify(extras)}`);
  try {
    newState = await stateEngine.applyTransition(conversationId, event, extras);
  } catch (err) {
    if (!(err instanceof InvalidTransitionError)) throw err;
    console.warn(`${convTag} InvalidTransition for event="${event}" in state="${state}" — falling back to ambiguous`);
    const fallbackTarget: ConversationState = DIRECT_LLM_STATES.has(state) ? state : 'awaiting_reply';
    const fallbackExtras: TransitionExtras =
      conv.consecutive_ambiguous_count >= 1
        ? { targetState: 'escalated', escalationReason: 'repeated_ambiguous_message' }
        : { targetState: fallbackTarget };
    newState = await stateEngine.applyTransition(conversationId, 'ambiguous_message', fallbackExtras);
  }
  console.log(`${convTag} ✔ state: "${state}" → "${newState}"`);

  // Increment ambiguous counter on first off-topic or ambiguous occurrence
  if (
    (llmResponse.resolvedIntent === 'ambiguous' || llmResponse.resolvedIntent === 'off_topic') &&
    conv.consecutive_ambiguous_count === 0
  ) {
    await db.query(
      'UPDATE conversation SET consecutive_ambiguous_count = consecutive_ambiguous_count + 1 WHERE id = $1',
      [conversationId],
    );
  }

  // ── Post-transition side effects ─────────────────────────────────────────────

  if (newState === 'waitlisted') {
    await db.query(
      `INSERT INTO waitlist_entry (id, client_id, business_id, preferences)
       VALUES ($1, $2, $3, $4)`,
      [uuidv4(), conv.client_id, conv.business_id, llmResponse.extracted_preferences ?? ''],
    );
  }

  if (newState === 'confirmed') {
    if (event === 'slot_accepted') {
      // Free the original appointment slot (slot_accepted path — new slot already locked)
      await freeSlot(conv.appointment_id, conv.business_id);
    } else {
      // Direct confirmation path (confirming → confirmed)
      await db.query(`UPDATE appointment SET status = 'confirmed' WHERE id = $1`, [conv.appointment_id]);
    }
    await cancelJobsByConversationId(conversationId);
    const appointmentTime = new Date(conv.starts_at).toISOString();
    emitAppointmentConfirmed(
      conv.business_id, conv.appointment_id, conv.client_name, appointmentTime, conv.service_type ?? '',
    );
  }

  if (newState === 'escalated') {
    const reason = extras.escalationReason ?? 'unknown';
    emitEscalation(conv.business_id, conversationId, conv.client_name, reason);
  }

  if (event === 'booking_routed_to_staff') {
    emitBookingRequestPending(conv.business_id, conversationId, conv.client_name);
  }

  const finalResponseText = overrideResponseText ?? llmResponse.response_text;
  await storeMessage(conversationId, finalResponseText);
  await regenerateSummary(conversationId, (msgs) => llmClient.summarize(msgs));

  return {
    event,
    newState,
    responseText: finalResponseText,
    extractedPreferences: llmResponse.extracted_preferences,
  };
}

function mapIntentToEvent(
  intent: LLMIntent,
  ambiguousCount: number,
  currentState: ConversationState,
): { event: ConversationEvent; extras: TransitionExtras } {
  if (intent === 'ambiguous' || intent === 'off_topic') {
    const event: ConversationEvent = intent === 'off_topic' ? 'off_topic_message' : 'ambiguous_message';
    if (ambiguousCount >= 1) {
      return {
        event,
        extras: {
          targetState: 'escalated',
          escalationReason: intent === 'off_topic' ? 'repeated_off_topic_message' : 'repeated_ambiguous_message',
        },
      };
    }
    // First occurrence: self-loop in direct-LLM states (rescheduling/slot_offered), else back to awaiting_reply
    const targetState: ConversationState = DIRECT_LLM_STATES.has(currentState) ? currentState : 'awaiting_reply';
    return { event, extras: { targetState } };
  }

  const intentEventMap: Partial<Record<LLMIntent, ConversationEvent>> = {
    confirm:               'confirmation_intent',
    decline:               'decline_intent',
    question:              'question_intent',
    reschedule_preference: 'reschedule_preference_given',
    slot_accept:           'slot_accepted',
    slot_decline:          'slot_declined',
    opt_out:               'opt_out',
    human_requested:       'human_requested',
    booking_request:       'booking_routed_to_staff',
  };

  const event = intentEventMap[intent] ?? 'ambiguous_message';
  const extras: TransitionExtras = {};
  if (intent === 'human_requested') extras.escalationReason = 'client_requested_human';
  if (event === 'ambiguous_message') extras.targetState = 'awaiting_reply';

  return { event, extras };
}

async function storeMessage(conversationId: string, content: string): Promise<void> {
  await db.query(
    `INSERT INTO message (conversation_id, sender, content) VALUES ($1, 'ai', $2)`,
    [conversationId, content],
  );
}
