import type { AgentTodo, SessionObserverState, WorkSession, Workspace } from '../../../lib/api';
import type { FailureType, LlmSessionStatus, NodeTokenStream, ComposerMode } from '../../types';
import { composerModeBadgeClass, composerModeDescription } from '../../utils/composer';
import { EntityGraphCard } from './EntityGraphCard';
import { TodoChecklistCard } from './TodoChecklistCard';
import { ObserverPanel } from '../observer/ObserverPanel';
import { LogWatcherPanel } from '../observer/LogWatcherPanel';

type Props = {
  selectedSession?: WorkSession;
  selectedSessionRunning: boolean;
  selectedFailureType: FailureType | null;
  selectedLlmStatus: LlmSessionStatus;
  nodeTokenStreams: Record<string, NodeTokenStream>;
  isDark: boolean;
  selectedSessionId: string;
  todos: AgentTodo[];
  todoInput: string;
  setTodoInput: (value: string) => void;
  onAddTodo: () => Promise<void>;
  onToggleTodo: (todo: AgentTodo) => Promise<void>;
  chatOverlay: React.ReactNode;
  observerState: SessionObserverState | null;
  workspaces: Workspace[];
  workWorkspaceId: string;
  workProvider: string;
  workModel: string;
  autoApprove: boolean;
  composerMode: ComposerMode;
};

export function GraphTabView({
  selectedSession,
  selectedSessionRunning,
  selectedFailureType,
  selectedLlmStatus,
  nodeTokenStreams,
  isDark,
  selectedSessionId,
  todos,
  todoInput,
  setTodoInput,
  onAddTodo,
  onToggleTodo,
  chatOverlay,
  observerState,
  workspaces,
  workWorkspaceId,
  workProvider,
  workModel,
  autoApprove,
  composerMode,
}: Props) {
  return (
    <div className="relative flex h-full flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto bg-slate-50 p-4 dark:bg-slate-950">
        <div className="mb-4 flex flex-col gap-2">
          <div className="mb-2 grid grid-cols-2 gap-2 rounded border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
            <div className="truncate">Workspace: <span className="font-mono">{workspaces.find((workspace) => workspace.id === workWorkspaceId)?.name ?? 'none'}</span></div>
            <div className="truncate">Provider: <span className="font-mono">{workProvider || 'none'}</span></div>
            <div className="truncate">Model: <span className="font-mono">{workModel || 'none'}</span></div>
            <div>Auto-approve: <span className="font-mono">{autoApprove ? 'on' : 'off'}</span></div>
          </div>
          <div className="mb-2 flex items-center justify-between rounded border border-slate-200 bg-white px-3 py-2 text-xs dark:border-slate-800 dark:bg-slate-900">
            <div className="text-slate-600 dark:text-slate-300">Composer mode: <span className={`rounded ml-2 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${composerModeBadgeClass(composerMode)}`}>{composerMode}</span></div>
            <div className="text-[10px] text-slate-500 dark:text-slate-400">{composerModeDescription(composerMode)}</div>
          </div>
        </div>
        {observerState && (
          <div className="mb-4">
            <ObserverPanel observerState={observerState} />
          </div>
        )}
        <div className="mb-4">
          <LogWatcherPanel />
        </div>
        <EntityGraphCard
          isDark={isDark}
          selectedFailureType={selectedFailureType}
          selectedLlmStatus={selectedLlmStatus}
          nodeTokenStreams={nodeTokenStreams}
          selectedSession={selectedSession}
          selectedSessionRunning={selectedSessionRunning}
        />
        {selectedSession && (
          <div className="mt-4">
            <TodoChecklistCard
              onAddTodo={onAddTodo}
              onToggleTodo={onToggleTodo}
              selectedSessionId={selectedSessionId}
              setTodoInput={setTodoInput}
              todoInput={todoInput}
              todos={todos}
            />
          </div>
        )}
      </div>
      {chatOverlay}
    </div>
  );
}