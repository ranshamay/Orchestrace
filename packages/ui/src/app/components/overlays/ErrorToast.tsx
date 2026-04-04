type Props = { message: string };

export function ErrorToast({ message }: Props) {
  if (!message) return null;
  return (
    <div className="fixed bottom-3 right-3 max-w-xl rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 shadow dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
      {message}
    </div>
  );
}