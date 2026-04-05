import { CheckCircle2 } from 'lucide-react';
import type { AgentTodo } from '../../../lib/api';

type Props = {
  selectedSessionId: string;
  todos: AgentTodo[];
  todoInput: string;
  setTodoInput: (value: string) => void;
  onAddTodo: () => Promise<void>;
  onToggleTodo: (todo: AgentTodo) => Promise<void>;
};

export function TodoChecklistCard({ selectedSessionId, todos, todoInput, setTodoInput, onAddTodo, onToggleTodo }: Props) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <header className="border-b border-slate-200 px-4 py-3 text-xs font-bold uppercase tracking-widest text-slate-500 dark:border-slate-800 dark:text-slate-400">
        Todo Checklist
      </header>
      <div className="flex gap-2 border-b border-slate-100 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950">
        <input
          className="flex-1 rounded border border-slate-200 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
          disabled={!selectedSessionId}
          onChange={(event) => setTodoInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              void onAddTodo();
            }
          }}
          placeholder="Add todo item..."
          value={todoInput}
        />
        <button
          className="rounded border border-slate-200 bg-white px-3 text-sm disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900"
          disabled={!selectedSessionId || !todoInput.trim()}
          onClick={() => {
            void onAddTodo();
          }}
        >
          Add
        </button>
      </div>
      <div className="max-h-72 space-y-1 overflow-auto p-4">
        {todos.length === 0 && <div className="text-center text-xs italic text-slate-400 dark:text-slate-500">No todos yet.</div>}
        {todos.map((todo) => (
          <button
            key={todo.id}
            className="flex w-full items-center gap-2 rounded border border-slate-100 bg-white p-2 text-left text-sm dark:border-slate-700 dark:bg-slate-900"
            onClick={() => {
              void onToggleTodo(todo);
            }}
          >
            <CheckCircle2 className={`h-4 w-4 ${todo.done ? 'text-emerald-500' : 'text-slate-300'}`} />
            <span className={todo.done ? 'line-through text-slate-400 dark:text-slate-500' : 'text-slate-700 dark:text-slate-200'}>{todo.text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}