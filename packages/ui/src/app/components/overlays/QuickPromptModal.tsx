import { useEffect, useRef, useState } from "react";
import {
  canSubmitQuickPrompt,
  normalizeQuickPrompt,
  shouldCloseQuickPrompt,
  shouldSubmitQuickPrompt,
} from "./quickPromptUtils";

type QuickPromptModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (prompt: string) => void;
};

export function QuickPromptModal({
  isOpen,
  onClose,
  onSubmit,
}: QuickPromptModalProps) {
  const [value, setValue] = useState("");
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

    const handleClose = () => {
    setValue("");
    onClose();
  };

  const handleSubmit = () => {
    const normalized = normalizeQuickPrompt(value);
    if (!normalized) {
      return;
    }

    onSubmit(normalized);
    setValue("");
  };

  return (
    <div
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4"
      role="dialog"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          handleClose();
        }
      }}
    >
      <div className="w-full max-w-2xl rounded-lg border border-slate-200 bg-white p-4 shadow-xl dark:border-slate-700 dark:bg-slate-900">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-sm font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400">
            New Prompt
          </h2>
          <button
            className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                        onClick={handleClose}
            type="button"
          >
            Close
          </button>
        </div>

        <textarea
          ref={textareaRef}
          className="h-32 w-full resize-y rounded border border-slate-200 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (shouldCloseQuickPrompt(event)) {
              handleClose();
              return;
            }

            if (shouldSubmitQuickPrompt(event)) {
              event.preventDefault();
              handleSubmit();
            }
          }}
          placeholder="Describe what you want Orchestrace to do..."
          value={value}
        />

        <div className="mt-3 flex items-center justify-between">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Shortcut: <span className="font-mono">⌘K</span> /{" "}
            <span className="font-mono">Ctrl+K</span>
          </p>
          <div className="flex items-center gap-2">
            <button
              className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                          onClick={handleClose}
              type="button"
            >
              Cancel
            </button>
            <button
              className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              disabled={!canSubmitQuickPrompt(value)}
              onClick={handleSubmit}
              type="button"
            >
              Fill Composer
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
