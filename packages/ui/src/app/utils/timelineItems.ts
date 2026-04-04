import type { ChatMessage, WorkSession } from '../../lib/api';
import type { TimelineItem } from '../types';
import { formatTimelineEvent } from './timeline';

export function buildTimelineItems(selectedSession: WorkSession | undefined, chatMessages: ChatMessage[]): TimelineItem[] {
  const eventItems: TimelineItem[] = (selectedSession?.events ?? []).slice(-120).map((event, index) => {
    const formatted = formatTimelineEvent(event);
    return {
      key: `event-${event.time}-${index}`,
      time: event.time,
      kind: 'event',
      title: formatted.title,
      subtitle: formatted.subtitle,
      failureType: formatted.failureType,
      tone: formatted.tone,
      content: formatted.content,
    };
  });

  const chatItems: TimelineItem[] = chatMessages.map((message, index) => ({
    key: `chat-${message.time}-${index}`,
    time: message.time,
    kind: 'chat',
    role: message.role,
    content: message.content,
    contentParts: message.contentParts,
  }));

  return [...eventItems, ...chatItems].sort((a, b) => a.time.localeCompare(b.time));
}