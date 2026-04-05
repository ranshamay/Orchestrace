import type { LlmPromptInput, LlmPromptPart } from '@orchestrace/provider';
import { now } from './clock.js';
import type {
  ChatRole,
  SessionChatContentPart,
  SessionChatMessage,
  SessionChatThread,
  WorkSession,
} from './types.js';
import { asString } from './strings.js';

export function parseChatContentParts(value: unknown): SessionChatContentPart[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const parts: SessionChatContentPart[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const type = asString((entry as Record<string, unknown>).type);
    if (type === 'text') {
      const text = asString((entry as Record<string, unknown>).text);
      if (text) {
        parts.push({ type: 'text', text });
      }
      continue;
    }

    if (type !== 'image') {
      continue;
    }

    const rawData = asString((entry as Record<string, unknown>).data);
    const rawMimeType = asString((entry as Record<string, unknown>).mimeType);
    const dataUrlMatch = rawData.match(/^data:([^;]+);base64,(.+)$/);
    const data = (dataUrlMatch ? dataUrlMatch[2] : rawData).replace(/\s+/g, '');
    if (!data) {
      continue;
    }

    parts.push({
      type: 'image',
      data,
      mimeType: rawMimeType || dataUrlMatch?.[1] || 'image/png',
      name: asString((entry as Record<string, unknown>).name) || undefined,
    });
  }

  return parts;
}

export function summarizeChatContentParts(parts: SessionChatContentPart[]): string {
  const text = parts
    .filter((part): part is Extract<SessionChatContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join('\n\n');

  const images = parts.filter((part): part is Extract<SessionChatContentPart, { type: 'image' }> => part.type === 'image');
  if (images.length === 0) {
    return text;
  }

  const names = images.map((part, index) => part.name || `image-${index + 1}`).join(', ');
  return text
    ? `${text}\n\n[attached ${images.length} image${images.length === 1 ? '' : 's'}: ${names}]`
    : `[attached ${images.length} image${images.length === 1 ? '' : 's'}: ${names}]`;
}

export function compactInlineImageMarkdown(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\(data:image\/[a-zA-Z0-9.+-]+;base64,[^)]+\)/g, '[pasted-image]')
    .replace(/\s+/g, ' ')
    .trim();
}

export function createSessionChatMessage(
  role: ChatRole,
  messageText: string,
  parts: SessionChatContentPart[] = [],
): SessionChatMessage {
  const content = messageText.trim() || summarizeChatContentParts(parts) || '(empty message)';
  return { role, content, contentParts: parts.length > 0 ? parts : undefined, time: now() };
}

export function createSessionChatThread(session: WorkSession, initialParts: SessionChatContentPart[] = []): SessionChatThread {
  const created = now();
  const initialMessage = createSessionChatMessage(
    'user',
    `Initial task prompt:\n${compactInlineImageMarkdown(session.prompt)}`,
    initialParts.length > 0 ? [{ type: 'text', text: 'Initial task prompt' }, ...initialParts] : [],
  );
  initialMessage.time = created;

  return {
    sessionId: session.id,
    provider: session.provider,
    model: session.model,
    workspacePath: session.workspacePath,
    taskPrompt: session.prompt,
    createdAt: created,
    updatedAt: created,
    messages: [initialMessage],
  };
}

export function buildChatContinuationPrompt(thread: SessionChatThread): string {
  const turns = thread.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => {
      const content = message.contentParts?.length ? summarizeChatContentParts(message.contentParts) : message.content;
      return `${message.role.toUpperCase()}: ${content}`;
    })
    .join('\n\n');

  return [
    'Continue this conversation with full continuity.',
    'Conversation so far:',
    turns || '(no previous turns)',
    '',
    'Reply as ASSISTANT and continue from the latest user message.',
  ].join('\n');
}

export function buildChatContinuationInput(thread: SessionChatThread): LlmPromptInput {
  const relevant = thread.messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  let latestMultimodalUser: SessionChatMessage | undefined;
  for (let index = relevant.length - 1; index >= 0; index -= 1) {
    const candidate = relevant[index];
    if (candidate.role === 'user' && candidate.contentParts?.some((part) => part.type === 'image')) {
      latestMultimodalUser = candidate;
      break;
    }
  }

  if (!latestMultimodalUser) {
    return buildChatContinuationPrompt(thread);
  }

  const history = relevant
    .filter((message) => message !== latestMultimodalUser)
    .map((message) => `${message.role.toUpperCase()}: ${message.contentParts?.length ? summarizeChatContentParts(message.contentParts) : message.content}`)
    .join('\n\n');

  const multimodalParts: LlmPromptPart[] = (latestMultimodalUser.contentParts ?? [{ type: 'text', text: latestMultimodalUser.content }]).map((part) => {
    if (part.type === 'text') {
      return { type: 'text', text: part.text };
    }
    return { type: 'image', data: part.data, mimeType: part.mimeType };
  });

  return [
    {
      type: 'text',
      text: [
        'Continue this conversation with full continuity.',
        'Conversation so far (excluding latest multimodal user message):',
        history || '(no previous turns)',
        '',
        'The latest user message follows as multimodal content (text + image attachments).',
        'Reply as ASSISTANT and continue from that latest user message.',
      ].join('\n'),
    },
    ...multimodalParts,
  ];
}

export function trimThreadMessages(thread: SessionChatThread, maxMessages = Number.POSITIVE_INFINITY): void {
  if (!Number.isFinite(maxMessages)) {
    return;
  }

  if (thread.messages.length > maxMessages) {
    thread.messages.splice(0, thread.messages.length - maxMessages);
  }
}

export function cloneChatContentParts(parts: SessionChatContentPart[] = []): SessionChatContentPart[] {
  return parts.map((part) => (part.type === 'text'
    ? { type: 'text', text: part.text }
    : { type: 'image', data: part.data, mimeType: part.mimeType, name: part.name }));
}

export function estimateTokensFromText(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.max(1, Math.ceil(text.length / 4));
}

export function scheduleChatStreamCleanup(streams: Map<string, unknown>, streamId: string, ttlMs = 60_000): void {
  setTimeout(() => {
    streams.delete(streamId);
  }, ttlMs);
}