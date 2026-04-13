import { useCallback, useEffect, useRef, useState } from 'react';

type NewPromptModalProps = {
  isOpen: boolean;
  isSubmitting: boolean;
  onClose: () => void;
  onSubmit: (prompt: string) => Promise<void>;
};

export function NewPromptModal({ isOpen, isSubmitting, onClose, onSubmit }: NewPromptModalProps) {
  const [prompt, setPrompt] = useState('');
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const closeModal = useCallback(() => {
    setPrompt('');
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 0);

    return () => {
      window.clearTimeout(timer);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeModal();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [closeModal, isOpen]);

  if (!isOpen) {
    return null;
  }

  return (
    <div
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4"
      role="dialog"
      onClick={(event) => {
        if (event.target === event.currentTarget && !isSubmitting) {
          closeModal();
        }
      }}
    >
      <form
        className="w-full max-w-xl rounded-lg border border-slate-200 bg-white p-4 shadow-xl dark:border-slate-700 dark:bg-slate-900"
        onSubmit={(event) => {
          event.preventDefault();
          const value = prompt.trim();
          if (!value || isSubmitting) {
            return;
          }
          void onSubmit(value);
        }}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400">Start New Prompt</h2>
          <button
            className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            disabled={isSubmitting}
            onClick={closeModal}
            type="button"
          >
            Close
          </button>
        </div>

        <textarea
          ref={inputRef}
          className="h-36 w-full resize-y rounded border border-slate-200 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
          disabled={isSubmitting}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Describe task and start autonomous execution..."
          value={prompt}
        />

        <div className="mt-3 flex justify-end gap-2">
          <button
            className="rounded border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            disabled={isSubmitting}
            onClick={closeModal}
            type="button"
          >
            Cancel
          </button>
          <button
            className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            disabled={isSubmitting || prompt.trim().length === 0}
            type="submit"
          >
            {isSubmitting ? 'Starting…' : 'Start'}
          </button>
        </div>
      </form>
    </div>
  );
}