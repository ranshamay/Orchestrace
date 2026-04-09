import { useEffect, useMemo, useRef, useState } from 'react';
import type { LogWatcherState } from '../../../lib/api';
import { API_BASE, fetchLogWatcherStatus } from '../../../lib/api';
import { LogWatcherPanel } from '../observer/LogWatcherPanel';

const MAX_LOG_LINES = 1200;

export function LogsTabView() {
  const [state, setState] = useState<LogWatcherState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [streamConnected, setStreamConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  const logViewportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const data = await fetchLogWatcherStatus();
        if (!cancelled) {
          setState(data.state);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void poll();
    const interval = window.setInterval(() => {
      void poll();
    }, 30_000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const url = `${API_BASE}/logs/stream`;
    const es = new EventSource(url);

    const handleOpen = () => {
      setStreamConnected(true);
      setError(null);
    };

    const handleLog = (ev: MessageEvent) => {
      if (pausedRef.current) {
        return;
      }

      try {
        const data = JSON.parse(ev.data) as { line?: string };
        const line = typeof data.line === 'string' ? data.line : '';
        if (!line) {
          return;
        }

        setLines((current) => {
          const next = [...current, line];
          if (next.length > MAX_LOG_LINES) {
            return next.slice(next.length - MAX_LOG_LINES);
          }
          return next;
        });
      } catch {
        // Ignore malformed stream payloads.
      }
    };

    const handleState = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as { state?: LogWatcherState };
        if (data.state) {
          setState(data.state);
          setIsLoading(false);
        }
      } catch {
        // Ignore malformed stream payloads.
      }
    };

    const handleError = () => {
      setStreamConnected(false);
      setError((current) => current ?? 'Log stream disconnected. Retrying...');
    };

    es.addEventListener('open', handleOpen as EventListener);
    es.addEventListener('log', handleLog as EventListener);
    es.addEventListener('log-watcher-state', handleState as EventListener);
    es.addEventListener('error', handleError as EventListener);

    return () => {
      es.close();
    };
  }, []);

  useEffect(() => {
    const el = logViewportRef.current;
    if (!el || paused) {
      return;
    }

    el.scrollTop = el.scrollHeight;
  }, [lines, paused]);

  const streamBadgeClass = useMemo(() => (
    streamConnected
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-300'
      : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300'
  ), [streamConnected]);

  return (
    <section className="h-full overflow-auto bg-slate-50 p-4 dark:bg-slate-950">
      <div className="mx-auto w-full max-w-5xl space-y-3">
        <header>
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">System Logs</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">Live backend log stream with watcher findings and status.</p>
        </header>

        <div className="flex items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center gap-2">
            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${streamBadgeClass}`}>
              {streamConnected ? 'stream connected' : 'stream reconnecting'}
            </span>
            <span className="text-[11px] text-slate-500 dark:text-slate-400">
              {lines.length.toLocaleString()} line{lines.length === 1 ? '' : 's'} buffered
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              className="rounded border border-slate-300 px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              onClick={() => setPaused((current) => !current)}
              type="button"
            >
              {paused ? 'Resume' : 'Pause'}
            </button>
            <button
              className="rounded border border-slate-300 px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              onClick={() => setLines([])}
              type="button"
            >
              Clear
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
            Failed to load log watcher status: {error}
          </div>
        )}

        <div className="rounded-md border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="border-b border-slate-200 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
            Stream
          </div>
          <div ref={logViewportRef} className="h-64 overflow-auto p-3">
            {lines.length > 0 ? (
              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-slate-700 dark:text-slate-200">{lines.join('\n')}</pre>
            ) : (
              <p className="text-xs text-slate-500 dark:text-slate-400">No streamed lines yet. Backend lines will appear here as they are emitted.</p>
            )}
          </div>
        </div>

        {isLoading && !state && (
          <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
            Loading log watcher status...
          </div>
        )}

        {state && state.status !== 'idle' ? (
          <LogWatcherPanel logWatcherState={state} />
        ) : (
          <div className="rounded-md border border-slate-200 bg-white px-3 py-3 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
            Log watcher is idle. Start a session to begin collecting and analyzing logs.
          </div>
        )}
      </div>
    </section>
  );
}
