import { LogWatcherPanel } from '../observer/LogWatcherPanel';

export function LogsTabView() {
  return (
    <div className="h-full overflow-auto bg-slate-50 p-4 dark:bg-slate-950">
      <div className="mx-auto max-w-5xl space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">
          Logs
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Live watcher status and findings from backend logs.
        </p>
        <LogWatcherPanel />
      </div>
    </div>
  );
}