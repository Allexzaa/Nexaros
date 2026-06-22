import { createContext, useContext, useState, useCallback, useRef, ReactNode } from 'react';
import { setAccessToken, api } from '../lib/api';

export type Role = 'admin' | 'staff' | 'viewer';

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
  canTriggerOutreach: boolean;
  canEditSchedule: boolean;
}

interface AuthContextValue {
  user: AuthUser | null;
  isAuthenticated: boolean;
  login: (user: AuthUser, token: string) => void;
  logout: () => void;
}

const ACCESS_TOKEN_TTL_MS = 5 * 60 * 1000;        // 5 minutes
const REFRESH_BEFORE_MS   = 10 * 1000;             // refresh 10s before expiry

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser]       = useState<AuthUser | null>(null);
  const refreshTimer          = useRef<ReturnType<typeof setTimeout> | null>(null);

  function scheduleRefresh(onSuccess: (newToken: string) => void) {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(async () => {
      try {
        const { accessToken } = await api.post<{ accessToken: string }>('/auth/refresh', {});
        setAccessToken(accessToken);
        onSuccess(accessToken);
        scheduleRefresh(onSuccess);
      } catch {
        // Refresh failed — session expired; logout
        setAccessToken(null);
        setUser(null);
      }
    }, ACCESS_TOKEN_TTL_MS - REFRESH_BEFORE_MS);
  }

  const login = useCallback((u: AuthUser, token: string) => {
    setAccessToken(token);
    setUser(u);
    scheduleRefresh((_newToken) => {
      // Token updated in api module via setAccessToken above — nothing else needed
    });
  }, []);

  const logout = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    api.post('/auth/logout', {}).catch(() => {});
    setAccessToken(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, isAuthenticated: !!user, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
