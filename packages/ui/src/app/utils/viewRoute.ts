import type { Tab } from '../types';

const SETTINGS_PATH = '/settings';
const LOGS_PATH = '/logs';

function normalizePathname(pathname: string): string {
  if (!pathname) {
    return '/';
  }

  const trimmed = pathname.trim();
  if (trimmed.length > 1 && trimmed.endsWith('/')) {
    return trimmed.slice(0, -1);
  }

  return trimmed;
}

function pathnameForTab(tab: Tab): string {
  if (tab === 'settings') return SETTINGS_PATH;
  if (tab === 'logs') return LOGS_PATH;
  return '/';
}

export function readTabFromUrl(): Tab {
  if (typeof window === 'undefined') {
    return 'graph';
  }

  const pathname = normalizePathname(window.location.pathname);
  if (pathname === SETTINGS_PATH) return 'settings';
  if (pathname === LOGS_PATH) return 'logs';
  return 'graph';
}

export function updateTabInUrl(tab: Tab, mode: 'push' | 'replace' = 'push'): void {
  if (typeof window === 'undefined') {
    return;
  }

  const url = new URL(window.location.href);
  const currentPath = normalizePathname(url.pathname);
  const nextPath = pathnameForTab(tab);

  if (currentPath === nextPath) {
    return;
  }

  url.pathname = nextPath;

  if (mode === 'replace') {
    window.history.replaceState({}, '', url);
    return;
  }

  window.history.pushState({}, '', url);
}