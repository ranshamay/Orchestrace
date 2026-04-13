import { useState } from 'react';
import type { ReasoningMessagePart } from '../../../chat-types';

type Props = { part: ReasoningMessagePart };

export function ReasoningPart({ part }: Props) {
  const [expanded, setExpanded] = useState(part.isStreaming);

  // Auto-expand while streaming, collapse after
  if (part.isStreaming && !expanded) {
    // Will re-render when streaming ends
  }

  const charCount = part.text.length;
  const label = part.isStreaming ? 'Thinking…' : `(${charCount.toLocaleString()} chars)`;

  if (!expanded && !part.isStreaming) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300 transition-colors"
      >
        <span>🧠</span>
        <span>{label}</span>
      </button>
    );
  }

  return (
    <div className="relative">
      <button
        onClick={() => { if (!part.isStreaming) setExpanded(false); }}
        className="flex items-center gap-1 text-[11px] text-slate-400 dark:text-slate-500 mb-0.5"
      >
        <span>🧠</span>
        <span>{part.isStreaming ? 'Thinking…' : `(${charCount.toLocaleString()} chars) ▾`}</span>
      </button>
      <div className="pl-5 text-[11px] italic text-slate-500 dark:text-slate-400 leading-relaxed whitespace-pre-wrap max-h-40 overflow-y-auto font-mono">
        {part.text}
        {part.isStreaming && <span className="animate-pulse">█</span>}
      </div>
    </div>
  );
}
