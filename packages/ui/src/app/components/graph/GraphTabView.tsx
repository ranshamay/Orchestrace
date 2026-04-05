import { useMemo, useRef, useState, type CSSProperties } from 'react';
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
  rightPaneWidthPx: number;
  onSetRightPaneWidthPx: (next: number) => void;
};

const RIGHT_PANE_MIN_WIDTH = 320;
const CENTER_MIN_WIDTH = 500;
const RESIZER_WIDTH = 10;
const RIGHT_PANE_DEFAULT_WIDTH = 420;

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
  rightPaneWidthPx,
  onSetRightPaneWidthPx,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isDraggingPane, setIsDraggingPane] = useState(false);

  const rightPaneStyle = useMemo(
    () => ({ '--graph-right-pane-width': `${rightPaneWidthPx}px` }) as CSSProperties & Record<'--graph-right-pane-width', string>,
    [rightPaneWidthPx],
  );

  return (
    <div
      ref={containerRef}
      className="flex h-full flex-col lg:flex-row"
      style={rightPaneStyle}
    >
      <aside className="flex w-full flex-col bg-white dark:bg-slate-900 lg:w-[var(--graph-right-pane-width)]">{rightPane}</aside>

      <button
        aria-label="Resize chat and timeline panel"
        className={`relative hidden shrink-0 touch-none cursor-col-resize border-l border-slate-200 bg-white/70 dark:border-slate-700 dark:bg-slate-900/70 lg:block ${isDraggingPane ? 'w-2 bg-blue-200/70 dark:bg-blue-700/50' : 'w-px hover:w-2 hover:bg-blue-100/80 dark:hover:bg-blue-900/40'}`}
        onDoubleClick={() => onSetRightPaneWidthPx(RIGHT_PANE_DEFAULT_WIDTH)}
        onPointerDown={(event) => {
          if (!containerRef.current) {
            return;
          }
          event.preventDefault();
          const pointerId = event.pointerId;
          const startX = event.clientX;
          const startWidth = rightPaneWidthPx;
          const containerWidth = containerRef.current.getBoundingClientRect().width;
          const maxWidth = Math.max(RIGHT_PANE_MIN_WIDTH, containerWidth - CENTER_MIN_WIDTH - RESIZER_WIDTH);
          const handle = event.currentTarget;
          setIsDraggingPane(true);
          document.body.style.userSelect = 'none';
          document.body.style.cursor = 'col-resize';
          handle.setPointerCapture(pointerId);

          const applyWidth = (next: number) => {
            const clamped = Math.min(maxWidth, Math.max(RIGHT_PANE_MIN_WIDTH, next));
            onSetRightPaneWidthPx(clamped);
          };

          const onPointerMove = (moveEvent: PointerEvent) => {
            const deltaX = moveEvent.clientX - startX;
            applyWidth(startWidth - deltaX);
          };

          const cleanup = () => {
            setIsDraggingPane(false);
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
            handle.removeEventListener('pointermove', onPointerMove);
            handle.removeEventListener('pointerup', onPointerUp);
            handle.removeEventListener('pointercancel', onPointerUp);
            try {
              handle.releasePointerCapture(pointerId);
            } catch {
              // pointer capture might already be released
            }
          };

          const onPointerUp = () => {
            cleanup();
          };

          handle.addEventListener('pointermove', onPointerMove);
          handle.addEventListener('pointerup', onPointerUp);
          handle.addEventListener('pointercancel', onPointerUp);
        }}
        type="button"
      />

      <section className="flex min-w-0 flex-1 flex-col border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 lg:border-b-0 lg:border-l">
        <header className="border-b border-slate-200 p-4 dark:border-slate-800">
          <div className="flex items-start justify-between gap-3">
            <div className="text-xs text-slate-500 dark:text-slate-400">
              Center graph is the execution control plane. Edit LLM controls here, then use the left panel composer to start a run or chat with the selected run.
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