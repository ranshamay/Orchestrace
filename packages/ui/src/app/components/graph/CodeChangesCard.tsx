import { useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { WorkSession, WorkSessionDiffFile, WorkSessionDiffFileStatus, WorkSessionDiffResponse } from '../../../lib/api';
import { fetchWorkDiff } from '../../../lib/api';

type Props = {
  selectedSession?: WorkSession;
  selectedSessionRunning: boolean;
};

type StatusFilter = 'all' | WorkSessionDiffFileStatus;

type DiffFileSection = {
  path: string;
  status: WorkSessionDiffFileStatus;
  previousPath?: string;
  lines: string[];
  additions: number;
  deletions: number;
  hunks: number;
};

type DiffLineKind = 'added' | 'removed' | 'hunk' | 'meta' | 'context';

const STATUS_FILTERS: StatusFilter[] = ['all', 'added', 'modified', 'deleted', 'renamed', 'copied', 'unmerged', 'unknown'];

const REFRESH_INTERVAL_MS = 8_000;

export function CodeChangesCard({ selectedSession, selectedSessionRunning }: Props) {
  const [snapshot, setSnapshot] = useState<WorkSessionDiffResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [activeFilePath, setActiveFilePath] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const implementationStarted = selectedSession ? hasImplementationStarted(selectedSession) : false;
  const canShowDiff = Boolean(selectedSession?.worktreePath);

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

  useEffect(() => {
    setStatusFilter('all');
    setActiveFilePath('');
  }, [selectedSession?.id]);

  const fileSections = useMemo(() => {
    if (!snapshot) {
      return [];
    }
    return parseDiffSections(snapshot.diff, snapshot.files);
  }, [snapshot]);

  const statusCounts = useMemo(() => {
    const counts: Record<StatusFilter, number> = {
      all: fileSections.length,
      added: 0,
      modified: 0,
      deleted: 0,
      renamed: 0,
      copied: 0,
      unmerged: 0,
      unknown: 0,
    };

    for (const section of fileSections) {
      counts[section.status] += 1;
    }

    return counts;
  }, [fileSections]);

  const visibleSections = useMemo(() => {
    if (statusFilter === 'all') {
      return fileSections;
    }
    return fileSections.filter((section) => section.status === statusFilter);
  }, [fileSections, statusFilter]);

  const activeSection = useMemo(() => {
    if (visibleSections.length === 0) {
      return undefined;
    }
    return visibleSections.find((section) => section.path === activeFilePath) ?? visibleSections[0];
  }, [activeFilePath, visibleSections]);

  useEffect(() => {
    if (!activeSection) {
      if (activeFilePath) {
        setActiveFilePath('');
      }
      return;
    }

    if (activeSection.path !== activeFilePath) {
      setActiveFilePath(activeSection.path);
    }
  }, [activeFilePath, activeSection]);

  const canRefresh = Boolean(selectedSession?.id);
  const totalTouchedLines = (snapshot?.stats.additions ?? 0) + (snapshot?.stats.deletions ?? 0);
  const additionsPercent = totalTouchedLines > 0
    ? Math.round(((snapshot?.stats.additions ?? 0) / totalTouchedLines) * 100)
    : 0;
  const deletionsPercent = totalTouchedLines > 0 ? 100 - additionsPercent : 0;

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

      {selectedSession && selectedSession.worktreePath && !implementationStarted && (
        <div className="px-3 py-4 text-xs text-slate-500 dark:text-slate-400">
          Implementation has not started yet; showing the current worktree diff against main.
        </div>
      )}

      {selectedSession && !selectedSession.worktreePath && (
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

          {snapshot && !snapshot.hasChanges && !isLoading && !error && (
            <div className="rounded border border-emerald-200 bg-emerald-50 px-2.5 py-2 text-xs text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300">
              No code changes against {snapshot.baseBranch}.
            </div>
          )}

          {snapshot && snapshot.hasChanges && (
            <>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-2.5 dark:border-slate-800 dark:bg-slate-950/70">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">Change Story</div>
                  <div className="flex items-center gap-2 text-[10px] font-mono">
                    <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">+{snapshot.stats.additions}</span>
                    <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700 dark:bg-red-900/40 dark:text-red-300">-{snapshot.stats.deletions}</span>
                    <span className="rounded bg-slate-200 px-1.5 py-0.5 text-slate-600 dark:bg-slate-800 dark:text-slate-300">{snapshot.stats.files} files</span>
                  </div>
                </div>
                <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                  <div className="bg-emerald-500" style={{ width: `${additionsPercent}%` }} />
                  <div className="bg-rose-500" style={{ width: `${deletionsPercent}%` }} />
                </div>
                <div className="mt-2 grid gap-2 md:grid-cols-2">
                  <StoryBlock label="Why" text={summarizeSessionIntent(selectedSession)} />
                  <StoryBlock label="What changed" text={summarizeSnapshotChange(snapshot)} />
                </div>
              </div>

              <div className="flex flex-wrap gap-1">
                {STATUS_FILTERS.filter((filter) => filter === 'all' || statusCounts[filter] > 0).map((filter) => {
                  const selected = statusFilter === filter;
                  const count = statusCounts[filter];
                  return (
                    <button
                      key={filter}
                      className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide transition ${selected
                        ? 'border-cyan-300 bg-cyan-50 text-cyan-700 dark:border-cyan-700/70 dark:bg-cyan-900/25 dark:text-cyan-300'
                        : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800'}`}
                      onClick={() => setStatusFilter(filter)}
                      type="button"
                    >
                      {statusFilterLabel(filter)}
                      <span className="rounded bg-black/5 px-1 py-0.5 font-mono text-[10px] dark:bg-white/10">{count}</span>
                    </button>
                  );
                })}
              </div>

              <div className="grid gap-3 xl:grid-cols-[280px_minmax(0,1fr)]">
                <div className="max-h-80 space-y-1.5 overflow-auto pr-1">
                  {visibleSections.map((section) => {
                    const isActive = activeSection?.path === section.path;
                    return (
                      <button
                        key={`${section.path}:${section.status}:${section.previousPath ?? ''}`}
                        className={`w-full rounded-lg border p-2 text-left transition ${isActive
                          ? 'border-cyan-300 bg-cyan-50/60 shadow-sm dark:border-cyan-700/60 dark:bg-cyan-900/20'
                          : 'border-slate-200 bg-white hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-950 dark:hover:bg-slate-900'}`}
                        onClick={() => setActiveFilePath(section.path)}
                        type="button"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${fileStatusBadgeClass(section.status)}`}>
                            {section.status}
                          </span>
                          <span className="font-mono text-[10px] text-slate-500 dark:text-slate-400">+{section.additions} -{section.deletions}</span>
                        </div>
                        <div className="mt-1 truncate font-mono text-[11px] text-slate-700 dark:text-slate-200">{section.path}</div>
                        {section.previousPath && (
                          <div className="mt-0.5 truncate text-[10px] text-slate-500 dark:text-slate-400">from {section.previousPath}</div>
                        )}
                        <div className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">{section.hunks} hunks · {section.lines.length} lines</div>
                      </button>
                    );
                  })}
                </div>

                <div className="overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
                  {activeSection ? (
                    <>
                      <div className="border-b border-slate-200 bg-slate-50 px-2.5 py-2 dark:border-slate-800 dark:bg-slate-950/80">
                        <div className="flex items-center justify-between gap-2">
                          <div className="truncate font-mono text-[11px] text-slate-700 dark:text-slate-200">{activeSection.path}</div>
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${fileStatusBadgeClass(activeSection.status)}`}>
                            {activeSection.status}
                          </span>
                        </div>
                        <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">{describeSectionNarrative(activeSection)}</p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] text-slate-500 dark:text-slate-400">
                          <LegendDot kind="added" label="Added line" />
                          <LegendDot kind="removed" label="Removed line" />
                          <LegendDot kind="hunk" label="Hunk context" />
                          <LegendDot kind="meta" label="File metadata" />
                        </div>
                      </div>
                      <div className="max-h-80 overflow-auto p-2">
                        <ColoredDiffLines lines={activeSection.lines} />
                      </div>
                    </>
                  ) : (
                    <div className="px-3 py-4 text-xs text-slate-500 dark:text-slate-400">
                      No files match this filter.
                    </div>
                  )}
                </div>
              </div>
            </>
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

function StoryBlock({ label, text }: { label: string; text: string }) {
  return (
    <div className="rounded border border-slate-200 bg-white px-2 py-1.5 dark:border-slate-800 dark:bg-slate-900">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</div>
      <div className="mt-1 text-xs text-slate-700 dark:text-slate-200">{text}</div>
    </div>
  );
}

function LegendDot({ kind, label }: { kind: DiffLineKind; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`h-1.5 w-1.5 rounded-full ${diffDotClass(kind)}`} />
      {label}
    </span>
  );
}

function ColoredDiffLines({ lines }: { lines: string[] }) {
  if (lines.length === 0) {
    return <div className="text-xs text-slate-500 dark:text-slate-400">No patch lines available.</div>;
  }

  return (
    <div className="font-mono text-[11px] leading-relaxed">
      {lines.map((line, i) => {
        const kind = classifyDiffLine(line);
        return (
          <div key={`${i}:${line.slice(0, 32)}`} className={`grid grid-cols-[14px_auto_1fr] items-start gap-2 px-1.5 -mx-1.5 ${diffLineClass(kind)}`}>
            <span className={`mt-[5px] h-1.5 w-1.5 rounded-full ${diffDotClass(kind)}`} />
            <span className="select-none text-[10px] text-slate-400 dark:text-slate-500">{String(i + 1).padStart(3, '0')}</span>
            <span className="whitespace-pre-wrap break-words">{line === '' ? ' ' : line}</span>
          </div>
        );
      })}
    </div>
  );
}

function parseDiffSections(diff: string, files: WorkSessionDiffFile[]): DiffFileSection[] {
  const normalized = diff.trim();
  if (!normalized) {
    return files.map((file) => ({
      path: file.path,
      status: file.status,
      previousPath: file.previousPath,
      lines: [`diff --git a/${file.previousPath ?? file.path} b/${file.path}`, '# No textual patch available.'],
      additions: 0,
      deletions: 0,
      hunks: 0,
    }));
  }

  const fileIndex = new Map(files.map((file) => [file.path, file]));
  const sections: DiffFileSection[] = [];
  let current: DiffFileSection | undefined;

  const flushCurrent = () => {
    if (!current) {
      return;
    }
    sections.push(current);
    current = undefined;
  };

  for (const line of normalized.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flushCurrent();
      const parsedPath = parsePathFromDiffHeader(line);
      const mapped = parsedPath ? fileIndex.get(parsedPath) : undefined;
      current = {
        path: parsedPath ?? mapped?.path ?? 'unknown',
        status: mapped?.status ?? 'unknown',
        previousPath: mapped?.previousPath,
        lines: [line],
        additions: 0,
        deletions: 0,
        hunks: 0,
      };
      continue;
    }

    if (!current) {
      const fallback = files[0];
      current = {
        path: fallback?.path ?? 'changes',
        status: fallback?.status ?? 'unknown',
        previousPath: fallback?.previousPath,
        lines: [],
        additions: 0,
        deletions: 0,
        hunks: 0,
      };
    }

    current.lines.push(line);

    if (line.startsWith('+++ b/')) {
      const nextPath = line.slice('+++ b/'.length).trim();
      if (nextPath && nextPath !== '/dev/null') {
        current.path = nextPath;
        const mapped = fileIndex.get(nextPath);
        if (mapped) {
          current.status = mapped.status;
          current.previousPath = mapped.previousPath;
        }
      }
    }

    if (line.startsWith('--- a/') && !current.previousPath) {
      const previousPath = line.slice('--- a/'.length).trim();
      if (previousPath && previousPath !== '/dev/null') {
        current.previousPath = previousPath;
      }
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      current.additions += 1;
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      current.deletions += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      current.hunks += 1;
    }
  }

  flushCurrent();

  if (sections.length === 0) {
    return files.map((file) => ({
      path: file.path,
      status: file.status,
      previousPath: file.previousPath,
      lines: [`diff --git a/${file.previousPath ?? file.path} b/${file.path}`],
      additions: 0,
      deletions: 0,
      hunks: 0,
    }));
  }

  return sections;
}

function parsePathFromDiffHeader(line: string): string | undefined {
  const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
  if (!match) {
    return undefined;
  }
  const path = match[2]?.trim();
  return path || undefined;
}

function summarizeSessionIntent(session?: WorkSession): string {
  const outputText = session?.output?.text?.trim();
  if (outputText) {
    return trimText(outputText, 190);
  }
  const promptText = session?.prompt?.trim();
  if (promptText) {
    return trimText(promptText, 190);
  }
  return 'Session intent is not available yet.';
}

function summarizeSnapshotChange(snapshot: WorkSessionDiffResponse): string {
  return `${snapshot.stats.files} files changed, with +${snapshot.stats.additions} additions and -${snapshot.stats.deletions} deletions against ${snapshot.baseBranch}.`;
}

function trimText(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 1)}…`;
}

function statusFilterLabel(filter: StatusFilter): string {
  if (filter === 'all') {
    return 'all';
  }
  return filter;
}

function describeSectionNarrative(section: DiffFileSection): string {
  if (section.status === 'added') {
    return 'New file introduced in this session, likely implementing new behavior.';
  }
  if (section.status === 'deleted') {
    return 'File removed as part of cleanup or replacement.';
  }
  if (section.status === 'renamed') {
    return 'File moved or renamed, possibly alongside content updates.';
  }
  if (section.status === 'copied') {
    return 'File copied from another location and adjusted.';
  }
  if (section.additions > section.deletions * 2) {
    return 'Primarily additive edits, suggesting feature expansion.';
  }
  if (section.deletions > section.additions * 2) {
    return 'Primarily reductive edits, suggesting simplification or removal.';
  }
  return 'Balanced update with both additions and removals.';
}

function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith('+') && !line.startsWith('+++')) {
    return 'added';
  }
  if (line.startsWith('-') && !line.startsWith('---')) {
    return 'removed';
  }
  if (line.startsWith('@@')) {
    return 'hunk';
  }
  if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
    return 'meta';
  }
  return 'context';
}

function diffLineClass(kind: DiffLineKind): string {
  if (kind === 'added') {
    return 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200';
  }
  if (kind === 'removed') {
    return 'bg-red-50 text-red-800 dark:bg-red-500/15 dark:text-red-200';
  }
  if (kind === 'hunk') {
    return 'bg-cyan-50 text-cyan-800 dark:bg-cyan-500/15 dark:text-cyan-200';
  }
  if (kind === 'meta') {
    return 'bg-slate-100 text-slate-700 dark:bg-slate-800/70 dark:text-slate-200';
  }
  return 'text-slate-500 dark:text-slate-400';
}

function diffDotClass(kind: DiffLineKind): string {
  if (kind === 'added') {
    return 'bg-emerald-500';
  }
  if (kind === 'removed') {
    return 'bg-red-500';
  }
  if (kind === 'hunk') {
    return 'bg-cyan-500';
  }
  if (kind === 'meta') {
    return 'bg-slate-500';
  }
  return 'bg-slate-300 dark:bg-slate-600';
}
