import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { TimelineItem } from '../../types';
import { getToolIcon, getToolDisplayName } from '../../utils/toolIcons';
import { formatToolPayloadForDisplay } from '../../utils/timeline';

type Props = {
  item: TimelineItem;
  isDark: boolean;
  defaultExpanded?: boolean;
};

export function ToolChip({ item, isDark, defaultExpanded }: Props) {
  void isDark;
  const [expanded, setExpanded] = useState(defaultExpanded ?? item.toolStatus === 'error');
  const Icon = getToolIcon(item.toolName ?? '');
  const displayName = getToolDisplayName(item.toolName ?? '');
  const summary = item.inputSummary ?? item.outputSummary ?? `Calling ${item.toolName}`;

  const statusColor =
    item.toolStatus === 'error'
      ? 'bg-red-400 dark:bg-red-500'
      : item.toolStatus === 'success'
        ? 'bg-emerald-400 dark:bg-emerald-500'
        : '';

  const borderColor =
    item.toolStatus === 'error'
      ? 'border-l-red-400 dark:border-l-red-500'
      : 'border-l-sky-300 dark:border-l-sky-600';

  const time = new Date(item.time).toLocaleTimeString([], { hour12: false });

  return (
    <div className={`rounded border-l-2 ${borderColor} ${item.toolStatus === 'error' ? 'bg-red-50/60 dark:bg-red-950/20' : 'bg-slate-50/80 dark:bg-slate-900/50'}`}>
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-slate-100/80 dark:hover:bg-slate-800/40 rounded"
        onClick={() => setExpanded((prev) => !prev)}
      >
        <Icon className={`h-3.5 w-3.5 flex-shrink-0 ${item.toolStatus === 'error' ? 'text-red-500 dark:text-red-400' : 'text-sky-500 dark:text-sky-400'}`} />
        <span className="font-mono text-[11px] font-medium text-slate-700 dark:text-slate-200 flex-shrink-0">
          {displayName}
        </span>
        <span className="truncate text-[11px] text-slate-500 dark:text-slate-400 flex-1 min-w-0">
          {summary}
        </span>
        {item.toolStatus === 'pending' && (
          <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin text-sky-500" />
        )}
        {item.toolStatus !== 'pending' && (
          <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${statusColor}`} />
        )}
        <span className="text-[10px] text-slate-400 dark:text-slate-500 flex-shrink-0 tabular-nums">
          {time}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-slate-200/60 dark:border-slate-700/60 px-3 py-2 space-y-2">
          {item.inputPayload != null && (
            <PayloadBlock label="Input" payload={item.inputPayload} toolName={item.toolName ?? ''} />
          )}
          {item.outputPayload != null && (
            <PayloadBlock
              label={item.toolStatus === 'error' ? 'Error' : 'Output'}
              payload={item.outputPayload}
              toolName={item.toolName ?? ''}
              isError={item.toolStatus === 'error'}
            />
          )}
          {item.toolStatus === 'pending' && !item.outputPayload && (
            <div className="text-[11px] italic text-slate-400 dark:text-slate-500">Waiting for result...</div>
          )}
        </div>
      )}
    </div>
  );
}

function PayloadBlock({ label, payload, toolName, isError }: { label: string; payload: string; toolName: string; isError?: boolean }) {
  const limit = toolName.startsWith('subagent_') ? 16_000 : 6000;
  const formatted = formatToolPayloadForDisplay(payload, limit);

  return (
    <div>
      <div className={`text-[10px] font-semibold uppercase tracking-wide mb-0.5 ${isError ? 'text-red-500 dark:text-red-400' : 'text-slate-400 dark:text-slate-500'}`}>
        {label}
      </div>
      <pre className={`overflow-auto rounded bg-slate-100 dark:bg-slate-800/80 px-2 py-1.5 text-[11px] leading-relaxed max-h-48 ${isError ? 'text-red-700 dark:text-red-300' : 'text-slate-700 dark:text-slate-300'}`}>
        {formatted}
      </pre>
    </div>
  );
}
