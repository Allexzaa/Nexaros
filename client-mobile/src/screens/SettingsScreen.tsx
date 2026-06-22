import React from 'react';
import { View, Text, Button, StyleSheet } from 'react-native';
import { useAuth } from '../context/AuthContext';
import { unregisterDeviceToken } from '../services/deviceToken';

export function SettingsScreen() {
  const { logout, user } = useAuth();

  async function handleOptOut() {
    // Opt-out implemented when F003 client endpoints are built
    console.log('Opt-out stub');
  }

  async function handleLogout() {
    await unregisterDeviceToken().catch(console.error);
    logout();
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Settings</Text>
      <Text style={styles.info}>Client ID: {user?.clientId}</Text>
      <View style={styles.spacer} />
      <Button title="Opt out of outreach" onPress={handleOptOut} color="#888" />
      <View style={styles.spacer} />
      <Button title="Log out" onPress={handleLogout} color="red" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24 },
  title:     { fontSize: 22, fontWeight: 'bold', marginBottom: 12 },
  info:      { color: '#888', marginBottom: 8 },
  spacer:    { height: 16 },
});
