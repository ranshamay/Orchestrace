import { useEffect, useRef } from "react";

type NewPromptModalProps = {
  isOpen: boolean;
  prompt: string;
  onChangePrompt: (next: string) => void;
  onClose: () => void;
  onSubmit: () => void;
};

export function NewPromptModal({
  isOpen,
  prompt,
  onChangePrompt,
  onClose,
  onSubmit,
}: NewPromptModalProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const timeout = window.setTimeout(() => {
      textareaRef.current?.focus();
    }, 0);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || typeof window === "undefined") {
      return;
    }

    const onEsc = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("keydown", onEsc);
    };
  }, [isOpen, onClose]);

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
      <form
        className="w-full max-w-2xl rounded-lg border border-slate-200 bg-white p-4 shadow-xl dark:border-slate-700 dark:bg-slate-900"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400">
            Start New Prompt
          </h2>
          <button
            className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            onClick={onClose}
            type="button"
          >
            Close
          </button>
        </div>

        <textarea
          ref={textareaRef}
          className="h-36 w-full resize-y rounded border border-slate-200 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          onChange={(event) => onChangePrompt(event.target.value)}
          placeholder="Describe the task you want to run..."
          value={prompt}
        />
        <div className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
          Press <span className="font-mono">⌘/Ctrl + K</span> from anywhere to
          open this modal.
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            className="rounded border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
          <button
            className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            disabled={!prompt.trim()}
            type="submit"
          >
            Start
          </button>
        </div>
      </form>
    </div>
  );
}
