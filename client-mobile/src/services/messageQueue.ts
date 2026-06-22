import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from '../lib/api';

const QUEUE_KEY = 'outgoing_message_queue';

export interface QueuedMessage {
  localId: string;       // temporary client-side ID shown as "Sending…"
  conversationId: string;
  content: string;
  queuedAt: string;
}

export async function enqueueMessage(msg: Omit<QueuedMessage, 'queuedAt'>): Promise<void> {
  const queue = await getQueue();
  queue.push({ ...msg, queuedAt: new Date().toISOString() });
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

export async function getQueue(): Promise<QueuedMessage[]> {
  const raw = await AsyncStorage.getItem(QUEUE_KEY);
  return raw ? (JSON.parse(raw) as QueuedMessage[]) : [];
}

// Flushes all queued messages to the server. Called when network restores.
export async function flushQueue(): Promise<void> {
  const queue = await getQueue();
  if (queue.length === 0) return;

  const failed: QueuedMessage[] = [];
  for (const msg of queue) {
    try {
      await api.post(`/conversations/${msg.conversationId}/messages`, { content: msg.content });
    } catch {
      failed.push(msg);
    }
  }

  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(failed));
}
