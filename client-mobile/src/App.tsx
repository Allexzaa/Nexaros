import React, { useEffect } from 'react';
import { NavigationContainer, LinkingOptions } from '@react-navigation/native';
import messaging from '@react-native-firebase/messaging';
import { AuthProvider } from './context/AuthContext';
import { RootNavigator, RootStackParamList } from './navigation/RootNavigator';

// Universal link deep link configuration (spec R3-C4)
// iOS:     associated-domains entitlement → applinks:app.[domain]
// Android: intent filter for https://app.[domain]/redeem
const linking: LinkingOptions<RootStackParamList> = {
  prefixes: ['https://app.myscheduler.com', 'aischeduler://'],
  config: {
    screens: {
      ShortCodeEntry: {
        path: 'redeem',
        parse: { code: (code: string) => code },
      },
      Main: '*',
    },
  },
};

function PushHandler() {
  useEffect(() => {
    // Push notification tap handler — app in background/killed state
    // All client notifications navigate to Chat (spec R3-G9)
    const unsubscribe = messaging().onNotificationOpenedApp(_remoteMessage => {
      // Navigation handled via deep link or manual navigate — wired in future phase
    });

    // Check if app was opened from a notification while killed
    messaging()
      .getInitialNotification()
      .then(_remoteMessage => {
        // Same handling — navigate to Chat
      });

    return unsubscribe;
  }, []);

  return null;
}

export default function App() {
  return (
    <AuthProvider>
      <NavigationContainer linking={linking}>
        <PushHandler />
        <RootNavigator />
      </NavigationContainer>
    </AuthProvider>
  );
}
