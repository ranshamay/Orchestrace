import { useState } from 'react';
import type { ToolCallMessagePart } from '../../../chat-types';
import { resolveToolIcon, STATUS_ICON } from '../../../chat-types';

type Props = { part: ToolCallMessagePart };

export function ToolCallPart({ part }: Props) {
  const [expanded, setExpanded] = useState(false);

  const icon = resolveToolIcon(part.toolName);
  const statusIcon = STATUS_ICON[part.status] ?? '';
  const statusColor =
    part.status === 'success' ? 'text-emerald-600 dark:text-emerald-400' :
    part.status === 'error' ? 'text-red-500 dark:text-red-400' :
    'text-amber-500 dark:text-amber-400';

  return (
    <div>
      {/* Compact 1-line view */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-[11px] w-full text-left hover:bg-slate-50 dark:hover:bg-slate-800/50 rounded px-1 py-0.5 transition-colors"
      >
        <span>{icon}</span>
        <span className="font-medium text-slate-700 dark:text-slate-300 truncate max-w-[120px]">{part.toolName}</span>
        <span className="text-slate-400 dark:text-slate-500 truncate flex-1">{part.inputSummary}</span>
        <span className={statusColor}>
          {part.status === 'calling' ? (
            <span className="animate-pulse">{statusIcon}</span>
          ) : (
            statusIcon
          )}
        </span>
        {part.outputSummary && part.status !== 'calling' && (
          <span className="text-slate-400 dark:text-slate-500 truncate max-w-[100px]">{part.outputSummary}</span>
        )}
      </button>

      {/* Expanded JSON view */}
      {expanded && (
        <div className="pl-5 mt-0.5 space-y-1">
          {part.input != null && (
            <div>
              <div className="text-[9px] font-semibold uppercase text-slate-400 dark:text-slate-500">Input</div>
              <pre className="text-[10px] text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/50 rounded p-1.5 overflow-x-auto max-h-32 whitespace-pre-wrap">
                {typeof part.input === 'string' ? part.input : JSON.stringify(part.input, null, 2)}
              </pre>
            </div>
          )}
          {part.output != null && (
            <div>
              <div className="text-[9px] font-semibold uppercase text-slate-400 dark:text-slate-500">Output</div>
              <pre className="text-[10px] text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/50 rounded p-1.5 overflow-x-auto max-h-32 whitespace-pre-wrap">
                {typeof part.output === 'string' ? part.output : JSON.stringify(part.output, null, 2)}
              </pre>
            </div>
          )}
          {part.error && (
            <div className="text-[10px] text-red-600 dark:text-red-400">{part.error}</div>
          )}
        </div>
      )}
    </div>
  );
}
