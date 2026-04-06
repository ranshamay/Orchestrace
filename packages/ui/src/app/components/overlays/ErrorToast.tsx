type Props = {
  message: string;
  tone?: 'error' | 'warning';
  actionLabel?: string;
  onAction?: () => void;
  onDismiss?: () => void;
};

const toneStyles: Record<NonNullable<Props['tone']>, string> = {
  error: 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300',
  warning: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
};

export function ErrorToast({ message, tone = 'error', actionLabel, onAction, onDismiss }: Props) {
  if (!message) return null;
  return (
    <div
      className={`fixed bottom-3 right-3 max-w-xl rounded border px-3 py-2 text-sm shadow ${toneStyles[tone]}`}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-2">
        <span className="flex-1">{message}</span>
        {onDismiss ? (
          <button
            type="button"
            className="rounded px-1 text-xs font-medium opacity-80 hover:opacity-100"
            onClick={onDismiss}
          >
            Dismiss
          </button>
        ) : null}
      </div>
      {actionLabel && onAction ? (
        <div className="mt-2">
          <button
            type="button"
            className="rounded border border-current px-2 py-1 text-xs font-medium hover:opacity-90"
            onClick={onAction}
          >
            {actionLabel}
          </button>
        </div>
      ) : null}
    </div>
  );
}