const RUN_QUERY_PARAM = 'run';

export function readRunIdFromUrl(): string {
  if (typeof window === 'undefined') {
    return '';
  }

  return new URL(window.location.href).searchParams.get(RUN_QUERY_PARAM)?.trim() ?? '';
}

export function updateRunIdInUrl(runId: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  const url = new URL(window.location.href);
  const current = url.searchParams.get(RUN_QUERY_PARAM)?.trim() ?? '';
  const next = runId.trim();

  if (current === next) {
    return;
  }

  if (next) {
    url.searchParams.set(RUN_QUERY_PARAM, next);
  } else {
    url.searchParams.delete(RUN_QUERY_PARAM);
  }

  window.history.replaceState({}, '', url);
}

export function buildRunDeepLink(runId: string): string {
  if (typeof window === 'undefined') {
    return `?${RUN_QUERY_PARAM}=${encodeURIComponent(runId)}`;
  }

  const url = new URL(window.location.href);
  url.searchParams.set(RUN_QUERY_PARAM, runId);
  return url.toString();
}

export function compactRunId(runId: string): string {
  const id = runId.trim();
  if (id.length <= 12) {
    return id;
  }

  return `${id.slice(0, 8)}...${id.slice(-4)}`;
}