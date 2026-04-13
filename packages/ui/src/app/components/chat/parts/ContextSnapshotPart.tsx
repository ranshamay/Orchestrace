import type { ContextSnapshotMessagePart } from '../../../chat-types';

type Props = { part: ContextSnapshotMessagePart };

export function ContextSnapshotPart({ part }: Props) {
  return (
    <div className="flex items-center gap-1 text-[10px] text-slate-400 dark:text-slate-500 py-0.5">
      <span>📊</span>
      <span>{part.model}</span>
      <span>·</span>
      <span>{part.textChars.toLocaleString()} chars</span>
      {part.imageCount > 0 && (
        <>
          <span>·</span>
          <span>{part.imageCount} images</span>
        </>
      )}
    </div>
  );
}
