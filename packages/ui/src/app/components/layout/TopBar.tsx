import { Activity, GitBranch, LogOut, Moon, ScrollText, Settings, Sun } from 'lucide-react';
import type { Tab, ThemeMode } from '../../types';

type Props = {
  activeTab: Tab;
  onNavigate: (tab: Tab) => void;
  theme: ThemeMode;
  setTheme: (updater: (current: ThemeMode) => ThemeMode) => void;
  authUser: {
    email: string;
    name?: string;
    picture?: string;
  } | null;
  onLogout: () => void;
};

export function TopBar({ activeTab, onNavigate, theme, setTheme, authUser, onLogout }: Props) {
  const isDark = theme === 'dark';
  const userLabel = authUser?.name?.trim() || authUser?.email || '';
  const avatarFallback = userLabel.slice(0, 1).toUpperCase() || '?';

  const navItems: Array<{ tab: Tab; label: string; icon: typeof GitBranch }> = [
    { tab: 'graph', label: 'Graph', icon: GitBranch },
    { tab: 'logs', label: 'Logs', icon: ScrollText },
    { tab: 'settings', label: 'Settings', icon: Settings },
  ];

  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-slate-200/70 bg-white/90 px-3 backdrop-blur dark:border-slate-800/70 dark:bg-slate-900/90">
      <div className="flex min-w-0 items-center gap-3">
        <Activity className="h-4 w-4 text-blue-600" />
        <span className="text-sm font-bold tracking-tight text-slate-800 dark:text-slate-100">Orchestrace</span>
        <nav aria-label="Primary" className="ml-1 flex max-w-[46vw] items-center gap-1 overflow-x-auto pr-1 sm:ml-2 sm:max-w-[52vw]">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.tab;
            return (
              <button
                key={item.tab}
                aria-label={item.label}
                aria-current={isActive ? 'page' : undefined}
                className={`inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-semibold transition-colors sm:px-2.5 ${isActive
                  ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100'}`}
                onClick={() => onNavigate(item.tab)}
                type="button"
              >
                <Icon className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>
      <div className="flex items-center gap-1.5">
        <button
          aria-label="Toggle theme"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          onClick={() => setTheme((c) => (c === 'dark' ? 'light' : 'dark'))}
          title={isDark ? 'Light mode' : 'Dark mode'}
          type="button"
        >
          {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>
        {authUser && (
          <>
            <div className="mr-0.5 flex max-w-[180px] items-center gap-2 rounded-md border border-slate-200/80 bg-white/90 px-2 py-1 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 sm:max-w-[220px]">
              {authUser.picture ? (
                <img
                  alt={userLabel}
                  className="h-5 w-5 rounded-full border border-slate-200 object-cover dark:border-slate-700"
                  referrerPolicy="no-referrer"
                  src={authUser.picture}
                />
              ) : (
                <div className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-blue-100 text-[10px] font-semibold text-blue-700 dark:bg-blue-900/40 dark:text-blue-200">
                  {avatarFallback}
                </div>
              )}
              <span className="truncate" data-testid="auth-user-label" title={userLabel}>{userLabel}</span>
            </div>
            <button
              aria-label="Log out"
              className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-slate-600 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100"
              onClick={onLogout}
              title="Log out"
              type="button"
            >
              <LogOut className="h-4 w-4" />
              <span className="hidden text-xs sm:inline">Log out</span>
            </button>
          </>
        )}
      </div>
    </header>
  );
}
