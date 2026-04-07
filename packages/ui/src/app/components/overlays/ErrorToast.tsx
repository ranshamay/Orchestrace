type Props = {
  message: string;
  tone?: 'error' | 'warning';
  confirmLabel?: string;
  dismissLabel?: string;
  onConfirm?: () => void;
  onDismiss?: () => void;
};

export function ErrorToast({
  message,
  tone = 'error',
  confirmLabel = 'Switch model',
  dismissLabel = 'Keep current',
  onConfirm,
  onDismiss,
}: Props) {
  if (!message) return null;

  const isWarning = tone === 'warning';
  const toneClass = isWarning
    ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200'
    : 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300';

  return (
    <div className={`fixed bottom-3 right-3 z-50 max-w-xl rounded border px-3 py-2 text-sm shadow ${toneClass}`}>
      <div>{message}</div>
      {(isWarning || onDismiss || onConfirm) && (
        <div className="mt-2 flex items-center justify-end gap-2">
          {onDismiss && (
            <button
              type="button"
              className="rounded border border-current/30 px-2 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10"
              onClick={onDismiss}
            >
              {dismissLabel}
            </button>
          )}
          {onConfirm && (
            <button
              type="button"
              className="rounded bg-current px-2 py-1 text-xs font-medium text-white/95 hover:opacity-90"
              onClick={onConfirm}
            >
              {confirmLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
}