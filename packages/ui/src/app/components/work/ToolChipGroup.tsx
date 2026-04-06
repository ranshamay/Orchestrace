import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { TimelineItem } from '../../types';
import { ToolChip } from './ToolChip';

type Props = {
  items: TimelineItem[];
  isDark: boolean;
};

export function ToolChipGroup({ items, isDark }: Props) {
  const hasErrors = items.some((item) => item.toolStatus === 'error');
  const [expanded, setExpanded] = useState(hasErrors);

  if (items.length === 1) {
    return <ToolChip item={items[0]} isDark={isDark} />;
  }

  const startTime = new Date(items[0].time).toLocaleTimeString([], { hour12: false });
  const lastItem = items[items.length - 1];
  const endTimeStr = lastItem.endTime ?? lastItem.time;
  const endTime = new Date(endTimeStr).toLocaleTimeString([], { hour12: false });

  const successCount = items.filter((i) => i.toolStatus === 'success').length;
  const errorCount = items.filter((i) => i.toolStatus === 'error').length;
  const pendingCount = items.filter((i) => i.toolStatus === 'pending').length;

  return (
    <div className="rounded border border-slate-200/60 dark:border-slate-700/40 bg-slate-50/50 dark:bg-slate-900/30">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-slate-100/60 dark:hover:bg-slate-800/30 rounded"
        onClick={() => setExpanded((prev) => !prev)}
      >
        <ChevronRight className={`h-3 w-3 flex-shrink-0 text-slate-400 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`} />
        <span className="text-[11px] font-medium text-slate-600 dark:text-slate-300">
          {items.length} tool calls
        </span>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {successCount > 0 && (
            <span className="flex items-center gap-0.5 text-[10px] text-emerald-600 dark:text-emerald-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 dark:bg-emerald-500" />
              {successCount}
            </span>
          )}
          {errorCount > 0 && (
            <span className="flex items-center gap-0.5 text-[10px] text-red-600 dark:text-red-400 ml-1">
              <span className="h-1.5 w-1.5 rounded-full bg-red-400 dark:bg-red-500" />
              {errorCount}
            </span>
          )}
          {pendingCount > 0 && (
            <span className="flex items-center gap-0.5 text-[10px] text-sky-600 dark:text-sky-400 ml-1">
              <span className="h-1.5 w-1.5 rounded-full bg-sky-400 dark:bg-sky-500 animate-pulse" />
              {pendingCount}
            </span>
          )}
        </div>
        <span className="flex-1" />
        <span className="text-[10px] text-slate-400 dark:text-slate-500 tabular-nums flex-shrink-0">
          {startTime === endTime ? startTime : `${startTime} – ${endTime}`}
        </span>
      </button>

      {expanded && (
        <div className="space-y-0.5 px-1.5 pb-1.5 border-t border-slate-200/40 dark:border-slate-700/30 pt-1">
          {items.map((item) => (
            <ToolChip key={item.key} item={item} isDark={isDark} />
          ))}
        </div>
      )}
    </div>
  );
}
