import { Activity, Moon, Settings, SlidersHorizontal, Sun } from 'lucide-react';
import type { ThemeMode } from '../../types';

type Props = {
  theme: ThemeMode;
  setTheme: (updater: (current: ThemeMode) => ThemeMode) => void;
  onOpenSettings: () => void;
  onOpenLlmControls: () => void;
};

export function TopBar({ theme, setTheme, onOpenSettings, onOpenLlmControls }: Props) {
  const isDark = theme === 'dark';

  return (
    <header className="flex h-10 shrink-0 items-center justify-between border-b border-slate-200/60 bg-white/80 px-3 backdrop-blur dark:border-slate-800/60 dark:bg-slate-900/80">
      <div className="flex items-center gap-2">
        <Activity className="h-4 w-4 text-blue-600" />
        <span className="text-sm font-bold tracking-tight text-slate-800 dark:text-slate-100">Orchestrace</span>
      </div>
      <div className="flex items-center gap-1">
        <button
          aria-label="LLM Controls"
          className="inline-flex h-7 w-7 items-center justify-center rounded text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          onClick={onOpenLlmControls}
          title="LLM Controls"
          type="button"
        >
          <SlidersHorizontal className="h-4 w-4" />
        </button>
        <button
          aria-label="Settings"
          className="inline-flex h-7 w-7 items-center justify-center rounded text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          onClick={onOpenSettings}
          title="Settings"
          type="button"
        >
          <Settings className="h-4 w-4" />
        </button>
        <button
          aria-label="Toggle theme"
          className="inline-flex h-7 w-7 items-center justify-center rounded text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          onClick={() => setTheme((c) => (c === 'dark' ? 'light' : 'dark'))}
          title={isDark ? 'Light mode' : 'Dark mode'}
          type="button"
        >
          {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>
      </div>
    </header>
  );
}
