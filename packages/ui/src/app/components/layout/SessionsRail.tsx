import { Loader2, Plus, RotateCcw, Trash2 } from 'lucide-react';
import type { WorkSession } from '../../../lib/api';
import { compactPromptDisplay } from '../../utils/text';
import { normalizeSessionStatus } from '../../utils/status';

export type SessionsRailProps = {
  sessions: WorkSession[];
  selectedSessionId: string;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onDeleteSession: (id: string) => Promise<void>;
  onRetrySession: (id: string) => Promise<void>;
};

function statusDot(status: string): string {
  switch (normalizeSessionStatus(status)) {
    case 'running': return 'bg-blue-500 animate-pulse';
    case 'completed': return 'bg-emerald-500';
    case 'failed': return 'bg-red-500';
    case 'cancelled': return 'bg-amber-500';
    default: return 'bg-slate-400';
  }
}

export function SessionsRail({
  sessions,
  selectedSessionId,
  onSelectSession,
  onNewSession,
  onDeleteSession,
  onRetrySession,
}: SessionsRailProps) {
  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-r border-slate-200/60 bg-white/50 dark:border-slate-800/60 dark:bg-slate-900/50">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-slate-500">Sessions</span>
        <button
          aria-label="New session"
          className="inline-flex h-6 w-6 items-center justify-center rounded bg-blue-600 text-white hover:bg-blue-500"
          onClick={onNewSession}
          title="New session"
          type="button"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {sessions.length === 0 && (
          <div className="px-2 py-4 text-center text-[11px] italic text-slate-400 dark:text-slate-500">No sessions</div>
        )}
        {sessions.map((session) => {
          const isSelected = selectedSessionId === session.id;
          const normStatus = normalizeSessionStatus(session.status);

          return (
            <div
              key={session.id}
              className={`group mb-0.5 flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                isSelected
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
              }`}
            >
              <button
                className="flex min-w-0 flex-1 items-center gap-2"
                onClick={() => onSelectSession(session.id)}
                type="button"
              >
                <span className="relative flex h-2.5 w-2.5 shrink-0">
                  <span className={`h-2.5 w-2.5 rounded-full ${statusDot(session.status)}`} />
                </span>
                {normStatus === 'running' && (
                  <Loader2 className={`h-3 w-3 shrink-0 animate-spin ${isSelected ? 'text-blue-100' : 'text-blue-500'}`} />
                )}
                <span className="min-w-0 flex-1 truncate text-xs font-medium">
                  {compactPromptDisplay(session.prompt)}
                </span>
              </button>

              <div className={`flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 ${isSelected ? 'opacity-100' : ''}`}>
                <button
                  aria-label="Retry"
                  className={`rounded p-0.5 ${isSelected ? 'hover:bg-blue-500' : 'hover:bg-slate-200 dark:hover:bg-slate-700'}`}
                  disabled={normStatus === 'running'}
                  onClick={(e) => { e.stopPropagation(); void onRetrySession(session.id); }}
                  title="Retry"
                  type="button"
                >
                  <RotateCcw className="h-3 w-3" />
                </button>
                <button
                  aria-label="Delete"
                  className={`rounded p-0.5 ${isSelected ? 'hover:bg-red-500' : 'hover:bg-red-100 hover:text-red-700 dark:hover:bg-red-900/40 dark:hover:text-red-300'}`}
                  onClick={(e) => { e.stopPropagation(); void onDeleteSession(session.id); }}
                  title="Delete"
                  type="button"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
