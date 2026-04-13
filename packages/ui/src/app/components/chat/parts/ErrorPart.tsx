import type { ErrorMessagePart } from '../../../chat-types';

type Props = { part: ErrorMessagePart };

export function ErrorPart({ part }: Props) {
  return (
    <div className="flex items-start gap-1 text-[11px] text-red-600 dark:text-red-400 py-0.5">
      <span>💥</span>
      <span>{part.message}</span>
    </div>
  );
}
