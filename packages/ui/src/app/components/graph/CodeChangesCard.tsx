import { useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { WorkSession, WorkSessionDiffFileStatus, WorkSessionDiffResponse } from '../../../lib/api';
import { fetchWorkDiff } from '../../../lib/api';

type Props = {
  selectedSession?: WorkSession;
  selectedSessionRunning: boolean;
};

const REFRESH_INTERVAL_MS = 8_000;

export function CodeChangesCard({ selectedSession, selectedSessionRunning }: Props) {
  const [snapshot, setSnapshot] = useState<WorkSessionDiffResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const implementationStarted = selectedSession ? hasImplementationStarted(selectedSession) : false;
  const canShowDiff = Boolean(selectedSession?.worktreePath) && implementationStarted;

  useEffect(() => {
    const sessionId = selectedSession?.id;
    if (!sessionId || !canShowDiff) {
      setSnapshot(null);
      setError(null);
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);

    const run = async () => {
      try {
        const next = await fetchWorkDiff(sessionId);
        if (!cancelled) {
          setSnapshot(next);
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

    void run();

    let intervalId: number | undefined;
    if (selectedSessionRunning) {
      intervalId = window.setInterval(() => {
        void run();
      }, REFRESH_INTERVAL_MS);
    }

    return () => {
      cancelled = true;
      if (intervalId !== undefined) {
        window.clearInterval(intervalId);
      }
    };
  }, [canShowDiff, selectedSession?.id, selectedSessionRunning, refreshTick]);

  const sortedFiles = useMemo(() => {
    if (!snapshot?.files) {
      return [];
    }

    return [...snapshot.files].sort((a, b) => a.path.localeCompare(b.path));
  }, [snapshot?.files]);

  const canRefresh = Boolean(selectedSession?.id);

  return (
    <section className="mt-4 rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Code Changes</h3>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">Diff of selected session worktree changes vs main.</p>
        </div>
        <button
          className="inline-flex items-center gap-1 rounded border border-slate-300 px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
          disabled={!canRefresh || !canShowDiff || isLoading}
          onClick={() => setRefreshTick((current) => current + 1)}
          type="button"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {!selectedSession && (
        <div className="px-3 py-4 text-xs text-slate-500 dark:text-slate-400">
          Select a session to inspect code changes.
        </div>
      )}

      {selectedSession && !implementationStarted && (
        <div className="px-3 py-4 text-xs text-slate-500 dark:text-slate-400">
          Code changes are shown after implementation starts for this session.
        </div>
      )}

      {selectedSession && implementationStarted && !selectedSession.worktreePath && (
        <div className="px-3 py-4 text-xs text-slate-500 dark:text-slate-400">
          This session has no managed worktree path, so no per-session diff is available.
        </div>
      )}

      {selectedSession && canShowDiff && (
        <div className="space-y-3 px-3 py-3">
          {snapshot && (
            <div className="grid grid-cols-2 gap-2 rounded border border-slate-200 bg-slate-50 px-2.5 py-2 text-[11px] text-slate-600 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300">
              <div className="truncate">Base: <span className="font-mono">{snapshot.baseBranch}</span></div>
              <div className="truncate">Files: <span className="font-mono">{snapshot.stats.files}</span></div>
              <div className="truncate">+<span className="font-mono">{snapshot.stats.additions}</span> / -<span className="font-mono">{snapshot.stats.deletions}</span></div>
              <div className="truncate">Path: <span className="font-mono">{snapshot.comparedPath}</span></div>
            </div>
          )}

          {error && (
            <div className="rounded border border-red-200 bg-red-50 px-2.5 py-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
              Failed to load diff: {error}
            </div>
          )}

          {snapshot && sortedFiles.length > 0 && (
            <div className="flex max-h-28 flex-wrap gap-1 overflow-auto rounded border border-slate-200 bg-slate-50 p-2 dark:border-slate-800 dark:bg-slate-950">
              {sortedFiles.map((file) => (
                <span
                  key={`${file.path}:${file.status}:${file.previousPath ?? ''}`}
                  className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${fileStatusBadgeClass(file.status)}`}
                  title={file.previousPath ? `${file.previousPath} -> ${file.path}` : file.path}
                >
                  {file.status} {file.path}
                </span>
              ))}
            </div>
          )}

          {snapshot && !snapshot.hasChanges && !isLoading && !error && (
            <div className="rounded border border-emerald-200 bg-emerald-50 px-2.5 py-2 text-xs text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300">
              No code changes against {snapshot.baseBranch}.
            </div>
          )}

          {(isLoading || (snapshot && snapshot.hasChanges)) && (
            <div className="overflow-auto rounded border border-slate-200 bg-slate-950 p-2 dark:border-slate-800">
              <pre className="min-h-24 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-slate-100">
                {isLoading && !snapshot ? 'Loading diff...' : snapshot?.diff || ''}
              </pre>
            </div>
          )}

          {snapshot?.truncated && (
            <div className="text-[11px] text-amber-600 dark:text-amber-300">
              Diff output is truncated for performance.
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function fileStatusBadgeClass(status: WorkSessionDiffFileStatus): string {
  if (status === 'added') return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300';
  if (status === 'modified') return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300';
  if (status === 'deleted') return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300';
  if (status === 'renamed') return 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300';
  if (status === 'copied') return 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300';
  if (status === 'unmerged') return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300';
  return 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300';
}

function hasImplementationStarted(session: WorkSession): boolean {
  if (session.llmStatus?.phase === 'implementation') {
    return true;
  }

  const llmState = (session.llmStatus?.state ?? '').trim().toLowerCase();
  if (llmState === 'implementing' || llmState === 'using-tools' || llmState === 'validating' || llmState === 'retrying') {
    return true;
  }

  const implementationPercent = session.progress?.implementationPercent ?? 0;
  if (implementationPercent > 0) {
    return true;
  }

  return session.events.some((event) => event.type.toLowerCase().includes('implementation'));
}
