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
  chatOverlay: React.ReactNode;
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
  chatOverlay,
}: Props) {
  return (
    <div className="relative flex h-full flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto bg-slate-50 p-4 dark:bg-slate-950">
        <EntityGraphCard
          isDark={isDark}
          selectedFailureType={selectedFailureType}
          selectedLlmStatus={selectedLlmStatus}
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