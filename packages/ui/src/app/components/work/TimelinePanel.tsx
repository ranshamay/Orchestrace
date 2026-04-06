import { Copy, Wrench } from 'lucide-react';
import type { WorkSession } from '../../../lib/api';
import type { FailureType, LlmSessionStatus, TimelineItem } from '../../types';
import { Loader2 } from 'lucide-react';
import { useRef, type MouseEvent } from 'react';
import { SessionSummaryCard } from './SessionSummaryCard';
import { ToolsPanel } from './ToolsPanel';
import { TimelineList } from './TimelineList';

type Props = {
  selectedSessionId: string;
  selectedSession?: WorkSession;
  selectedSessionRunning: boolean;
  selectedFailureType: FailureType | null;
  selectedLlmStatus: LlmSessionStatus;
  showToolsPanel: boolean;
  setShowToolsPanel: (next: boolean | ((current: boolean) => boolean)) => void;
  toolsMode: '' | 'chat' | 'planning' | 'implementation';
  availableTools: Array<{ name: string; description: string }>;
  isToolsLoading: boolean;
  toolsLoadError: string;
  timelineContainerRef: React.RefObject<HTMLDivElement | null>;
  followTimelineTail: boolean;
  jumpToLatest: () => void;
  onTimelineScroll: () => void;
  timelineItems: TimelineItem[];
  composer: React.ReactNode;
  isDark: boolean;
  copyTraceState: 'idle' | 'copied' | 'failed';
  onCopyTrace: () => void;
};

export function TimelinePanel(props: Props) {
  const lastToolsToggleAtRef = useRef(0);

  const {
    selectedSessionId,
    selectedSession,
    selectedSessionRunning,
    selectedFailureType,
    selectedLlmStatus,
    showToolsPanel,
    setShowToolsPanel,
    toolsMode,
    availableTools,
    isToolsLoading,
    toolsLoadError,
    timelineContainerRef,
    followTimelineTail,
    jumpToLatest,
    onTimelineScroll,
    timelineItems,
    composer,
    isDark,
    copyTraceState,
    onCopyTrace,
  } = props;

  const handleToggleTools = (event: MouseEvent<HTMLButtonElement>) => {
    if (event.detail > 1) {
      return;
    }

    const now = Date.now();
    if (now - lastToolsToggleAtRef.current < 500) {
      return;
    }

    lastToolsToggleAtRef.current = now;
    setShowToolsPanel((current) => !current);
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-slate-200/60 bg-white/80 px-3 py-2 dark:border-slate-800/60 dark:bg-slate-900/80">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
            {selectedSessionRunning && <Loader2 className="h-3 w-3 animate-spin text-blue-500" />}
            <span>{selectedSessionRunning ? 'Working' : selectedSessionId ? 'Session' : 'Ready'}</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              className={`inline-flex h-6 w-6 items-center justify-center rounded text-[10px] disabled:opacity-40 ${
                copyTraceState === 'copied'
                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                  : 'text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'
              }`}
              disabled={!selectedSessionId}
              onClick={onCopyTrace}
              title={copyTraceState === 'copied' ? 'Copied' : 'Copy trace'}
              type="button"
            >
              <Copy className="h-3 w-3" />
            </button>
            <button
              aria-label="Toggle tools"
              className={`inline-flex h-6 w-6 items-center justify-center rounded disabled:opacity-40 ${showToolsPanel ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300' : 'text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'}`}
              disabled={!selectedSessionId}
              onClick={handleToggleTools}
              title="Tools"
              type="button"
            >
              <Wrench className="h-3 w-3" />
            </button>
          </div>
        </div>

        {showToolsPanel && <ToolsPanel availableTools={availableTools} isToolsLoading={isToolsLoading} selectedSessionMode={selectedSession?.mode} toolsLoadError={toolsLoadError} toolsMode={toolsMode} />}
        <SessionSummaryCard selectedFailureType={selectedFailureType} selectedLlmStatus={selectedLlmStatus} selectedSession={selectedSession} />
      </header>

      <div ref={timelineContainerRef} className="min-h-0 flex-1 space-y-1.5 overflow-auto bg-slate-50/50 p-3 dark:bg-slate-950/50" onScroll={onTimelineScroll}>
        {!followTimelineTail && (
          <button className="sticky top-0 z-10 mx-auto block rounded-full border border-slate-200 bg-white px-3 py-0.5 text-[10px] font-medium text-slate-600 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300" onClick={jumpToLatest} type="button">↓ Latest</button>
        )}
        <TimelineList isDark={isDark} timelineItems={timelineItems} />
      </div>

      {composer}
    </section>
  );
}