import messaging from '@react-native-firebase/messaging';
import { Platform } from 'react-native';
import { api } from '../lib/api';

// Called on app launch after authentication — upserts the FCM token server-side
export async function registerDeviceToken(): Promise<void> {
  const authStatus = await messaging().requestPermission();
  const granted =
    authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
    authStatus === messaging.AuthorizationStatus.PROVISIONAL;

  if (!granted) return;

  const token = await messaging().getToken();
  const platform = Platform.OS as 'ios' | 'android';

  await api.post('/device-tokens', { token, platform });
}

// Called on logout — removes the token server-side
export async function unregisterDeviceToken(): Promise<void> {
  const platform = Platform.OS as 'ios' | 'android';
  await api.delete(`/device-tokens/${platform}`).catch(() => {});
  await messaging().deleteToken();
}
