import { useEffect, useRef } from "react";

export type NewPromptModalProps = {
  isOpen: boolean;
  prompt: string;
  isSubmitting: boolean;
  canStart: boolean;
  onPromptChange: (value: string) => void;
  onClose: () => void;
  onStart: () => void;
};

export function NewPromptModal(props: NewPromptModalProps) {
  const {
    isOpen,
    prompt,
    isSubmitting,
    canStart,
    onPromptChange,
    onClose,
    onStart,
  } = props;

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    textareaRef.current?.focus();
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  return (
    <div
      aria-modal="true"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/50 p-4"
      role="dialog"
      onClick={(event) => {
        if (event.target === event.currentTarget && !isSubmitting) {
          onClose();
        }
      }}
    >
      <div className="w-full max-w-2xl rounded-lg border border-slate-200 bg-white p-4 shadow-xl dark:border-slate-700 dark:bg-slate-900">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400">
            Start New Prompt
          </h2>
          <button
            className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            disabled={isSubmitting}
            onClick={onClose}
            type="button"
          >
            Close
          </button>
        </div>

        <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
          Hotkey: <span className="font-mono">Ctrl/Cmd + Shift + N</span>
        </p>

        <textarea
          ref={textareaRef}
          className="h-36 w-full resize-none rounded border border-slate-200 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              if (!isSubmitting) {
                onClose();
              }
            }

            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              if (canStart && !isSubmitting) {
                onStart();
              }
            }
          }}
          placeholder="Describe the task to start a brand-new run..."
          value={prompt}
        />

        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            className="rounded border border-slate-200 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            disabled={isSubmitting}
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
          <button
            className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
            disabled={!canStart || isSubmitting}
            onClick={onStart}
            type="button"
          >
            {isSubmitting ? "Starting…" : "Start run"}
          </button>
        </div>
      </div>
    </div>
  );
}
