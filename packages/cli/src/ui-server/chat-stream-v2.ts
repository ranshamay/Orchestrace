// ---------------------------------------------------------------------------
// Chat SSE v2 — transforms session store events into v2 chat stream events
// ---------------------------------------------------------------------------

import type { ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { sendSse } from './sse.js';
import { now } from './clock.js';
import type { ChatSseEvent, ChatSessionPhase } from '@orchestrace/store';
import type {
  AgentTodoItem,
  SessionLlmStatus,
  UiDagEvent,
  WorkSession,
} from './types.js';

// ─── Per-session v2 state ───────────────────────────────────────────────────

export interface ChatStreamState {
  currentMessageId: string | null;
  currentPhase: ChatSessionPhase;
  currentTaskId: string | undefined;
  lastEventTime: string;
  activeReasoningPartId: string | null;
  activeTextPartId: string | null;
}

export function createChatStreamState(): ChatStreamState {
  return {
    currentMessageId: null,
    currentPhase: 'planning',
    currentTaskId: undefined,
    lastEventTime: '',
    activeReasoningPartId: null,
    activeTextPartId: null,
  };
}

// ─── v2-aware client tracking ───────────────────────────────────────────────

export interface V2Client {
  res: ServerResponse;
  state: ChatStreamState;
}

// ─── Broadcast helpers ──────────────────────────────────────────────────────

function broadcastV2(clients: Set<V2Client>, event: ChatSseEvent): void {
  if (clients.size === 0) return;
  for (const client of [...clients]) {
    try {
      sendSse(client.res, 'chat', event);
    } catch {
      clients.delete(client);
    }
  }
}

function ensureMessage(
  clients: Set<V2Client>,
  state: ChatStreamState,
  time: string,
  role: 'user' | 'assistant' | 'system' = 'assistant',
  opts?: { phase?: ChatSessionPhase; taskId?: string; agentId?: string },
): string {
  // Start new message if: no current message, phase changed, task changed, or >5s gap
  const needNew =
    !state.currentMessageId ||
    (opts?.phase && opts.phase !== state.currentPhase) ||
    (opts?.taskId && opts.taskId !== state.currentTaskId) ||
    (state.lastEventTime && Date.parse(time) - Date.parse(state.lastEventTime) > 5_000);

  if (needNew) {
    // Close any active streaming parts
    if (state.activeReasoningPartId && state.currentMessageId) {
      broadcastV2(clients, { type: 'reasoning-end', messageId: state.currentMessageId, partId: state.activeReasoningPartId });
      state.activeReasoningPartId = null;
    }
    if (state.activeTextPartId && state.currentMessageId) {
      broadcastV2(clients, { type: 'text-end', messageId: state.currentMessageId, partId: state.activeTextPartId });
      state.activeTextPartId = null;
    }
    // Close previous message
    if (state.currentMessageId) {
      broadcastV2(clients, { type: 'message-end', messageId: state.currentMessageId });
    }

    const msgId = `m-${randomUUID().slice(0, 8)}`;
    state.currentMessageId = msgId;
    if (opts?.phase) state.currentPhase = opts.phase;
    if (opts?.taskId) state.currentTaskId = opts.taskId;
    state.lastEventTime = time;

    broadcastV2(clients, {
      type: 'message-start',
      messageId: msgId,
      role,
      phase: state.currentPhase,
      taskId: state.currentTaskId,
      agentId: opts?.agentId,
      timestamp: time,
    });
    return msgId;
  }

  state.lastEventTime = time;
  return state.currentMessageId!;
}

// ─── Event translators ──────────────────────────────────────────────────────

/** Handle a stream-delta event (reasoning / text tokens). */
export function handleV2StreamDelta(
  clients: Set<V2Client>,
  state: ChatStreamState,
  payload: { taskId: string; phase: string; delta: string; isReasoning?: boolean },
  llmStatus: SessionLlmStatus,
  time: string,
): void {
  if (clients.size === 0) return;

  const phase = (payload.phase === 'planning' || payload.phase === 'implementation' || payload.phase === 'testing')
    ? payload.phase as ChatSessionPhase
    : state.currentPhase;

  const msgId = ensureMessage(clients, state, time, 'assistant', { phase, taskId: payload.taskId });

  // Use the explicit isReasoning flag from the provider when available,
  // fall back to llmStatus heuristic for backward compatibility
  const isReasoning = payload.isReasoning ?? (llmStatus.state === 'thinking' || llmStatus.state === 'planning' || llmStatus.state === 'analyzing');

  if (isReasoning) {
    // Close any active text part
    if (state.activeTextPartId) {
      broadcastV2(clients, { type: 'text-end', messageId: msgId, partId: state.activeTextPartId });
      state.activeTextPartId = null;
    }
    // Start reasoning if not already active
    if (!state.activeReasoningPartId) {
      const partId = `r-${randomUUID().slice(0, 8)}`;
      state.activeReasoningPartId = partId;
      broadcastV2(clients, { type: 'reasoning-start', messageId: msgId, partId });
    }
    broadcastV2(clients, { type: 'reasoning-delta', messageId: msgId, partId: state.activeReasoningPartId, delta: payload.delta });
  } else {
    // Close any active reasoning part
    if (state.activeReasoningPartId) {
      broadcastV2(clients, { type: 'reasoning-end', messageId: msgId, partId: state.activeReasoningPartId });
      state.activeReasoningPartId = null;
    }
    // Start text if not already active
    if (!state.activeTextPartId) {
      const partId = `t-${randomUUID().slice(0, 8)}`;
      state.activeTextPartId = partId;
      broadcastV2(clients, { type: 'text-start', messageId: msgId, partId });
    }
    broadcastV2(clients, { type: 'text-delta', messageId: msgId, partId: state.activeTextPartId, delta: payload.delta });
  }
}

/** Handle a DAG event (tool calls, phase transitions, context snapshots). */
export function handleV2DagEvent(
  clients: Set<V2Client>,
  state: ChatStreamState,
  evt: UiDagEvent,
): void {
  if (clients.size === 0) return;

  // Phase transitions
  if (evt.type === 'task:planning' || evt.type === 'task:implementation-planning' || evt.type === 'task:implementation' || evt.type === 'task:testing') {
    const newPhase: ChatSessionPhase =
      evt.type === 'task:testing' ? 'testing' :
        (evt.type === 'task:planning' || evt.type === 'task:implementation-planning') ? 'planning' : 'implementation';

    if (newPhase !== state.currentPhase) {
      // Close active parts before phase transition
      if (state.activeReasoningPartId && state.currentMessageId) {
        broadcastV2(clients, { type: 'reasoning-end', messageId: state.currentMessageId, partId: state.activeReasoningPartId });
        state.activeReasoningPartId = null;
      }
      if (state.activeTextPartId && state.currentMessageId) {
        broadcastV2(clients, { type: 'text-end', messageId: state.currentMessageId, partId: state.activeTextPartId });
        state.activeTextPartId = null;
      }

      broadcastV2(clients, {
        type: 'phase-transition',
        phase: newPhase,
        label: newPhase.charAt(0).toUpperCase() + newPhase.slice(1),
        model: evt.llmContextModel ?? undefined,
        provider: evt.llmContextProvider ?? undefined,
      });
      state.currentPhase = newPhase;
    }
  }

  // Tool calls
  if (evt.toolName) {
    const msgId = ensureMessage(clients, state, evt.time, 'assistant', { phase: state.currentPhase, taskId: evt.taskId });

    // Close streaming parts before tool card
    if (state.activeReasoningPartId) {
      broadcastV2(clients, { type: 'reasoning-end', messageId: msgId, partId: state.activeReasoningPartId });
      state.activeReasoningPartId = null;
    }
    if (state.activeTextPartId) {
      broadcastV2(clients, { type: 'text-end', messageId: msgId, partId: state.activeTextPartId });
      state.activeTextPartId = null;
    }

    if (evt.toolStatus === 'started') {
      const partId = evt.toolCallId ?? `tc-${randomUUID().slice(0, 8)}`;
      broadcastV2(clients, {
        type: 'tool-call-start',
        messageId: msgId,
        partId,
        toolName: evt.toolName,
        input: evt.toolInput,
        inputSummary: summarizeInput(evt.toolName, evt.toolInput),
      });
    } else if (evt.toolStatus === 'result') {
      const partId = evt.toolCallId ?? `tc-${randomUUID().slice(0, 8)}`;
      broadcastV2(clients, {
        type: 'tool-call-end',
        messageId: msgId,
        partId,
        status: evt.toolIsError ? 'error' : 'success',
        output: evt.toolOutput,
        outputSummary: summarizeOutput(evt.toolOutput),
        error: evt.toolIsError ? String(evt.toolOutput ?? 'Tool error') : undefined,
      });
    }
  }

  // LLM context snapshots
  if (evt.llmContextSnapshotId && !evt.toolName) {
    const msgId = ensureMessage(clients, state, evt.time, 'assistant', { phase: state.currentPhase, taskId: evt.taskId });
    const partId = `cs-${randomUUID().slice(0, 8)}`;
    broadcastV2(clients, {
      type: 'context-snapshot',
      messageId: msgId,
      partId,
      snapshotId: evt.llmContextSnapshotId,
      phase: evt.llmContextPhase ?? state.currentPhase,
      model: evt.llmContextModel ?? '',
      textChars: evt.llmContextTextChars ?? 0,
      imageCount: evt.llmContextImageCount ?? 0,
    });
  }
}

/** Handle LLM status change (close active streaming parts on terminal states). */
export function handleV2StatusChange(
  clients: Set<V2Client>,
  state: ChatStreamState,
  status: string,
  time: string,
): void {
  if (clients.size === 0) return;

  if (status === 'using-tools' || status === 'idle') {
    // Close active reasoning/text — tools are about to run
    if (state.activeReasoningPartId && state.currentMessageId) {
      broadcastV2(clients, { type: 'reasoning-end', messageId: state.currentMessageId, partId: state.activeReasoningPartId });
      state.activeReasoningPartId = null;
    }
    if (state.activeTextPartId && state.currentMessageId) {
      broadcastV2(clients, { type: 'text-end', messageId: state.currentMessageId, partId: state.activeTextPartId });
      state.activeTextPartId = null;
    }
  }
}

/** Handle terminal session events (end, error). */
export function handleV2SessionEnd(
  clients: Set<V2Client>,
  state: ChatStreamState,
  sessionId: string,
  status: string,
  llmStatus: SessionLlmStatus | undefined,
  error: string | undefined,
  time: string,
): void {
  if (clients.size === 0) return;

  // Close any open parts/message
  if (state.activeReasoningPartId && state.currentMessageId) {
    broadcastV2(clients, { type: 'reasoning-end', messageId: state.currentMessageId, partId: state.activeReasoningPartId });
    state.activeReasoningPartId = null;
  }
  if (state.activeTextPartId && state.currentMessageId) {
    broadcastV2(clients, { type: 'text-end', messageId: state.currentMessageId, partId: state.activeTextPartId });
    state.activeTextPartId = null;
  }
  if (state.currentMessageId) {
    broadcastV2(clients, { type: 'message-end', messageId: state.currentMessageId });
    state.currentMessageId = null;
  }

  broadcastV2(clients, { type: 'status-update', sessionId, status, llmStatus });
}

/** Handle todo updates. */
export function handleV2TodoUpdate(
  clients: Set<V2Client>,
  sessionId: string,
  todos: AgentTodoItem[],
): void {
  if (clients.size === 0) return;
  broadcastV2(clients, { type: 'todo-update', sessionId, todos });
}

/** Handle observer finding. */
export function handleV2ObserverFinding(
  clients: Set<V2Client>,
  state: ChatStreamState,
  finding: { id: string; severity: string; title: string; description?: string },
  time: string,
): void {
  if (clients.size === 0) return;
  const msgId = ensureMessage(clients, state, time, 'assistant');
  const partId = `of-${randomUUID().slice(0, 8)}`;
  broadcastV2(clients, {
    type: 'observer-finding',
    messageId: msgId,
    partId,
    findingId: finding.id,
    severity: finding.severity,
    title: finding.title,
    detail: finding.description,
  });
}

/** Handle plan approval request. */
export function handleV2ApprovalRequest(
  clients: Set<V2Client>,
  state: ChatStreamState,
  planSummary: string,
  time: string,
): void {
  if (clients.size === 0) return;
  const msgId = ensureMessage(clients, state, time, 'assistant');
  const partId = `ap-${randomUUID().slice(0, 8)}`;
  broadcastV2(clients, {
    type: 'approval-request',
    messageId: msgId,
    partId,
    planSummary,
  });
}

/** Handle chat message from legacy event (user text injected via composer). */
export function handleV2ChatMessage(
  clients: Set<V2Client>,
  state: ChatStreamState,
  message: { role: 'user' | 'assistant' | 'system'; content: string; time: string },
): void {
  if (clients.size === 0) return;

  if (message.role === 'user') {
    // Close current assistant message
    if (state.currentMessageId) {
      if (state.activeReasoningPartId) {
        broadcastV2(clients, { type: 'reasoning-end', messageId: state.currentMessageId, partId: state.activeReasoningPartId });
        state.activeReasoningPartId = null;
      }
      if (state.activeTextPartId) {
        broadcastV2(clients, { type: 'text-end', messageId: state.currentMessageId, partId: state.activeTextPartId });
        state.activeTextPartId = null;
      }
      broadcastV2(clients, { type: 'message-end', messageId: state.currentMessageId });
      state.currentMessageId = null;
    }

    const msgId = `m-${randomUUID().slice(0, 8)}`;
    const partId = `t-${randomUUID().slice(0, 8)}`;
    broadcastV2(clients, { type: 'message-start', messageId: msgId, role: 'user', timestamp: message.time });
    broadcastV2(clients, { type: 'text-start', messageId: msgId, partId });
    broadcastV2(clients, { type: 'text-delta', messageId: msgId, partId, delta: message.content });
    broadcastV2(clients, { type: 'text-end', messageId: msgId, partId });
    broadcastV2(clients, { type: 'message-end', messageId: msgId });
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function summarizeInput(toolName: string, input: unknown): string {
  if (!input) return '';
  const str = typeof input === 'string' ? input : '';
  try {
    const obj = typeof input === 'string' ? JSON.parse(input) : (typeof input === 'object' ? input : null);
    if (obj && typeof obj === 'object') {
      const o = obj as Record<string, unknown>;
      const path = o.filePath ?? o.path ?? o.file ?? o.query ?? o.command;
      if (typeof path === 'string') return path.length > 80 ? '…' + path.slice(-77) : path;
    }
  } catch { /* ignore */ }
  return str.length > 80 ? str.slice(0, 80) + '…' : str;
}

function summarizeOutput(output: unknown): string {
  if (!output) return '';
  if (typeof output === 'string') {
    if (output.length <= 60) return output;
    return `${output.split('\n').length} lines`;
  }
  return '';
}
