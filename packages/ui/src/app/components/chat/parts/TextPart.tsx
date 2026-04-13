import type { TextMessagePart } from '../../../chat-types';
import { MarkdownMessage } from '../../MarkdownMessage';

type Props = { part: TextMessagePart };

export function TextPart({ part }: Props) {
  return (
    <div className="text-[12px] leading-relaxed text-slate-800 dark:text-slate-200">
      <MarkdownMessage content={part.text} dark={false} />
      {part.isStreaming && <span className="animate-pulse text-blue-500">█</span>}
    </div>
  );
}
