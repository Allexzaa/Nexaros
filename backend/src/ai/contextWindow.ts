import { db } from '../db';
import { ConversationMessage } from './types';

const WINDOW_SIZE = 10;
const SUMMARY_TIMEOUT_MS = 30_000;

export interface ConversationContext {
  messages: ConversationMessage[];
  contextSummary: string | null;
}

export async function getConversationContext(conversationId: string): Promise<ConversationContext> {
  const result = await db.query<{
    content: string;
    sender: 'ai' | 'client' | 'staff';
    timestamp: Date;
    context_summary: string | null;
  }>(
    `SELECT m.content, m.sender, m.timestamp, c.context_summary
     FROM message m
     JOIN conversation c ON c.id = m.conversation_id
     WHERE m.conversation_id = $1
     ORDER BY m.timestamp DESC
     LIMIT $2`,
    [conversationId, WINDOW_SIZE],
  );

  const contextSummary = result.rows[0]?.context_summary ?? null;

  const messages: ConversationMessage[] = result.rows
    .reverse()
    .map((row) => ({
      role: row.sender === 'client' ? 'user' : 'assistant',
      content: row.content,
    }));

  return { messages, contextSummary };
}

// Called when message count exceeds WINDOW_SIZE — generates a rolling summary
// and stores it on the Conversation record. Uses the same LLMClient instance.
export async function regenerateSummary(
  conversationId: string,
  summarize: (messages: ConversationMessage[]) => Promise<string>,
): Promise<void> {
  const countResult = await db.query<{ count: string }>(
    'SELECT COUNT(*) FROM message WHERE conversation_id = $1',
    [conversationId],
  );
  const count = parseInt(countResult.rows[0].count, 10);
  if (count <= WINDOW_SIZE) return;

  const older = await db.query<{ content: string; sender: 'ai' | 'client' | 'staff' }>(
    `SELECT content, sender FROM message
     WHERE conversation_id = $1
     ORDER BY timestamp ASC
     LIMIT $2`,
    [conversationId, count - WINDOW_SIZE],
  );

  const messages: ConversationMessage[] = older.rows.map((row) => ({
    role: row.sender === 'client' ? 'user' : 'assistant',
    content: row.content,
  }));

  const summary = await Promise.race([
    summarize(messages),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Summary timeout')), SUMMARY_TIMEOUT_MS),
    ),
  ]);

  await db.query('UPDATE conversation SET context_summary = $1 WHERE id = $2', [summary, conversationId]);
}
