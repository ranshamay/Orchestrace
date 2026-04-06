import { formatFailureTypeLabel, failureTypeBadgeClass } from '../../utils/failure';
import { MarkdownMessage } from '../MarkdownMessage';
import { UserMessageContent } from '../UserMessageContent';
import { ToolChipGroup } from './ToolChipGroup';
import type { TimelineItem } from '../../types';

type Props = {
  timelineItems: TimelineItem[];
  isDark: boolean;
};

type RenderBlock =
  | { type: 'item'; item: TimelineItem }
  | { type: 'tool-group'; items: TimelineItem[] };

function groupTimelineItems(items: TimelineItem[]): RenderBlock[] {
  const blocks: RenderBlock[] = [];
  let currentToolRun: TimelineItem[] = [];

  const flushToolRun = () => {
    if (currentToolRun.length > 0) {
      blocks.push({ type: 'tool-group', items: currentToolRun });
      currentToolRun = [];
    }
  };

  for (const item of items) {
    if (item.kind === 'tool-call') {
      currentToolRun.push(item);
    } else {
      flushToolRun();
      blocks.push({ type: 'item', item });
    }
  }
  flushToolRun();

  return blocks;
}

export function TimelineList({ timelineItems, isDark }: Props) {
  const blocks = groupTimelineItems(timelineItems);

  return (
    <>
      {timelineItems.length === 0 && <div className="text-center text-xs italic text-slate-400 dark:text-slate-500">No chat/events yet.</div>}
      {blocks.map((block) => {
        if (block.type === 'tool-group') {
          return (
            <ToolChipGroup
              key={block.items[0].key}
              items={block.items}
              isDark={isDark}
            />
          );
        }

        const item = block.item;
        return (
          <div
            key={item.key}
            className={`rounded border p-2.5 text-sm ${item.kind === 'event' ? item.tone === 'error' ? 'border-red-200 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-100' : item.tone === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100' : item.tone === 'tool' ? 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-100' : 'border-slate-200 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200' : item.role === 'user' ? 'border-blue-100 bg-blue-50 text-blue-900 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-100' : 'border-slate-200 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200'}`}
          >
            <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-widest text-slate-400 dark:text-slate-500">
              <span>{item.kind === 'event' ? item.title : item.role}</span>
              <span>{new Date(item.time).toLocaleTimeString([], { hour12: false })}</span>
            </div>
            {item.kind === 'event' && item.subtitle && (
              <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium opacity-80">
                <span>{item.subtitle}</span>
                {item.failureType && (
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${failureTypeBadgeClass(item.failureType)}`}>
                    {formatFailureTypeLabel(item.failureType)}
                  </span>
                )}
              </div>
            )}
            {item.kind === 'event' && item.tone === 'tool' && <MarkdownMessage content={item.content} dark={isDark} />}
            {item.kind === 'event' && item.tone !== 'tool' && <div className="whitespace-pre-wrap break-words">{item.content}</div>}
            {item.kind === 'chat' && item.role === 'assistant' && <MarkdownMessage content={item.content} dark={isDark} />}
            {item.kind === 'chat' && item.role === 'user' && <UserMessageContent content={item.content} contentParts={item.contentParts} />}
          </div>
        );
      })}
    </>
  );
}