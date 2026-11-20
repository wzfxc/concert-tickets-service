'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, tokenStore, unwrap, type StoredUser } from './api';
import { useRouter } from '../i18n/routing';
import { closeSocket } from './socket';

interface AuthState {
  user: StoredUser | null;
  ready: boolean;
  login: (email: string, password: string) => Promise<StoredUser>;
  register: (input: {
    email: string;
    password: string;
    name: string;
    locale: 'uk' | 'en' | 'pl';
  }) => Promise<StoredUser>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<StoredUser | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setUser(tokenStore.user());
    setReady(true);
  }, []);

  const finish = useCallback((res: { token: string; user: StoredUser }): StoredUser => {
    tokenStore.set(res.token, res.user);
    setUser(res.user);
    return res.user;
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      ready,
      login: async (email, password) =>
        finish(unwrap(await api.POST('/api/auth/login', { body: { email, password } }))),
      register: async (input) =>
        finish(unwrap(await api.POST('/api/auth/register', { body: input }))),
      logout: () => {
        tokenStore.clear();
        closeSocket();
        setUser(null);
      },
    }),
    [user, ready, finish],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}

/** Client-side gate for pages of one role (the API enforces it again server-side); redirects to /login otherwise. */
export function useRequireRole(role: StoredUser['role']): boolean {
  const { user, ready } = useAuth();
  const router = useRouter();
  const ok = ready && user?.role === role;
  useEffect(() => {
    if (ready && user?.role !== role) router.replace('/login');
  }, [ready, user, role, router]);
  return ok;
}
