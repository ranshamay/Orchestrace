import { useEffect, useState } from 'react';
import type { LogWatcherState } from '../../../lib/api';
import { fetchLogWatcherStatus } from '../../../lib/api';
import { LogWatcherPanel } from '../observer/LogWatcherPanel';

export function LogsTabView() {
  const [state, setState] = useState<LogWatcherState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <section className="h-full overflow-auto bg-slate-50 p-4 dark:bg-slate-950">
      <div className="mx-auto w-full max-w-5xl space-y-3">
        <header>
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">System Logs</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">Live backend watcher status and detected findings.</p>
        </header>

        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
            Failed to load log watcher status: {error}
          </div>
        )}

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
