import { useEffect, useRef } from 'react';

type QuickPromptModalProps = {
  isOpen: boolean;
  value: string;
  isSubmitting: boolean;
  onChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
};

export function QuickPromptModal({
  isOpen,
  value,
  isSubmitting,
  onChange,
  onClose,
  onSubmit,
}: QuickPromptModalProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const timer = window.setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(value.length, value.length);
    }, 0);

    return () => {
      window.clearTimeout(timer);
    };
  }, [isOpen, value.length]);

  if (!isOpen) {
    return null;
  }

  const trimmedValue = value.trim();

  return (
    <div
      aria-modal="true"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/50 p-4"
      role="dialog"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-lg border border-slate-200 bg-white p-4 shadow-2xl dark:border-slate-700 dark:bg-slate-900"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">Start new prompt</h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Runs a new session from anywhere. Shortcut: Cmd/Ctrl + K</p>
        </div>

        <textarea
          ref={textareaRef}
          className="h-36 w-full resize-y rounded border border-slate-200 px-3 py-2 text-sm outline-none ring-blue-500 focus:ring-2 dark:border-slate-700 dark:bg-slate-950"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
              return;
            }

            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              onSubmit();
            }
          }}
          placeholder="Describe the task and start autonomous execution..."
          value={value}
        />

        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            className="rounded border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
          <button
            className="rounded bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
            disabled={trimmedValue.length === 0 || isSubmitting}
            onClick={onSubmit}
            type="button"
          >
            {isSubmitting ? 'Starting…' : 'Start'}
          </button>
        </div>
      </div>
    </div>
  );
}