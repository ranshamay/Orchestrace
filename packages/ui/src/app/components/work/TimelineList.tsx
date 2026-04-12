import { useEffect, useMemo, useState } from 'react';
import { formatFailureTypeLabel, failureTypeBadgeClass } from '../../utils/failure';
import { MarkdownMessage } from '../MarkdownMessage';
import { UserMessageContent } from '../UserMessageContent';
import { ToolChipGroup } from './ToolChipGroup';
import type { TimelineItem } from '../../types';
import {
  fetchSessionLlmContextSnapshot,
  fetchSessionLlmContextSnapshots,
  type SessionLlmContextSnapshotDetail,
  type SessionLlmContextSnapshotSummary,
} from '../../../lib/api';

type Props = {
  timelineItems: TimelineItem[];
  isDark: boolean;
  selectedSessionId: string;
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

export function TimelineList({ timelineItems, isDark, selectedSessionId }: Props) {
  const blocks = groupTimelineItems(timelineItems);
  const [snapshotSummaries, setSnapshotSummaries] = useState<SessionLlmContextSnapshotSummary[]>([]);

  // Count context events so the fetch re-fires when new snapshots arrive during a live session.
  const contextEventCount = useMemo(
    () => timelineItems.filter((item) => item.llmContextSnapshotId).length,
    [timelineItems],
  );

  useEffect(() => {
    let cancelled = false;

    if (!selectedSessionId) {
      setSnapshotSummaries([]);
      return () => {
        cancelled = true;
      };
    }

    void fetchSessionLlmContextSnapshots(selectedSessionId)
      .then((result) => {
        if (!cancelled) {
          setSnapshotSummaries(Array.isArray(result.snapshots) ? result.snapshots : []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSnapshotSummaries([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedSessionId, contextEventCount]);

  const snapshotIdsInTimeline = useMemo(() => {
    const ids = new Set<string>();
    for (const item of timelineItems) {
      if (item.llmContextSnapshotId) {
        ids.add(item.llmContextSnapshotId);
      }
    }
    return ids;
  }, [timelineItems]);

  const fallbackSnapshotItems: TimelineItem[] = useMemo(() => {
    return snapshotSummaries
      .filter((snapshot) => !snapshotIdsInTimeline.has(snapshot.id))
      .map((snapshot) => ({
        key: `llm-context-fallback-${snapshot.id}`,
        time: snapshot.time,
        kind: 'event' as const,
        title: 'LLM Context Snapshot',
        subtitle: [snapshot.phase, `${snapshot.provider}/${snapshot.model}`].join(' | '),
        tone: 'tool' as const,
        content: `${snapshot.textChars.toLocaleString()} chars • ${snapshot.imageCount} images`,
        llmContextSnapshotId: snapshot.id,
        llmContextPhase: snapshot.phase,
        llmContextProvider: snapshot.provider,
        llmContextModel: snapshot.model,
        llmContextTextChars: snapshot.textChars,
        llmContextImageCount: snapshot.imageCount,
      }))
      .sort((a, b) => a.time.localeCompare(b.time));
  }, [snapshotIdsInTimeline, snapshotSummaries]);

  return (
    <>
      {timelineItems.length === 0 && <div className="text-center text-xs italic text-slate-400 dark:text-slate-500">No chat/events yet.</div>}
      {fallbackSnapshotItems.map((item) => (
        <LlmContextSnapshotCard
          key={item.key}
          item={item}
          sessionId={selectedSessionId}
        />
      ))}
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
        if (item.kind === 'event' && item.llmContextSnapshotId && selectedSessionId) {
          return (
            <LlmContextSnapshotCard
              key={item.key}
              item={item}
              sessionId={selectedSessionId}
            />
          );
        }

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

function LlmContextSnapshotCard({ item, sessionId }: { item: TimelineItem; sessionId: string }) {
  const snapshotId = item.llmContextSnapshotId;
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [snapshot, setSnapshot] = useState<SessionLlmContextSnapshotDetail | null>(null);

  if (!snapshotId) {
    return null;
  }

  const loadSnapshot = async () => {
    if (snapshot || loading) {
      return;
    }

    setLoading(true);
    setError('');
    try {
      const result = await fetchSessionLlmContextSnapshot(sessionId, snapshotId);
      setSnapshot(result.snapshot);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  };

  const onToggleExpanded = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) {
      void loadSnapshot();
    }
  };

  const metadata = [
    item.llmContextPhase,
    item.llmContextProvider && item.llmContextModel
      ? `${item.llmContextProvider}/${item.llmContextModel}`
      : '',
  ].filter((value): value is string => Boolean(value));

  return (
    <div className="rounded border border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-100">
      <button
        className="w-full px-2.5 py-2 text-left"
        onClick={onToggleExpanded}
        type="button"
      >
        <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-widest text-sky-500 dark:text-sky-300">
          <span>LLM Context Snapshot</span>
          <span>{new Date(item.time).toLocaleTimeString([], { hour12: false })}</span>
        </div>
        <div className="text-xs font-medium">
          {item.content}
        </div>
        {metadata.length > 0 && (
          <div className="mt-1 text-[11px] opacity-80">{metadata.join(' | ')}</div>
        )}
      </button>

      {expanded && (
        <div className="border-t border-sky-200 px-2.5 py-2 dark:border-sky-800">
          {loading && <div className="text-xs italic opacity-80">Loading context snapshot...</div>}
          {!loading && error && (
            <div className="text-xs text-red-600 dark:text-red-300">Failed to load snapshot: {error}</div>
          )}
          {!loading && !error && snapshot && (
            <div className="space-y-2">
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wide opacity-80">System Prompt</div>
                <pre className="max-h-52 overflow-auto rounded bg-sky-100/70 px-2 py-1.5 text-[11px] leading-relaxed dark:bg-sky-900/30">
                  {snapshot.systemPrompt || '(empty)'}
                </pre>
              </div>
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wide opacity-80">Prompt Input</div>
                <pre className="max-h-64 overflow-auto rounded bg-sky-100/70 px-2 py-1.5 text-[11px] leading-relaxed dark:bg-sky-900/30">
                  {snapshot.promptText || '(empty)'}
                </pre>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}