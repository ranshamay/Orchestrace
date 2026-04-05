import { Activity, Copy, Loader2, Moon, Plus, RotateCcw, Sun, Trash2 } from 'lucide-react';
import type { WorkSession } from '../../lib/api';
import type { FailureType, Tab, ThemeMode } from '../types';
import { compactPromptDisplay } from '../utils/text';
import { compactRunId } from '../utils/runUrl';
import { failureTypeBadgeClass, formatFailureTypeLabel, resolveSessionFailureType } from '../utils/failure';
import { formatSessionStatus, normalizeSessionStatus, sessionStatusBadgeClass } from '../utils/status';
import { llmPhaseBadgeClass, llmPhaseLabel, llmStatusBadgeClass, resolveLlmStatus } from '../utils/llm';

export type SessionSidebarProps = {
  activeTab: Tab;
  setActiveTab: (tab: Tab) => void;
  theme: ThemeMode;
  setTheme: (updater: (current: ThemeMode) => ThemeMode) => void;
  sessions: WorkSession[];
  selectedSessionId: string;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onDeleteSession: (id: string) => Promise<void>;
  onRetrySession: (id: string) => Promise<void>;
  onCopyTraceSession: (id: string) => Promise<void>;
  copyTraceState: { sessionId: string; state: 'idle' | 'copied' | 'failed' };
  sessionStatusSummary: { total: number; running: number; completed: number; failed: number; cancelled: number; overall: string };
  failureTypeSummary: Array<[FailureType, number]>;
};

export function SessionSidebar(props: SessionSidebarProps) {
  const {
    activeTab,
    setActiveTab,
    theme,
    setTheme,
    sessions,
    selectedSessionId,
    onSelectSession,
    onNewSession,
    onDeleteSession,
    onRetrySession,
    onCopyTraceSession,
    copyTraceState,
    sessionStatusSummary,
    failureTypeSummary,
  } = props;
  const isDark = theme === 'dark';

  return (
    <aside className="w-full border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 md:w-64 md:border-b-0 md:border-l">
      <div className="border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-blue-600" />
          <h1 className="text-lg font-bold tracking-tight">Orchestrace</h1>
          <button aria-label="Toggle theme" className="ml-auto inline-flex items-center justify-center rounded border border-slate-200 bg-white p-1.5 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700" onClick={() => setTheme((c) => (c === 'dark' ? 'light' : 'dark'))} type="button">
            {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
        </div>
      </div>

      <div className="max-h-56 overflow-y-auto p-3 md:max-h-none md:h-[calc(100vh-65px)] md:overflow-y-auto">
        <button className={`mb-1 w-full rounded-md px-3 py-2 text-left text-sm font-medium ${activeTab === 'graph' ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`} onClick={() => setActiveTab('graph')}>Graph & Flow</button>
        <button className={`mb-4 w-full rounded-md px-3 py-2 text-left text-sm font-medium ${activeTab === 'settings' ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`} onClick={() => setActiveTab('settings')}>Settings</button>

        <div className="mb-2 flex items-center justify-between border-t border-slate-100 pt-3 dark:border-slate-800">
          <div className="text-xs font-bold uppercase tracking-widest text-slate-400 dark:text-slate-500">Sessions</div>
          <button
            className="inline-flex items-center gap-1 rounded bg-blue-600 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-white hover:bg-blue-500"
            onClick={onNewSession}
            type="button"
          >
            <Plus className="h-3 w-3" />
            New
          </button>
        </div>
        <div className="mb-2 flex items-center justify-between px-1 text-[11px] text-slate-500 dark:text-slate-400"><span>Overall</span><span className="rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300">{sessionStatusSummary.overall}</span></div>

        {sessions.length > 0 && <div className="mb-2 px-1 text-[11px] text-slate-500 dark:text-slate-400">{sessionStatusSummary.running} running / {sessionStatusSummary.total} total</div>}
        {sessions.length > 0 && <div className="mb-2 flex flex-wrap gap-1 px-1"><span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">completed {sessionStatusSummary.completed}</span><span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">running {sessionStatusSummary.running}</span><span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] text-red-700 dark:bg-red-900/40 dark:text-red-300">failed {sessionStatusSummary.failed}</span><span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">cancelled {sessionStatusSummary.cancelled}</span></div>}

        {!selectedSessionId && sessions.length > 0 && (
          <div className="mb-2 rounded border border-blue-200 bg-blue-50 px-2 py-1 text-[10px] text-blue-700 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300">
            New session draft mode: compose and run to create another session.
          </div>
        )}

        {failureTypeSummary.length > 0 && <div className="mb-3 px-1"><div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">Failure Mix</div><div className="flex flex-wrap gap-1">{failureTypeSummary.map(([failureType, count]) => <span key={failureType} className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${failureTypeBadgeClass(failureType)}`}>{formatFailureTypeLabel(failureType)} {count}</span>)}</div></div>}
        {sessions.length === 0 && <div className="px-1 text-xs italic text-slate-400 dark:text-slate-500">No sessions</div>}

        {sessions.map((session) => {
          const isSelected = selectedSessionId === session.id;
          const llmStatus = resolveLlmStatus(session);
          const sessionFailureType = resolveSessionFailureType(session);
          const copyState = copyTraceState.sessionId === session.id ? copyTraceState.state : 'idle';
          return (
            <div key={session.id} className="mb-1 flex items-start gap-1">
              <button
                className={`w-full rounded px-2 py-1.5 text-left text-xs ${isSelected ? 'bg-blue-600 text-white' : 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`}
                onClick={() => onSelectSession(session.id)}
                type="button"
              >
                <div className="flex items-center gap-2">
                  {normalizeSessionStatus(session.status) === 'running' && <Loader2 className={`h-3.5 w-3.5 shrink-0 animate-spin ${isSelected ? 'text-blue-100' : 'text-blue-500 dark:text-blue-300'}`} />}
                  <span className="min-w-0 flex-1 truncate">{compactPromptDisplay(session.prompt)}</span>
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${sessionStatusBadgeClass(session.status, isSelected)}`}>{formatSessionStatus(session.status)}</span>
                </div>
                <div className={`mt-1 flex items-center justify-between gap-2 font-mono text-[10px] ${isSelected ? 'text-blue-100' : 'text-slate-500 dark:text-slate-400'}`}>
                  <span>run {compactRunId(session.id)}</span>
                  <div className="flex items-center gap-1">
                    {sessionFailureType && <span className={`rounded px-1.5 py-0.5 font-sans font-semibold uppercase tracking-wide ${failureTypeBadgeClass(sessionFailureType, isSelected)}`}>{formatFailureTypeLabel(sessionFailureType)}</span>}
                    {llmStatus.phase && <span className={`rounded px-1.5 py-0.5 font-sans font-semibold uppercase tracking-wide ${llmPhaseBadgeClass(llmStatus.phase, isSelected)}`}>{llmPhaseLabel(llmStatus.phase)}</span>}
                    <span className={`rounded px-1.5 py-0.5 font-sans font-semibold uppercase tracking-wide ${llmStatusBadgeClass(llmStatus, isSelected)}`}>{llmStatus.label}</span>
                  </div>
                </div>
                {llmStatus.detail && <div className={`mt-1 truncate text-[10px] ${isSelected ? 'text-blue-100/90' : 'text-slate-500 dark:text-slate-400'}`}>{llmStatus.detail}</div>}
              </button>
              <button
                aria-label={`Retry session ${compactRunId(session.id)}`}
                className="rounded p-1.5 text-slate-500 hover:bg-emerald-100 hover:text-emerald-700 disabled:cursor-not-allowed disabled:opacity-40 dark:text-slate-400 dark:hover:bg-emerald-900/40 dark:hover:text-emerald-300"
                disabled={normalizeSessionStatus(session.status) === 'running'}
                onClick={() => {
                  void onRetrySession(session.id);
                }}
                type="button"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
              <button
                aria-label={`Copy trace for session ${compactRunId(session.id)}`}
                className={`rounded p-1.5 text-slate-500 dark:text-slate-400 ${
                  copyState === 'copied'
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                    : copyState === 'failed'
                      ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                      : 'hover:bg-blue-100 hover:text-blue-700 dark:hover:bg-blue-900/40 dark:hover:text-blue-300'
                }`}
                onClick={() => {
                  void onCopyTraceSession(session.id);
                }}
                title={copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy trace'}
                type="button"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
              <button
                aria-label={`Delete session ${compactRunId(session.id)}`}
                className="rounded p-1.5 text-slate-500 hover:bg-red-100 hover:text-red-700 dark:text-slate-400 dark:hover:bg-red-900/40 dark:hover:text-red-300"
                onClick={() => {
                  void onDeleteSession(session.id);
                }}
                type="button"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}