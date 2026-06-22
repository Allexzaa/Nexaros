import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

export function Notifications() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Notifications</Text>
      <Text style={styles.placeholder}>Slot offers, follow-ups, and confirmations will appear here — coming in a future phase.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container:   { flex: 1, padding: 24 },
  title:       { fontSize: 22, fontWeight: 'bold', marginBottom: 12 },
  placeholder: { color: '#888' },
});
