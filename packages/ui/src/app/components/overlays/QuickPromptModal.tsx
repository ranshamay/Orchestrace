type QuickPromptModalProps = {
  isOpen: boolean;
  value: string;
  onChangeValue: (next: string) => void;
  onClose: () => void;
  onSubmit: () => void;
};

export function QuickPromptModal({ isOpen, value, onChangeValue, onClose, onSubmit }: QuickPromptModalProps) {
  if (!isOpen) {
    return null;
  }

  return (
    <div
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4"
      role="dialog"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="w-full max-w-2xl rounded-lg border border-slate-200 bg-white p-4 shadow-xl dark:border-slate-700 dark:bg-slate-900">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400">Start New Prompt</h2>
          <button
            className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            onClick={onClose}
            type="button"
          >
            Close
          </button>
        </div>

        <textarea
          autoFocus
          className="h-36 w-full resize-y rounded border border-slate-200 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          onChange={(event) => onChangeValue(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              onSubmit();
            }
          }}
          placeholder="Describe the task you want to start..."
          value={value}
        />

        <div className="mt-3 flex items-center justify-between">
          <p className="text-xs text-slate-500 dark:text-slate-400">Hotkeys: Cmd/Ctrl+K to open, Cmd/Ctrl+Enter to start</p>
          <button
            className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            disabled={value.trim().length === 0}
            onClick={onSubmit}
            type="button"
          >
            Start Prompt
          </button>
        </div>
      </div>
    </div>
  );
}