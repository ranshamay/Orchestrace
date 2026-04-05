import { useState } from 'react';
import { MessageSquare, X, Minimize2, Maximize2 } from 'lucide-react';

type Props = {
  children: React.ReactNode;
  hasSession: boolean;
};

export function FloatingChatOverlay({ children, hasSession }: Props) {
  const [isOpen, setIsOpen] = useState(true);
  const [isExpanded, setIsExpanded] = useState(false);

  if (!isOpen) {
    return (
      <button
        aria-label="Open chat"
        className="absolute bottom-4 right-4 z-30 flex h-10 w-10 items-center justify-center rounded-full bg-blue-600 text-white shadow-lg hover:bg-blue-500 transition-transform hover:scale-105"
        onClick={() => setIsOpen(true)}
        type="button"
      >
        <MessageSquare className="h-5 w-5" />
        {hasSession && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-blue-400 dark:border-slate-900" />}
      </button>
    );
  }

  return (
    <div
      className={`absolute bottom-3 right-3 z-30 flex flex-col overflow-hidden rounded-xl border border-slate-200/80 bg-white/95 shadow-2xl backdrop-blur-sm transition-all dark:border-slate-700/80 dark:bg-slate-900/95 ${
        isExpanded ? 'left-3 top-3' : 'h-[60vh] w-[380px] max-h-[700px]'
      }`}
    >
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-slate-200/60 bg-slate-50/80 px-2 dark:border-slate-800/60 dark:bg-slate-800/50">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
          <MessageSquare className="h-3 w-3" />
          Chat
        </div>
        <div className="flex items-center gap-0.5">
          <button
            aria-label={isExpanded ? 'Minimize' : 'Expand'}
            className="inline-flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-200 hover:text-slate-600 dark:hover:bg-slate-700 dark:hover:text-slate-300"
            onClick={() => setIsExpanded(!isExpanded)}
            type="button"
          >
            {isExpanded ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
          </button>
          <button
            aria-label="Close chat"
            className="inline-flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-200 hover:text-slate-600 dark:hover:bg-slate-700 dark:hover:text-slate-300"
            onClick={() => setIsOpen(false)}
            type="button"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {children}
      </div>
    </div>
  );
}
