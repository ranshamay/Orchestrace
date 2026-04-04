import type { AgentTodo, WorkSession } from '../../../lib/api';
import type { FailureType, LlmSessionStatus } from '../../types';
import { EntityGraphCard } from './EntityGraphCard';
import { TodoChecklistCard } from './TodoChecklistCard';

type Props = {
  selectedSession?: WorkSession;
  selectedSessionRunning: boolean;
  selectedFailureType: FailureType | null;
  selectedLlmStatus: LlmSessionStatus;
  isDark: boolean;
  selectedSessionId: string;
  todos: AgentTodo[];
  todoInput: string;
  setTodoInput: (value: string) => void;
  onAddTodo: () => Promise<void>;
  onToggleTodo: (todo: AgentTodo) => Promise<void>;
  onOpenLlmControls: () => void;
  rightPane: React.ReactNode;
};

export function GraphTabView({
  selectedSession,
  selectedSessionRunning,
  selectedFailureType,
  selectedLlmStatus,
  isDark,
  selectedSessionId,
  todos,
  todoInput,
  setTodoInput,
  onAddTodo,
  onToggleTodo,
  onOpenLlmControls,
  rightPane,
}: Props) {
  return (
    <div className="flex h-full flex-col lg:flex-row">
      <section className="flex min-w-0 flex-1 flex-col border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 lg:border-b-0 lg:border-r">
        <header className="border-b border-slate-200 p-4 dark:border-slate-800">
          <div className="flex items-start justify-between gap-3">
            <div className="text-xs text-slate-500 dark:text-slate-400">
              Center graph is the execution control plane. Edit LLM controls here, then use the right panel composer to start a run or chat with the selected run.
            </div>
            <button
              className="shrink-0 rounded border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
              onClick={onOpenLlmControls}
              type="button"
            >
              LLM Controls
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-auto bg-slate-50 p-4 dark:bg-slate-950">
          <div className="space-y-4">
            <EntityGraphCard
              isDark={isDark}
              selectedFailureType={selectedFailureType}
              selectedLlmStatus={selectedLlmStatus}
              selectedSession={selectedSession}
              selectedSessionRunning={selectedSessionRunning}
            />
            {selectedSession && (
              <TodoChecklistCard
                onAddTodo={onAddTodo}
                onToggleTodo={onToggleTodo}
                selectedSessionId={selectedSessionId}
                setTodoInput={setTodoInput}
                todoInput={todoInput}
                todos={todos}
              />
            )}
          </div>
        </div>
      </section>

      <aside className="flex w-full flex-col bg-white dark:bg-slate-900 lg:w-[420px]">{rightPane}</aside>
    </div>
  );
}