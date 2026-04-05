import { MessageSquare, Wrench } from 'lucide-react';
import type { WorkSession } from '../../../lib/api';
import type { FailureType, LlmSessionStatus, TimelineItem } from '../../types';
import { Loader2 } from 'lucide-react';
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
};

export function TimelinePanel(props: Props) {
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
  } = props;

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400">
            <span>LLM Work</span>
            {selectedSessionRunning && <span className="inline-flex items-center gap-1 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold normal-case tracking-normal text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"><Loader2 className="h-3 w-3 animate-spin" />In progress</span>}
          </div>
          <div className="flex items-center gap-1.5">
            <button aria-label="Toggle tool list" className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-[10px] disabled:opacity-50 ${showToolsPanel ? 'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-300' : 'border-slate-200 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200'}`} disabled={!selectedSessionId} onClick={() => { setShowToolsPanel((current) => !current); }} title="Show currently available tools" type="button"><Wrench className="h-3 w-3" />Tools</button>
          </div>
        </div>

        {showToolsPanel && <ToolsPanel availableTools={availableTools} isToolsLoading={isToolsLoading} selectedSessionMode={selectedSession?.mode} toolsLoadError={toolsLoadError} toolsMode={toolsMode} />}
        <SessionSummaryCard selectedFailureType={selectedFailureType} selectedLlmStatus={selectedLlmStatus} selectedSession={selectedSession} />
      </header>

      <div className="flex items-center justify-between px-4 pt-3 text-[11px] font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400">
        <div className="flex items-center gap-1.5"><MessageSquare className="h-4 w-4" />Chat Timeline</div>
        {!followTimelineTail && (
          <button className="rounded border border-slate-200 bg-white px-2 py-1 text-[10px] font-medium normal-case tracking-normal text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300" onClick={jumpToLatest} type="button">Jump to latest</button>
        )}
      </div>
      <div ref={timelineContainerRef} className="min-h-0 flex-1 space-y-2 overflow-auto bg-slate-50 p-4 pt-2 dark:bg-slate-950" onScroll={onTimelineScroll}>
        <TimelineList isDark={isDark} timelineItems={timelineItems} />
      </div>

      {composer}
    </section>
  );
}