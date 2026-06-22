import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuth } from '../context/AuthContext';
import { ShortCodeEntry } from '../screens/ShortCodeEntry';
import { TabNavigator } from './TabNavigator';

export type RootStackParamList = {
  ShortCodeEntry: { code?: string };
  Main: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export function RootNavigator() {
  const { isAuthenticated } = useAuth();

  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      {!isAuthenticated
        ? <Stack.Screen name="ShortCodeEntry" component={ShortCodeEntryWrapper} />
        : <Stack.Screen name="Main" component={TabNavigator} />
      }
    </Stack.Navigator>
  );
}

// Bridges route params → ShortCodeEntry props
function ShortCodeEntryWrapper({ route, navigation }: any) {
  return (
    <ShortCodeEntry
      prefillCode={route.params?.code}
      onSuccess={() => navigation.replace('Main')}
    />
  );
}
