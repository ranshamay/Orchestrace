type SettingsSaveToastState = 'idle' | 'saving' | 'saved' | 'error';

type Props = {
  state: SettingsSaveToastState;
  message: string;
};

export function SettingsSaveToast({ state, message }: Props) {
  if (state === 'idle' || !message) {
    return null;
  }

  const className = state === 'saving'
    ? 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300'
    : state === 'saved'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
      : 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300';

  return (
    <div className={`fixed bottom-12 right-3 max-w-xl rounded border px-3 py-2 text-sm shadow ${className}`}>
      {message}
    </div>
  );
}

export type { SettingsSaveToastState };