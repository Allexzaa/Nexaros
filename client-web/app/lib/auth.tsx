'use client';

import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { api } from './api';

interface ClientUser {
  clientId: string;
  name: string;
}

interface AuthContextType {
  client: ClientUser | null;
  loading: boolean;
  login: (clientId: string, name: string) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  client: null,
  loading: true,
  login: () => {},
  logout: async () => {},
});

export function AuthProvider({ children, slug }: { children: ReactNode; slug: string }) {
  const [client, setClient] = useState<ClientUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Check if we have a stored session in localStorage (set after OTP verify)
    const stored = localStorage.getItem(`client_session_${slug}`);
    if (stored) {
      try {
        setClient(JSON.parse(stored));
      } catch {
        localStorage.removeItem(`client_session_${slug}`);
      }
    }
    setLoading(false);
  }, [slug]);

  function login(clientId: string, name: string) {
    const user = { clientId, name };
    setClient(user);
    localStorage.setItem(`client_session_${slug}`, JSON.stringify(user));
  }

  async function logout() {
    await api.post('/client-auth/logout', {}).catch(() => {});
    localStorage.removeItem(`client_session_${slug}`);
    setClient(null);
  }

  return (
    <AuthContext.Provider value={{ client, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
