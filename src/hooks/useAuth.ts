import { useState, useEffect, useCallback } from 'react';
import { apiGet, apiPost } from '../services/apiClient';

export interface User {
  id: string;
  username: string;
  handle: string;
  avatarUrl: string | null;
}

export interface AuthApi {
  user: User | null;
  isLoading: boolean;
  /** OAuth URL that installs SWUTrade's bot in a Discord guild. */
  botInstallUrl: string | null;
  login: () => void;
  logout: () => Promise<void>;
}

export function useAuth(): AuthApi {
  const [user, setUser] = useState<User | null>(null);
  const [botInstallUrl, setBotInstallUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const result = await apiGet<{
        user?: User | null;
        botInstallUrl?: string | null;
      }>('/api/auth/me');
      if (result.ok) {
        setUser(result.data.user ?? null);
        setBotInstallUrl(result.data.botInstallUrl ?? null);
      } else {
        setUser(null);
      }
      setIsLoading(false);
    })();
  }, []);

  const login = useCallback(() => {
    window.location.href = '/api/auth/discord';
  }, []);

  const logout = useCallback(async () => {
    await apiPost('/api/auth/logout');
    setUser(null);
  }, []);

  return { user, isLoading, botInstallUrl, login, logout };
}
