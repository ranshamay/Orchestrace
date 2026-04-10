import { Eye, AlertTriangle, CheckCircle, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';
import type { SessionObserverFinding, SessionObserverState } from '../../../lib/api';

type Props = {
  observerState: SessionObserverState | null;
};

const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const severityBadgeClass: Record<string, string> = {
  critical: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  high: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  low: 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
};

const categoryBadgeClass: Record<string, string> = {
  'code-quality': 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  performance: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  'agent-efficiency': 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300',
  architecture: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
  'test-coverage': 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
};

function statusIndicator(status: SessionObserverState['status']) {
  switch (status) {
    case 'watching':
      return <Eye className="h-3.5 w-3.5 text-violet-500 animate-pulse" />;
    case 'analyzing':
      return <Loader2 className="h-3.5 w-3.5 text-violet-500 animate-spin" />;
    case 'done':
      return <CheckCircle className="h-3.5 w-3.5 text-emerald-500" />;
    default:
      return <Eye className="h-3.5 w-3.5 text-slate-400" />;
  }
}

function statusLabel(status: SessionObserverState['status']) {
  switch (status) {
    case 'watching':
      return 'Observing';
    case 'analyzing':
      return 'Analyzing…';
    case 'done':
      return 'Done';
    default:
      return 'Idle';
  }
}

export function ObserverPanel({ observerState }: Props) {
  const [expanded, setExpanded] = useState(true);
  const [expandedFindingId, setExpandedFindingId] = useState<string | null>(null);

  if (!observerState) return null;

  const sortedFindings = [...observerState.findings].sort(
    (a, b) => (severityOrder[a.severity] ?? 99) - (severityOrder[b.severity] ?? 99),
  );

  const hasCritical = sortedFindings.some((f) => f.severity === 'critical' || f.severity === 'high');

  return (
    <div className="rounded-lg border border-violet-200 bg-white shadow-sm dark:border-violet-800 dark:bg-slate-900">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        onClick={() => setExpanded((prev) => !prev)}
      >
        {statusIndicator(observerState.status)}
        <span className="text-xs font-semibold text-violet-700 dark:text-violet-300">
          Observer
        </span>
        <span className="text-[10px] text-slate-500 dark:text-slate-400">
          {statusLabel(observerState.status)}
        </span>
        {observerState.findings.length > 0 && (
          <span className={`ml-1 rounded px-1.5 py-0.5 text-[10px] font-bold ${hasCritical ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' : 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300'}`}>
            {observerState.findings.length} {observerState.findings.length === 1 ? 'finding' : 'findings'}
          </span>
        )}
        {observerState.analyzedSteps > 0 && (
          <span className="text-[10px] text-slate-400 dark:text-slate-500">
            · {observerState.analyzedSteps} {observerState.analyzedSteps === 1 ? 'analysis' : 'analyses'}
          </span>
        )}
        <span className="ml-auto">
          {expanded ? <ChevronUp className="h-3.5 w-3.5 text-slate-400" /> : <ChevronDown className="h-3.5 w-3.5 text-slate-400" />}
        </span>
      </button>

      {expanded && sortedFindings.length > 0 && (
        <div className="border-t border-violet-100 px-3 pb-2 dark:border-violet-800">
          <div className="max-h-64 overflow-y-auto">
            {sortedFindings.map((finding) => (
              <FindingItem
                key={finding.id}
                finding={finding}
                isExpanded={expandedFindingId === finding.id}
                onToggle={() => setExpandedFindingId((prev) => (prev === finding.id ? null : finding.id))}
              />
            ))}
          </div>
        </div>
      )}

      {expanded && sortedFindings.length === 0 && observerState.status !== 'idle' && (
        <div className="border-t border-violet-100 px-3 py-2 text-[11px] italic text-slate-400 dark:border-violet-800 dark:text-slate-500">
          No findings yet — observer is watching the session.
        </div>
      )}
    </div>
  );
}

function FindingItem({ finding, isExpanded, onToggle }: { finding: SessionObserverFinding; isExpanded: boolean; onToggle: () => void }) {
  return (
    <div className="mt-1.5 first:mt-2">
      <button
        type="button"
        className="flex w-full items-start gap-1.5 rounded px-1 py-1 text-left hover:bg-violet-50 dark:hover:bg-violet-900/20"
        onClick={onToggle}
      >
        <AlertTriangle className={`mt-0.5 h-3 w-3 shrink-0 ${finding.severity === 'critical' || finding.severity === 'high' ? 'text-red-500' : 'text-amber-500'}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <span className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide ${severityBadgeClass[finding.severity] ?? severityBadgeClass.medium}`}>
              {finding.severity}
            </span>
            <span className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide ${categoryBadgeClass[finding.category] ?? categoryBadgeClass['code-quality']}`}>
              {finding.category}
            </span>
            <span className="shrink-0 rounded px-1 py-0.5 text-[9px] text-slate-400 dark:text-slate-500">
              {finding.phase}
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
                    <div className="rounded bg-slate-50 px-2 py-1.5 dark:bg-slate-800">
            <div className="mb-0.5 text-[9px] font-bold uppercase tracking-wide text-slate-400">Suggested Fix</div>
            <p className="text-[11px] text-slate-700 dark:text-slate-200">
              {finding.evidence && finding.evidence.length > 0
                ? finding.evidence.map((entry) => entry.text).filter(Boolean).join('\n')
                : (finding.suggestedFix ?? '')}
            </p>
          </div>
          {finding.relevantFiles && finding.relevantFiles.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {finding.relevantFiles.map((file) => (
                <span key={file} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-mono text-slate-600 dark:bg-slate-800 dark:text-slate-300">
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
