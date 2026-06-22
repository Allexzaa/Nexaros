import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';

export interface AuthUser {
  clientId: string;
  businessId: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  login: (user: AuthUser, token: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// Module-level token ref so api.ts can read it without importing the context
let _token: string | null = null;
export function getAccessToken(): string | null { return _token; }

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);

  const login = useCallback((u: AuthUser, token: string) => {
    _token = token;
    setUser(u);
    setAccessToken(token);
  }, []);

  const logout = useCallback(() => {
    _token = null;
    setUser(null);
    setAccessToken(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, accessToken, isAuthenticated: !!user, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
