import axios, { AxiosInstance } from 'axios';
import { LLMResponse, LLMIntent, LLMParseError, LLMTimeoutError, ConversationMessage, AgentMessage, AgentLLMResponse, ToolCall } from './types';
import { buildSystemPrompt, PromptContext } from './prompts';

const VALID_INTENTS = new Set<LLMIntent>([
  'confirm', 'decline', 'question', 'reschedule_preference',
  'slot_accept', 'slot_decline', 'opt_out', 'off_topic', 'ambiguous', 'human_requested',
  'booking_request',
]);

const REQUEST_TIMEOUT_MS = 30_000;

// Confidence thresholds from F003 LLM Intent Detection Protocol
function resolveIntent(intent: LLMIntent, confidence: number): LLMIntent {
  if (confidence >= 0.75) return intent;
  return 'ambiguous';
}

function extractJson(raw: string): string {
  // 1. Strip markdown code fences
  let s = raw.replace(/^```(?:json)?\s*/im, '').replace(/\s*```\s*$/m, '').trim();

  // 2. If there's still non-JSON text before the first '{', find the JSON object
  const start = s.indexOf('{');
  const end   = s.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    s = s.slice(start, end + 1);
  }

  return s;
}

function parseResponse(raw: string): LLMResponse {
  let parsed: unknown;

  const cleaned = extractJson(raw);

  try {
    parsed = JSON.parse(cleaned);
  } catch {
    console.error('[LLM] Parse failed. Raw response:', raw.slice(0, 500));
    throw new LLMParseError(`Invalid JSON from LLM: ${raw.slice(0, 200)}`);
  }

  const p = parsed as Record<string, unknown>;

  // Gracefully handle unknown intents — map to ambiguous rather than throwing
  const rawIntent = typeof p.intent === 'string' ? p.intent : 'ambiguous';
  const intent: LLMIntent = VALID_INTENTS.has(rawIntent as LLMIntent)
    ? (rawIntent as LLMIntent)
    : 'ambiguous';

  const confidence = typeof p.confidence === 'number'
    ? Math.min(1, Math.max(0, p.confidence))
    : 0.5;

  // Tolerate empty response_text — for reschedule_preference the handler overrides it anyway.
  // Log a warning but don't fail the whole response.
  const response_text = typeof p.response_text === 'string' && p.response_text.trim()
    ? p.response_text
    : (() => {
        console.warn('[LLM] response_text was empty — using placeholder. Intent:', rawIntent, '| Object:', JSON.stringify(p).slice(0, 300));
        return 'Let me check what we have available for you.';
      })();

  // extracted_preferences may come back as an object — stringify it so downstream code always gets a string or null
  let extracted_preferences: string | null = null;
  if (typeof p.extracted_preferences === 'string' && p.extracted_preferences.trim()) {
    extracted_preferences = p.extracted_preferences;
  } else if (p.extracted_preferences && typeof p.extracted_preferences === 'object') {
    extracted_preferences = JSON.stringify(p.extracted_preferences);
  }

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const parseDate = (v: unknown): string | null => {
    const s = typeof v === 'string' ? v.trim() : null;
    return s && DATE_RE.test(s) ? s : null;
  };

  const preferred_date_from = parseDate(p.preferred_date_from);
  const preferred_date_to   = parseDate(p.preferred_date_to);

  const validTimes = new Set(['morning', 'afternoon', 'evening', 'any']);
  const rawTod = typeof p.preferred_time_of_day === 'string' ? p.preferred_time_of_day.trim().toLowerCase() : null;
  const preferred_time_of_day = (rawTod && validTimes.has(rawTod) ? rawTod : 'any') as import('./types').TimeOfDay;

  return {
    intent,
    confidence,
    resolvedIntent: resolveIntent(intent, confidence),
    response_text,
    extracted_preferences,
    preferred_date_from,
    preferred_date_to,
    preferred_time_of_day,
  };
}

export class LLMClient {
  private http: AxiosInstance;
  private model: string;

  constructor(baseUrl: string, apiKey: string, model: string) {
    this.model = model;
    this.http = axios.create({
      baseURL: baseUrl,
      timeout: REQUEST_TIMEOUT_MS,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  }

  async complete(ctx: PromptContext, messages: ConversationMessage[]): Promise<LLMResponse> {
    const systemPrompt = buildSystemPrompt(ctx);
    const lastMsg = messages[messages.length - 1];

    console.log(`[LLM] ▶ complete | state=${ctx.state} | model=${this.model}`);
    if (lastMsg) {
      const preview = String(lastMsg.content).slice(0, 120).replace(/\n/g, ' ');
      console.log(`[LLM]   last message (${lastMsg.role}): "${preview}"`);
    }

    const t0 = Date.now();
    try {
      const res = await this.http.post('/chat/completions', {
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages,
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' },
      });

      const content: string = res.data?.choices?.[0]?.message?.content ?? '';
      if (!content) throw new LLMParseError('Empty response from LLM');

      const result = parseResponse(content);
      const ms = Date.now() - t0;
      console.log(`[LLM] ✔ complete | ${ms}ms | intent=${result.intent} (resolved=${result.resolvedIntent}, confidence=${result.confidence.toFixed(2)})`);
      console.log(`[LLM]   response_text: "${result.response_text.slice(0, 120).replace(/\n/g, ' ')}"`);
      if (result.extracted_preferences) {
        console.log(`[LLM]   extracted_preferences: "${result.extracted_preferences}"`);
      }
      return result;
    } catch (err) {
      const ms = Date.now() - t0;
      if (axios.isAxiosError(err) && err.code === 'ECONNABORTED') {
        console.error(`[LLM] ✖ TIMEOUT after ${ms}ms`);
        throw new LLMTimeoutError();
      }
      if (err instanceof LLMParseError) {
        console.error(`[LLM] ✖ PARSE ERROR: ${(err as Error).message}`);
        throw err;
      }
      if (err instanceof LLMTimeoutError) throw err;
      console.error(`[LLM] ✖ REQUEST FAILED after ${ms}ms:`, (err as Error).message);
      throw new LLMParseError(`LLM request failed: ${(err as Error).message}`);
    }
  }

  async completeWithTools(
    systemPrompt: string,
    messages: AgentMessage[],
    tools: object[],
  ): Promise<AgentLLMResponse> {
    const t0 = Date.now();
    console.log(`[LLM] ▶ completeWithTools | model=${this.model} | messages=${messages.length} | tools=${tools.length}`);

    try {
      const res = await this.http.post('/chat/completions', {
        model: this.model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        tools,
        tool_choice: 'auto',
        temperature: 0.4,
      });

      const msg = res.data?.choices?.[0]?.message;
      if (!msg) throw new LLMParseError('Empty response from LLM');

      const tool_calls: ToolCall[] | null =
        Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0 ? msg.tool_calls : null;
      const raw = typeof msg.content === 'string' ? msg.content.trim() : '';
      // Reject bare JSON objects/arrays — llama3.1 sometimes emits {} or [] instead of text
      const looksLikeJson = /^[\[{]/.test(raw) && /[\]}]$/.test(raw);
      const content: string | null = raw && !looksLikeJson ? raw : null;

      console.log(
        `[LLM] ✔ completeWithTools | ${Date.now() - t0}ms | ` +
        `tool_calls=${tool_calls?.length ?? 0} | content=${content ? content.slice(0, 80).replace(/\n/g, ' ') : 'none'}`,
      );

      return { content, tool_calls };
    } catch (err) {
      const ms = Date.now() - t0;
      if (axios.isAxiosError(err) && err.code === 'ECONNABORTED') {
        console.error(`[LLM] ✖ completeWithTools TIMEOUT after ${ms}ms`);
        throw new LLMTimeoutError();
      }
      if (err instanceof LLMParseError || err instanceof LLMTimeoutError) throw err;
      console.error(`[LLM] ✖ completeWithTools FAILED after ${ms}ms:`, (err as Error).message);
      throw new LLMParseError(`LLM request failed: ${(err as Error).message}`);
    }
  }

  async summarize(messages: ConversationMessage[]): Promise<string> {
    try {
      const res = await this.http.post('/chat/completions', {
        model: this.model,
        messages: [
          {
            role: 'system',
            content:
              'Summarize the following conversation history in 2-3 sentences. Focus on what has been agreed, offered, or requested.',
          },
          ...messages,
        ],
        temperature: 0.3,
        // No json_object mode for summarize — plain text output is intentional
      });
      return res.data?.choices?.[0]?.message?.content ?? '';
    } catch (err) {
      if (axios.isAxiosError(err) && err.code === 'ECONNABORTED') throw new LLMTimeoutError();
      throw new LLMParseError(`Summary request failed: ${(err as Error).message}`);
    }
  }

  async rankSlots(
    preferences: string,
    slots: Array<{ id: string; label: string }>,
    todayLabel?: string,
  ): Promise<string | null> {
    const slotList = slots.map((s, i) => `${i + 1}. ID: ${s.id} — ${s.label}`).join('\n');
    const dateContext = todayLabel ? `Today is ${todayLabel}. ` : '';

    console.log(`[LLM] ▶ rankSlots | preferences="${preferences}" | candidates=${slots.length} | today=${todayLabel ?? 'unknown'}`);

    try {
      const t0 = Date.now();
      const res = await this.http.post('/chat/completions', {
        model: this.model,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              `${dateContext}You are a scheduling assistant. Given the client's preferences and a list of available appointment slots, ` +
              'return the ID of the best matching slot as JSON: {"slotId": "<uuid>"}. ' +
              'If no slot matches the preferences, return {"slotId": null}.\n\n' +
              'Time-of-day definitions (use these strictly):\n' +
              '- morning: before 12:00 PM\n' +
              '- afternoon: 1:00 PM to 4:59 PM\n' +
              '- evening: 5:00 PM or later\n' +
              'When a client says "afternoon", only pick slots at 1:00 PM or later.',
          },
          {
            role: 'user',
            content: `Client preferences: ${preferences}\n\nAvailable slots:\n${slotList}`,
          },
        ],
        temperature: 0.1,
      });
      const content: string = res.data?.choices?.[0]?.message?.content ?? '';
      const parsed = JSON.parse(extractJson(content)) as { slotId?: string | null };
      const matched = typeof parsed.slotId === 'string' ? parsed.slotId : null;
      const matchedSlot = matched ? slots.find(s => s.id === matched) : null;
      console.log(`[LLM] ✔ rankSlots | ${Date.now() - t0}ms | best=${matchedSlot ? matchedSlot.label : 'none (no match)'}`);
      return matched;
    } catch (err) {
      console.error('[LLM] ✖ rankSlots failed:', (err as Error).message);
      return null; // safe fallback — slotManager will use first available
    }
  }
}
