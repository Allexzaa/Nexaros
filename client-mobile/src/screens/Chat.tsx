import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, TextInput, Button, StyleSheet } from 'react-native';
import { useAuth } from '../context/AuthContext';
import { useNetworkStatus } from '../hooks/useNetworkStatus';
import { getCachedMessages, cacheMessages, CachedMessage } from '../services/offlineCache';
import { enqueueMessage } from '../services/messageQueue';
import { api } from '../lib/api';
import { v4 as uuidv4 } from 'uuid';

export function Chat() {
  const { user } = useAuth();
  const isConnected = useNetworkStatus();
  const [messages, setMessages]   = useState<CachedMessage[]>([]);
  const [draft, setDraft]         = useState('');
  const [sending, setSending]     = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!user) return;
    // Load from cache immediately for instant offline display
    getCachedMessages(user.clientId, user.businessId).then(setMessages);
    // If online, fetch latest 50 from server and refresh cache
    if (isConnected) {
      api.get<{ data: CachedMessage[] }>('/messages?limit=50')
        .then(res => {
          setMessages(res.data);
          cacheMessages(user.clientId, user.businessId, res.data);
        })
        .catch(console.error);
    }
  }, [user, isConnected]);

  async function handleSend() {
    if (!draft.trim() || !user) return;
    const localId = uuidv4();
    const optimistic: CachedMessage = {
      id: localId, sender: 'client', content: draft.trim(), timestamp: new Date().toISOString(),
    };
    setMessages(prev => [...prev, optimistic]);
    setSending(prev => new Set(prev).add(localId));
    setDraft('');

    if (isConnected) {
      try {
        await api.post('/conversations/active/messages', { content: optimistic.content });
        setSending(prev => { const s = new Set(prev); s.delete(localId); return s; });
      } catch {
        // Falls through to queue on failure
        await enqueueMessage({ localId, conversationId: 'active', content: optimistic.content });
      }
    } else {
      await enqueueMessage({ localId, conversationId: 'active', content: optimistic.content });
    }
  }

  return (
    <View style={styles.container}>
      {!isConnected && (
        <View style={styles.offlineBanner}>
          <Text style={styles.offlineText}>No connection — messages will send when restored</Text>
        </View>
      )}
      <FlatList
        data={messages}
        keyExtractor={m => m.id}
        renderItem={({ item }) => (
          <View style={[styles.bubble, item.sender === 'client' ? styles.sent : styles.received]}>
            <Text>{item.content}</Text>
            {sending.has(item.id) && <Text style={styles.sending}>Sending…</Text>}
          </View>
        )}
        contentContainerStyle={{ padding: 16, gap: 8 }}
      />
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Message…"
          multiline
        />
        <Button title="Send" onPress={handleSend} disabled={!draft.trim()} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container:     { flex: 1 },
  offlineBanner: { backgroundColor: '#ffcc00', padding: 8, alignItems: 'center' },
  offlineText:   { fontSize: 13, color: '#333' },
  bubble:        { maxWidth: '80%', padding: 10, borderRadius: 12 },
  sent:          { alignSelf: 'flex-end', backgroundColor: '#0057ff', marginLeft: 'auto' },
  received:      { alignSelf: 'flex-start', backgroundColor: '#eee' },
  sending:       { fontSize: 11, color: '#aaa', marginTop: 4 },
  inputRow:      { flexDirection: 'row', padding: 8, borderTopWidth: 1, borderColor: '#eee', gap: 8, alignItems: 'flex-end' },
  input:         { flex: 1, borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 10, maxHeight: 100 },
});
