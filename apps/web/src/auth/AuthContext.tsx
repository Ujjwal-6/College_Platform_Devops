import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import * as client from '../api/client';
import type { Role, User } from '../api/types';

type Status = 'loading' | 'authenticated' | 'anonymous';

interface AuthState {
  status: Status;
  user: User | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  hasRole: (...roles: Role[]) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    client.setSessionLostHandler(() => {
      setUser(null);
      setStatus('anonymous');
    });
    // Restore the session after a page reload using the httpOnly refresh cookie.
    let cancelled = false;
    void client.refreshSession().then((restored) => {
      if (cancelled) return;
      setUser(restored);
      setStatus(restored ? 'authenticated' : 'anonymous');
    });
    return () => {
      cancelled = true;
      client.setSessionLostHandler(null);
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const u = await client.login(email, password);
    setUser(u);
    setStatus('authenticated');
  }, []);

  const signOut = useCallback(async () => {
    try {
      await client.logout();
    } finally {
      setUser(null);
      setStatus('anonymous');
    }
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      status,
      user,
      signIn,
      signOut,
      hasRole: (...roles) => !!user && user.roles.some((r) => roles.includes(r)),
    }),
    [status, user, signIn, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
