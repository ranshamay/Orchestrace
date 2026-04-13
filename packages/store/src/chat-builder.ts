// ---------------------------------------------------------------------------
// Chat Message Builder — pure immutable helpers
// ---------------------------------------------------------------------------
// All functions return new arrays/objects. No mutations.
// ---------------------------------------------------------------------------

import type {
  ChatMessage,
  ChatSessionPhase,
  MessagePart,
  ReasoningMessagePart,
  TextMessagePart,
  ToolCallMessagePart,
} from './chat-types.js';

import type {
  MaterializedSession,
  SessionChatMessage,
  SessionStreamDeltaPayload,
  UiDagEvent,
} from './types.js';

// ─── Core builders ──────────────────────────────────────────────────────────

/** Start a new message and append it to the list. */
export function startMessage(
  messages: ChatMessage[],
  opts: {
    id: string;
    role: ChatMessage['role'];
    phase?: ChatSessionPhase;
    taskId?: string;
    agentId?: string;
    timestamp: string;
  },
): ChatMessage[] {
  const msg: ChatMessage = {
    id: opts.id,
    role: opts.role,
    phase: opts.phase,
    taskId: opts.taskId,
    agentId: opts.agentId,
    timestamp: opts.timestamp,
    status: 'streaming',
    parts: [],
  };
  return [...messages, msg];
}

/** Append a part to a specific message. */
export function appendPart(
  messages: ChatMessage[],
  messageId: string,
  part: MessagePart,
): ChatMessage[] {
  return messages.map((m) =>
    m.id === messageId ? { ...m, parts: [...m.parts, part] } : m,
  );
}

/** Update a text/reasoning part's text via delta append. */
export function updatePartDelta(
  messages: ChatMessage[],
  messageId: string,
  partId: string,
  delta: string,
): ChatMessage[] {
  return messages.map((m) => {
    if (m.id !== messageId) return m;
    return {
      ...m,
      parts: m.parts.map((p) => {
        if (!('id' in p) || p.id !== partId) return p;
        if (p.type === 'reasoning' || p.type === 'text') {
          return { ...p, text: p.text + delta } as ReasoningMessagePart | TextMessagePart;
        }
        return p;
      }),
    };
  });
}

/** Mark a specific part as no longer streaming. */
export function completePart(
  messages: ChatMessage[],
  messageId: string,
  partId: string,
  extra?: Partial<ToolCallMessagePart>,
): ChatMessage[] {
  return messages.map((m) => {
    if (m.id !== messageId) return m;
    return {
      ...m,
      parts: m.parts.map((p) => {
        if (!('id' in p) || p.id !== partId) return p;
        if (p.type === 'reasoning' || p.type === 'text') {
          return { ...p, isStreaming: false } as ReasoningMessagePart | TextMessagePart;
        }
        if (p.type === 'tool-call' && extra) {
          return { ...p, ...extra } as ToolCallMessagePart;
        }
        return p;
      }),
    };
  });
}

/** Mark an entire message as complete. */
export function completeMessage(
  messages: ChatMessage[],
  messageId: string,
  status: 'complete' | 'error' = 'complete',
): ChatMessage[] {
  return messages.map((m) =>
    m.id === messageId
      ? {
          ...m,
          status,
          parts: m.parts.map((p) => {
            if ((p.type === 'reasoning' || p.type === 'text') && p.isStreaming) {
              return { ...p, isStreaming: false };
            }
            return p;
          }),
        }
      : m,
  );
}

// ─── Legacy event conversion ────────────────────────────────────────────────

let _seqId = 0;
function nextId(prefix: string): string {
  return `${prefix}-${++_seqId}`;
}

/**
 * Convert a MaterializedSession's events + chat messages into ChatMessage[].
 * Used to render historical sessions created before the v2 protocol.
 */
export function convertLegacyEvents(
  session: MaterializedSession,
): ChatMessage[] {
  const result: ChatMessage[] = [];
  let currentMsg: ChatMessage | null = null;
  let currentPhase: ChatSessionPhase = 'planning';
  let currentTaskId: string | undefined;

  function ensureMessage(time: string, role: ChatMessage['role'] = 'assistant'): ChatMessage {
    if (currentMsg && currentMsg.role === role && currentMsg.status === 'streaming') {
      return currentMsg;
    }
    const msg: ChatMessage = {
      id: nextId('lm'),
      role,
      phase: currentPhase,
      taskId: currentTaskId,
      timestamp: time,
      status: 'streaming',
      parts: [],
    };
    result.push(msg);
    currentMsg = msg;
    return msg;
  }

  function finishCurrentMessage(): void {
    if (currentMsg && currentMsg.status === 'streaming') {
      currentMsg.status = 'complete';
      currentMsg.parts = currentMsg.parts.map((p) => {
        if ((p.type === 'reasoning' || p.type === 'text') && p.isStreaming) {
          return { ...p, isStreaming: false };
        }
        return p;
      });
    }
    currentMsg = null;
  }

  // First, inject user prompt as a user message
  if (session.config.prompt) {
    result.push({
      id: nextId('lm'),
      role: 'user',
      timestamp: session.createdAt,
      status: 'complete',
      parts: [{ type: 'text', id: nextId('lp'), text: session.config.prompt, isStreaming: false }],
    });
  }

  // Interleave chat messages and DAG events by timestamp
  const chatMsgs = (session.chatThread?.messages ?? []).map((m) => ({ kind: 'chat' as const, time: m.time, data: m }));
  const dagEvents = session.events.map((e) => ({ kind: 'dag' as const, time: e.time, data: e }));
  const merged = [...chatMsgs, ...dagEvents].sort((a, b) => a.time.localeCompare(b.time));

  for (const entry of merged) {
    if (entry.kind === 'chat') {
      const chatMsg = entry.data as SessionChatMessage;
      if (chatMsg.role === 'user') {
        finishCurrentMessage();
        result.push({
          id: nextId('lm'),
          role: 'user',
          timestamp: chatMsg.time,
          status: 'complete',
          parts: [{ type: 'text', id: nextId('lp'), text: chatMsg.content, isStreaming: false }],
        });
        continue;
      }
      if (chatMsg.role === 'assistant') {
        const msg = ensureMessage(chatMsg.time, 'assistant');
        msg.parts.push({ type: 'text', id: nextId('lp'), text: chatMsg.content, isStreaming: false });
        continue;
      }
    }

    if (entry.kind === 'dag') {
      const evt = entry.data as UiDagEvent;

      // Phase transitions
      if (evt.type === 'task:planning' || evt.type === 'task:implementation-planning' || evt.type === 'task:implementation') {
        const newPhase: ChatSessionPhase =
          evt.type === 'task:planning' || evt.type === 'task:implementation-planning'
            ? 'planning'
            : 'implementation';

        if (newPhase !== currentPhase) {
          finishCurrentMessage();
          currentPhase = newPhase;
          const msg = ensureMessage(evt.time);
          msg.parts.push({
            type: 'phase-transition',
            phase: newPhase,
            label: newPhase.charAt(0).toUpperCase() + newPhase.slice(1),
          });
        }
      }

      // Track task changes
      if (evt.taskId && evt.taskId !== currentTaskId) {
        finishCurrentMessage();
        currentTaskId = evt.taskId;
      }

      // Tool calls
      if (evt.toolName) {
        const msg = ensureMessage(evt.time);
        if (evt.toolStatus === 'started') {
          msg.parts.push({
            type: 'tool-call',
            id: evt.toolCallId ?? nextId('ltc'),
            toolName: evt.toolName,
            input: evt.toolInput,
            inputSummary: summarizeToolInput(evt.toolName, evt.toolInput),
            status: 'calling',
            startTime: evt.time,
          });
        } else if (evt.toolStatus === 'result') {
          // Find matching started tool-call and update it
          const existingIdx = msg.parts.findIndex(
            (p) => p.type === 'tool-call' && (p as ToolCallMessagePart).id === evt.toolCallId,
          );
          if (existingIdx >= 0) {
            const existing = msg.parts[existingIdx] as ToolCallMessagePart;
            msg.parts[existingIdx] = {
              ...existing,
              status: evt.toolIsError ? 'error' : 'success',
              output: evt.toolOutput,
              outputSummary: summarizeToolOutput(evt.toolName, evt.toolOutput),
              endTime: evt.time,
              error: evt.toolIsError ? String(evt.toolOutput ?? 'Tool error') : undefined,
            };
          } else {
            // No matching start — create a complete tool-call part
            msg.parts.push({
              type: 'tool-call',
              id: evt.toolCallId ?? nextId('ltc'),
              toolName: evt.toolName,
              input: evt.toolInput,
              inputSummary: summarizeToolInput(evt.toolName, evt.toolInput),
              output: evt.toolOutput,
              outputSummary: summarizeToolOutput(evt.toolName, evt.toolOutput),
              status: evt.toolIsError ? 'error' : 'success',
              startTime: evt.time,
              endTime: evt.time,
              error: evt.toolIsError ? String(evt.toolOutput ?? 'Tool error') : undefined,
            });
          }
        }
      }

      // LLM context snapshots
      if (evt.llmContextSnapshotId) {
        const msg = ensureMessage(evt.time);
        msg.parts.push({
          type: 'context-snapshot',
          snapshotId: evt.llmContextSnapshotId,
          phase: evt.llmContextPhase ?? currentPhase,
          model: evt.llmContextModel ?? '',
          textChars: evt.llmContextTextChars ?? 0,
          imageCount: evt.llmContextImageCount ?? 0,
        });
      }
    }
  }

  finishCurrentMessage();
  return result;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function summarizeToolInput(toolName: string, input: unknown): string {
  if (!input) return '';
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      return summarizeToolInputObj(toolName, parsed);
    } catch {
      return input.length > 80 ? input.slice(0, 80) + '…' : input;
    }
  }
  if (typeof input === 'object') {
    return summarizeToolInputObj(toolName, input as Record<string, unknown>);
  }
  return String(input);
}

function summarizeToolInputObj(toolName: string, obj: Record<string, unknown>): string {
  // Show the most useful field based on tool name
  const path = obj.filePath ?? obj.path ?? obj.file ?? obj.query ?? obj.command;
  if (typeof path === 'string') {
    return path.length > 80 ? '…' + path.slice(-77) : path;
  }
  const keys = Object.keys(obj);
  if (keys.length === 0) return '';
  return `${keys.length} params`;
}

function summarizeToolOutput(toolName: string, output: unknown): string {
  if (!output) return '';
  if (typeof output === 'string') {
    if (output.length <= 60) return output;
    const lines = output.split('\n').length;
    return `${lines} lines, ${output.length} chars`;
  }
  return JSON.stringify(output).slice(0, 60);
}
