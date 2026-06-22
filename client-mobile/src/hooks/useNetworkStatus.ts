import { useEffect, useState } from 'react';
import NetInfo, { NetInfoState } from '@react-native-community/netinfo';
import { flushQueue } from '../services/messageQueue';

export function useNetworkStatus(): boolean {
  const [isConnected, setIsConnected] = useState(true);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state: NetInfoState) => {
      const connected = state.isConnected ?? true;
      setIsConnected(connected);
      if (connected) {
        // Network restored — flush any queued outgoing messages
        flushQueue().catch(console.error);
      }
    });
    return unsubscribe;
  }, []);

  return isConnected;
}
