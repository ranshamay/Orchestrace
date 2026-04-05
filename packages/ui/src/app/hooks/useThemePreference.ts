import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { ThemeMode } from '../types';

const THEME_STORAGE_KEY = 'orchestrace-theme';

function readInitialTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'dark';
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function useThemePreference(): {
  theme: ThemeMode;
  setTheme: Dispatch<SetStateAction<ThemeMode>>;
  isDark: boolean;
} {
  const [theme, setTheme] = useState<ThemeMode>(readInitialTheme);
  const isDark = theme === 'dark';

  useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    document.documentElement.classList.toggle('dark', isDark);
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [isDark, theme]);

  return { theme, setTheme, isDark };
}