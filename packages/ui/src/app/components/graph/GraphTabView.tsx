import { useMemo } from 'react';
import type { AgentTodo, WorkSession } from '../../../lib/api';
import { ResizeHandle } from '../layout/ResizeHandle';
import { useHorizontalResize } from '../../hooks/useHorizontalResize';
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

const TIMELINE_DEFAULT_WIDTH = 420;
const TIMELINE_MIN_WIDTH = 320;
const TIMELINE_MAX_WIDTH = 720;

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
  const computedTimelineMax = useMemo(() => {
    if (typeof window === 'undefined') return TIMELINE_MAX_WIDTH;
    return Math.min(TIMELINE_MAX_WIDTH, Math.floor(window.innerWidth * 0.55));
  }, []);

  const timelineResize = useHorizontalResize({
    initialSize: TIMELINE_DEFAULT_WIDTH,
    minSize: TIMELINE_MIN_WIDTH,
    maxSize: computedTimelineMax,
    direction: 'normal',
  });

  const graphHint = useMemo(() => {
    if (!selectedSessionId) {
      return 'Center graph is the execution control plane. Configure LLM controls here, then start a new run from the composer.';
    }

    if (selectedSessionRunning) {
      return 'Center graph is the execution control plane. Follow active progress here and use the composer for follow-up chat on the selected run.';
    }

    return 'Center graph is the execution control plane. Review this run here, then use the composer to start a new run or continue this run.';
  }, [selectedSessionId, selectedSessionRunning]);

  return (
    <div className="flex h-full flex-col lg:flex-row">
      <aside
        className="flex w-full flex-col bg-white dark:bg-slate-900 lg:shrink-0 lg:w-[var(--timeline-panel-width)]"
        id="timeline-panel"
        style={{ '--timeline-panel-width': `${timelineResize.size}px` } as React.CSSProperties}
      >
        {rightPane}
      </aside>

      <ResizeHandle
        ariaLabel="Resize timeline panel"
        hiddenOnMobileClassName="hidden lg:block"
        id="timeline-panel"
        onKeyDown={timelineResize.handleKeyDown}
        onLostPointerCapture={timelineResize.handleLostPointerCapture}
        onPointerCancel={timelineResize.handlePointerCancel}
        onPointerDown={timelineResize.handlePointerDown}
        onPointerMove={timelineResize.handlePointerMove}
        onPointerUp={timelineResize.handlePointerUp}
        valueMax={timelineResize.maxSize}
        valueMin={timelineResize.minSize}
        valueNow={timelineResize.size}
      />

      <section className="flex min-w-0 flex-1 flex-col border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 lg:border-b-0 lg:border-l">
        <header className="border-b border-slate-200 p-4 dark:border-slate-800">
          <div className="flex items-start justify-between gap-3">
            <div className="text-xs text-slate-500 dark:text-slate-400">
              {graphHint}
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
    </div>
  );
}