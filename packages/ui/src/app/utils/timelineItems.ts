import type { ChatMessage, WorkSession } from '../../lib/api';
import type { TimelineItem } from '../types';
import { formatTimelineEvent, parseToolCallEvent, toolInputSummary, toolOutputSummary } from './timeline';

export function buildTimelineItems(selectedSession: WorkSession | undefined, chatMessages: ChatMessage[]): TimelineItem[] {
  const rawEvents = (selectedSession?.events ?? []).slice(-1000);
  const items: TimelineItem[] = [];
  const pendingToolInputs = new Map<string, TimelineItem[]>();

  for (const [index, event] of rawEvents.entries()) {
    const toolInfo = parseToolCallEvent(event);

    if (event.type === 'session:llm-context') {
      const provider = typeof event.llmContextProvider === 'string' ? event.llmContextProvider : '';
      const model = typeof event.llmContextModel === 'string' ? event.llmContextModel : '';
      const providerModel = [provider, model].filter((value) => value.length > 0).join('/');
      const phase = typeof event.llmContextPhase === 'string' ? event.llmContextPhase : 'chat';

      const details: string[] = [];
      if (typeof event.llmContextTextChars === 'number') {
        details.push(`${event.llmContextTextChars.toLocaleString()} chars`);
      }
      if (typeof event.llmContextImageCount === 'number') {
        details.push(`${event.llmContextImageCount} images`);
      }

      items.push({
        key: `llm-context-${event.time}-${index}`,
        time: event.time,
        kind: 'event',
        title: 'LLM Context Snapshot',
        subtitle: [phase, providerModel].filter((value) => value.length > 0).join(' | '),
        tone: 'tool',
        content: details.length > 0 ? details.join(' • ') : event.message,
        llmContextSnapshotId: event.llmContextSnapshotId,
        llmContextPhase: phase,
        llmContextProvider: provider,
        llmContextModel: model,
        llmContextTextChars: event.llmContextTextChars,
        llmContextImageCount: event.llmContextImageCount,
      });
      continue;
    }

    if (toolInfo) {
      if (toolInfo.direction === 'input') {
        const item: TimelineItem = {
          key: `tool-${event.time}-${index}`,
          time: event.time,
          kind: 'tool-call',
          toolName: toolInfo.toolName,
          inputSummary: toolInputSummary(toolInfo.toolName, toolInfo.payload),
          inputPayload: toolInfo.payload,
          toolStatus: 'pending',
          content: '',
        };
        const queueKey = `${toolInfo.taskId}:${toolInfo.toolName}`;
        if (!pendingToolInputs.has(queueKey)) {
          pendingToolInputs.set(queueKey, []);
        }
        pendingToolInputs.get(queueKey)!.push(item);
        items.push(item);
      } else {
        const queueKey = `${toolInfo.taskId}:${toolInfo.toolName}`;
        const queue = pendingToolInputs.get(queueKey);
        const pendingItem = queue?.shift();

        if (pendingItem) {
                    pendingItem.outputSummary = toolOutputSummary(toolInfo.toolName, toolInfo.payload, toolInfo.isError, toolInfo.details);

          pendingItem.outputPayload = toolInfo.payload;
          pendingItem.toolStatus = toolInfo.isError ? 'error' : 'success';
          pendingItem.endTime = event.time;
        } else {
          items.push({
            key: `tool-${event.time}-${index}`,
            time: event.time,
            kind: 'tool-call',
            toolName: toolInfo.toolName,
                        outputSummary: toolOutputSummary(toolInfo.toolName, toolInfo.payload, toolInfo.isError, toolInfo.details),

            outputPayload: toolInfo.payload,
            toolStatus: toolInfo.isError ? 'error' : 'success',
            content: '',
          });
        }
      }
    } else {
      const formatted = formatTimelineEvent(event);
      items.push({
        key: `event-${event.time}-${index}`,
        time: event.time,
        kind: 'event',
        title: formatted.title,
        subtitle: formatted.subtitle,
        failureType: formatted.failureType,
        tone: formatted.tone,
        content: formatted.content,
      });
    }
  }

  const chatItems: TimelineItem[] = chatMessages.map((message, index) => ({
    key: `chat-${message.time}-${index}`,
    time: message.time,
    kind: 'chat',
    role: message.role,
    content: message.content,
    contentParts: message.contentParts,
  }));

  // Inject a terminal error item when the session has a visible error
  const errorText = selectedSession?.error || selectedSession?.llmStatus?.detail;
  const isTerminal = selectedSession?.status && /fail|error|cancel|abort/i.test(selectedSession.status);
  if (isTerminal && errorText) {
    const errorTime = selectedSession.updatedAt || new Date().toISOString();
    items.push({
      key: `session-error-${errorTime}`,
      time: errorTime,
      kind: 'event',
      title: 'Session Error',
      tone: 'error',
      content: errorText,
    });
  }

  return [...items, ...chatItems].sort((a, b) => a.time.localeCompare(b.time));
}