import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = (clientId: string, businessId: string) => `messages:${clientId}:${businessId}`;

export interface CachedMessage {
  id: string;
  sender: 'ai' | 'client' | 'staff';
  content: string;
  timestamp: string;
}

export async function cacheMessages(clientId: string, businessId: string, messages: CachedMessage[]): Promise<void> {
  await AsyncStorage.setItem(KEY(clientId, businessId), JSON.stringify(messages));
}

export async function getCachedMessages(clientId: string, businessId: string): Promise<CachedMessage[]> {
  const raw = await AsyncStorage.getItem(KEY(clientId, businessId));
  if (!raw) return [];
  return JSON.parse(raw) as CachedMessage[];
}
