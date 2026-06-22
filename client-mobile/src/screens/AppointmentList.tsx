import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

export function AppointmentList() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Appointments</Text>
      <Text style={styles.placeholder}>Your upcoming and past appointments will appear here — coming in a future phase.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container:   { flex: 1, padding: 24 },
  title:       { fontSize: 22, fontWeight: 'bold', marginBottom: 12 },
  placeholder: { color: '#888' },
});
