import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { api, setToken, getToken } from '../utils/api';
import type { AuthUser } from '@shared/types';
import { checkPermission } from '@shared/permissions';

interface AuthContextType {
  user: AuthUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  hasPerm: (perm: string) => boolean;
  hasAnyPerm: (...perms: string[]) => boolean;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  login: async () => {},
  logout: () => {},
  hasPerm: () => false,
  hasAnyPerm: () => false,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = getToken();
    if (token) {
      api('/auth/me')
        .then(setUser)
        .catch(() => setToken(null))
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const login = async (username: string, password: string) => {
    const data = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    setToken(data.token);
    setUser(data.user);
  };

  const logout = async () => {
    // 서버에 로그아웃 알림 → last_logout_at 갱신으로 토큰 즉시 무효화
    try { await api('/auth/logout', { method: 'POST' }); } catch {}
    setToken(null);
    setUser(null);
  };

  // PERM_HIERARCHY 양방향 검사 적용 — 묶음 권한이 분해된 하위 권한들로도 통과
  // 예: REQUEST_USE의 하위 4개를 모두 보유하면 hasPerm('REQUEST_USE') = true
  const hasPerm = (perm: string) => user ? checkPermission(user.permissions, perm) : false;
  const hasAnyPerm = (...perms: string[]) => user ? checkPermission(user.permissions, undefined, perms) : false;

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, hasPerm, hasAnyPerm }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
