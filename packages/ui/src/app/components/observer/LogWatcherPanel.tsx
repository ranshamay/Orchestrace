import { ScrollText, AlertTriangle, CheckCircle, Loader2, ChevronDown, ChevronUp, FileCode } from 'lucide-react';
import { useState, useEffect } from 'react';
import type { LogFinding, LogWatcherState } from '../../../lib/api';
import { fetchLogWatcherStatus } from '../../../lib/api';

type Props = {
  /** If provided via SSE, use this state directly. Otherwise poll. */
  logWatcherState?: LogWatcherState | null;
};

const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const severityBadgeClass: Record<string, string> = {
  critical: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  high: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  low: 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
};

const categoryBadgeClass: Record<string, string> = {
  'error-pattern': 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  performance: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  configuration: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300',
  reliability: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
  security: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
};

function statusIndicator(status: LogWatcherState['status']) {
  switch (status) {
    case 'watching':
      return <ScrollText className="h-3.5 w-3.5 text-teal-500 animate-pulse" />;
    case 'analyzing':
      return <Loader2 className="h-3.5 w-3.5 text-teal-500 animate-spin" />;
    case 'stopped':
      return <CheckCircle className="h-3.5 w-3.5 text-slate-400" />;
    default:
      return <ScrollText className="h-3.5 w-3.5 text-slate-400" />;
  }
}

function statusLabel(status: LogWatcherState['status']) {
  switch (status) {
    case 'watching':
      return 'Watching logs';
    case 'analyzing':
      return 'Analyzing…';
    case 'stopped':
      return 'Stopped';
    default:
      return 'Idle';
  }
}

export function LogWatcherPanel({ logWatcherState: sseProp }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [expandedFindingId, setExpandedFindingId] = useState<string | null>(null);
  const [polledState, setPolledState] = useState<LogWatcherState | null>(null);

  useEffect(() => {
    if (sseProp != null) return;

    let cancelled = false;

    const poll = async (): Promise<void> => {
      try {
        const data = await fetchLogWatcherStatus();
        if (!cancelled) {
          setPolledState(data.state);
        }
      } catch {
        // Ignore polling errors
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
  }, [sseProp]);

  const state = sseProp ?? polledState;
  if (!state || state.status === 'idle') return null;

  const sortedFindings = [...state.findings].sort(
    (a, b) => (severityOrder[a.severity] ?? 99) - (severityOrder[b.severity] ?? 99),
  );

  const hasCritical = sortedFindings.some((f) => f.severity === 'critical' || f.severity === 'high');

  return (
    <div className="rounded-lg border border-teal-200 bg-white shadow-sm dark:border-teal-800 dark:bg-slate-900">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        onClick={() => setExpanded((prev) => !prev)}
      >
        {statusIndicator(state.status)}
        <span className="text-xs font-semibold text-teal-700 dark:text-teal-300">
          Log Watcher
        </span>
        <span className="text-[10px] text-slate-500 dark:text-slate-400">
          {statusLabel(state.status)}
        </span>
        {state.findings.length > 0 && (
          <span className={`ml-1 rounded px-1.5 py-0.5 text-[10px] font-bold ${hasCritical ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' : 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300'}`}>
            {state.findings.length} {state.findings.length === 1 ? 'finding' : 'findings'}
          </span>
        )}
        {state.linesProcessed > 0 && (
          <span className="text-[10px] text-slate-400 dark:text-slate-500">
            · {state.linesProcessed.toLocaleString()} lines
          </span>
        )}
        <span className="ml-auto">
          {expanded ? <ChevronUp className="h-3.5 w-3.5 text-slate-400" /> : <ChevronDown className="h-3.5 w-3.5 text-slate-400" />}
        </span>
      </button>

      {expanded && sortedFindings.length > 0 && (
        <div className="border-t border-teal-100 px-3 pb-2 dark:border-teal-800">
          <div className="max-h-64 overflow-y-auto">
            {sortedFindings.map((finding) => (
              <LogFindingItem
                key={finding.id}
                finding={finding}
                isExpanded={expandedFindingId === finding.id}
                onToggle={() => setExpandedFindingId((prev) => (prev === finding.id ? null : finding.id))}
              />
            ))}
          </div>
        </div>
      )}

      {expanded && sortedFindings.length === 0 && state.status === 'watching' && (
        <div className="border-t border-teal-100 px-3 py-2 text-[11px] italic text-slate-400 dark:border-teal-800 dark:text-slate-500">
          No findings yet — watching backend logs for issues.
        </div>
      )}
    </div>
  );
}

function LogFindingItem({ finding, isExpanded, onToggle }: { finding: LogFinding; isExpanded: boolean; onToggle: () => void }) {
  return (
    <div className="mt-1.5 first:mt-2">
      <button
        type="button"
        className="flex w-full items-start gap-1.5 rounded px-1 py-1 text-left hover:bg-teal-50 dark:hover:bg-teal-900/20"
        onClick={onToggle}
      >
        <AlertTriangle className={`mt-0.5 h-3 w-3 shrink-0 ${finding.severity === 'critical' || finding.severity === 'high' ? 'text-red-500' : 'text-amber-500'}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <span className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide ${severityBadgeClass[finding.severity] ?? severityBadgeClass.medium}`}>
              {finding.severity}
            </span>
            <span className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide ${categoryBadgeClass[finding.category] ?? categoryBadgeClass['error-pattern']}`}>
              {finding.category}
            </span>
          </div>
          <div className="mt-0.5 text-xs font-medium text-slate-700 dark:text-slate-200">
            {finding.title}
          </div>
        </div>
        {isExpanded ? <ChevronUp className="mt-0.5 h-3 w-3 shrink-0 text-slate-400" /> : <ChevronDown className="mt-0.5 h-3 w-3 shrink-0 text-slate-400" />}
      </button>

      {isExpanded && (
        <div className="ml-5 mt-1 space-y-1.5 pb-1">
          <p className="text-[11px] text-slate-600 dark:text-slate-300">{finding.description}</p>
          {finding.logSnippet && (
            <div className="rounded bg-slate-900 px-2 py-1.5 dark:bg-slate-800">
              <div className="mb-0.5 text-[9px] font-bold uppercase tracking-wide text-slate-400">Log Snippet</div>
              <pre className="whitespace-pre-wrap text-[10px] font-mono text-green-400">{finding.logSnippet}</pre>
            </div>
          )}
          <div className="rounded bg-slate-50 px-2 py-1.5 dark:bg-slate-800">
                        <div className="mb-0.5 text-[9px] font-bold uppercase tracking-wide text-slate-400">Issue Summary</div>
            <p className="text-[11px] text-slate-700 dark:text-slate-200">{finding.issueSummary}</p>
          </div>
          <div className="rounded bg-slate-50 px-2 py-1.5 dark:bg-slate-800">
            <div className="mb-0.5 text-[9px] font-bold uppercase tracking-wide text-slate-400">Evidence</div>
            <p className="text-[11px] text-slate-700 dark:text-slate-200">{finding.evidence}</p>

          </div>
          {finding.relevantFiles && finding.relevantFiles.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {finding.relevantFiles.map((file) => (
                <span key={file} className="inline-flex items-center gap-0.5 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-mono text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  <FileCode className="h-2.5 w-2.5" />
                  {file}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
