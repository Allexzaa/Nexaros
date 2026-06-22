import React, { useState } from 'react';
import { View, Text, TextInput, Button, StyleSheet, ActivityIndicator } from 'react-native';
import { useAuth } from '../context/AuthContext';
import { api, ApiError } from '../lib/api';
import { registerDeviceToken } from '../services/deviceToken';

interface Props {
  prefillCode?: string;
  onSuccess: () => void;
}

const ERROR_MESSAGES: Record<string, string> = {
  INVITE_EXPIRED:  'This invite link has expired. Please contact your office to request a new one.',
  INVITE_USED:     'This invite has already been redeemed. If you\'re having trouble signing in, contact your office.',
  INVITE_INVALID:  'Incorrect code.',
  RATE_LIMIT_EXCEEDED: 'Too many incorrect attempts. Please try again in 15 minutes.',
};

export function ShortCodeEntry({ prefillCode = '', onSuccess }: Props) {
  const { login } = useAuth();
  const [code, setCode]       = useState(prefillCode);
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(false);

  async function handleRedeem() {
    if (!code.trim()) return;
    setError('');
    setLoading(true);
    try {
      const res = await api.post<{ token: string; clientId: string; businessId: string }>(
        '/auth/redeem',
        { code: code.trim() },
      );
      login({ clientId: res.clientId, businessId: res.businessId }, res.token);
      await registerDeviceToken().catch(console.error);
      onSuccess();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(ERROR_MESSAGES[err.code] ?? err.message);
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Welcome</Text>
      <Text style={styles.subtitle}>Enter the code from your invite email to get started.</Text>
      <TextInput
        style={styles.input}
        value={code}
        onChangeText={setCode}
        placeholder="Invite code"
        autoCapitalize="none"
        autoCorrect={false}
        editable={!loading}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {loading
        ? <ActivityIndicator style={{ marginTop: 16 }} />
        : <Button title="Activate" onPress={handleRedeem} disabled={!code.trim()} />
      }
    </View>
  );
}

const styles = StyleSheet.create({
  container:  { flex: 1, justifyContent: 'center', padding: 32 },
  title:      { fontSize: 26, fontWeight: 'bold', marginBottom: 8 },
  subtitle:   { fontSize: 15, color: '#666', marginBottom: 24 },
  input:      { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 12, fontSize: 16, marginBottom: 12 },
  error:      { color: 'red', marginBottom: 12 },
});
