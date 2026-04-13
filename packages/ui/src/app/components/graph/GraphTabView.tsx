import type { AgentTodo, SessionObserverState, WorkSession } from '../../../lib/api';
import type { FailureType, LlmSessionStatus, NodeTokenStream } from '../../types';
import { EntityGraphCard } from './EntityGraphCard';
import { TodoChecklistCard } from './TodoChecklistCard';
import { CodeChangesCard } from './CodeChangesCard';
import { ObserverPanel } from '../observer/ObserverPanel';
import { LogWatcherPanel } from '../observer/LogWatcherPanel';
import { SessionSummaryCard } from '../work/SessionSummaryCard';

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
}: Props) {
  return (
    <div className="relative flex h-full flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto bg-slate-50 p-4 dark:bg-slate-950">
        {observerState && (
          <div className="mb-4">
            <ObserverPanel observerState={observerState} />
          </div>
        )}

        {selectedSession && (
          <div className="mb-4">
            <SessionSummaryCard
              selectedFailureType={selectedFailureType}
              selectedLlmStatus={selectedLlmStatus}
              selectedSession={selectedSession}
            />
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
        <CodeChangesCard
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