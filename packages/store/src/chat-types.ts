// ---------------------------------------------------------------------------
// Chat Message-Parts Model — shared data types
// ---------------------------------------------------------------------------
// Surface-agnostic: consumed by both Web UI (React) and CLI (terminal).
// No React/DOM dependencies allowed in this file.
// ---------------------------------------------------------------------------

// ─── Session Phases ─────────────────────────────────────────────────────────

export type ChatSessionPhase = 'planning' | 'implementation' | 'testing';

// ─── Message ────────────────────────────────────────────────────────────────

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  agentId?: string;
  phase?: ChatSessionPhase;
  taskId?: string;
  timestamp: string;
  status: 'streaming' | 'complete' | 'error';
  parts: MessagePart[];
  metadata?: ChatMessageMetadata;
}

export interface ChatMessageMetadata {
  model?: string;
  provider?: string;
  tokenUsage?: { prompt: number; completion: number };
}

// ─── Parts (discriminated union) ────────────────────────────────────────────

export type MessagePart =
  | ReasoningMessagePart
  | TextMessagePart
  | ToolCallMessagePart
  | PhaseTransitionMessagePart
  | ContextSnapshotMessagePart
  | ApprovalRequestMessagePart
  | ObserverFindingMessagePart
  | ErrorMessagePart;

export type MessagePartType = MessagePart['type'];

export interface ReasoningMessagePart {
  type: 'reasoning';
  id: string;
  text: string;
  isStreaming: boolean;
}

export interface TextMessagePart {
  type: 'text';
  id: string;
  text: string;
  isStreaming: boolean;
}

export interface ToolCallMessagePart {
  type: 'tool-call';
  id: string;
  toolName: string;
  input: unknown;
  inputSummary: string;
  output?: unknown;
  outputSummary?: string;
  status: 'calling' | 'success' | 'error';
  startTime: string;
  endTime?: string;
  error?: string;
}

export interface PhaseTransitionMessagePart {
  type: 'phase-transition';
  phase: ChatSessionPhase;
  label: string;
}

export interface ContextSnapshotMessagePart {
  type: 'context-snapshot';
  snapshotId: string;
  phase: string;
  model: string;
  textChars: number;
  imageCount: number;
}

export interface ApprovalRequestMessagePart {
  type: 'approval-request';
  planSummary: string;
  status: 'pending' | 'approved' | 'rejected';
}

export interface ObserverFindingMessagePart {
  type: 'observer-finding';
  findingId: string;
  severity: string;
  title: string;
  detail?: string;
}

export interface ErrorMessagePart {
  type: 'error';
  message: string;
  detail?: string;
}

// ─── Icon Maps ──────────────────────────────────────────────────────────────

export const TOOL_ICON: Record<string, string> = {
  read_file: '📖',
  edit_file: '✏️',
  replace_string_in_file: '✏️',
  multi_replace_string_in_file: '✏️',
  create_file: '📄',
  list_dir: '📁',
  grep_search: '🔍',
  semantic_search: '🔍',
  file_search: '🔍',
  run_in_terminal: '▶️',
  run_command: '▶️',
  execution_subagent: '▶️',
  fetch_webpage: '🌐',
  git_diff: '🔀',
  git_commit: '🔀',
  delete_file: '🗑️',
  _default: '🔧',
};

export const ROLE_ICON: Record<string, string> = {
  user: '👤',
  assistant: '🤖',
  system: '⚙️',
};

export const PHASE_ICON: Record<string, string> = {
  planning: '📋',
  implementation: '🔨',
  testing: '🧪',
};

export const STATUS_ICON: Record<string, string> = {
  calling: '⏳',
  success: '✓',
  error: '✗',
  streaming: '█',
  complete: '✅',
  failed: '💥',
};

export const REASONING_ICON = '🧠';
export const OBSERVER_ICON = '👁️';
export const APPROVAL_ICON = '✋';
export const CONTEXT_ICON = '📊';

export function resolveToolIcon(toolName: string): string {
  return TOOL_ICON[toolName] ?? TOOL_ICON._default;
}

// ─── SSE v2 Event Types ─────────────────────────────────────────────────────

export type ChatSseEvent =
  | { type: 'message-start'; messageId: string; role: ChatMessage['role']; phase?: ChatSessionPhase; taskId?: string; agentId?: string; timestamp: string }
  | { type: 'message-end'; messageId: string }
  | { type: 'reasoning-start'; messageId: string; partId: string }
  | { type: 'reasoning-delta'; messageId: string; partId: string; delta: string }
  | { type: 'reasoning-end'; messageId: string; partId: string }
  | { type: 'text-start'; messageId: string; partId: string }
  | { type: 'text-delta'; messageId: string; partId: string; delta: string }
  | { type: 'text-end'; messageId: string; partId: string }
  | { type: 'tool-call-start'; messageId: string; partId: string; toolName: string; input: unknown; inputSummary: string }
  | { type: 'tool-call-end'; messageId: string; partId: string; status: 'success' | 'error'; output?: unknown; outputSummary?: string; error?: string }
  | { type: 'phase-transition'; phase: ChatSessionPhase; label: string; model?: string; provider?: string }
  | { type: 'context-snapshot'; messageId: string; partId: string; snapshotId: string; phase: string; model: string; textChars: number; imageCount: number }
  | { type: 'approval-request'; messageId: string; partId: string; planSummary: string }
  | { type: 'approval-response'; messageId: string; partId: string; status: 'approved' | 'rejected' }
  | { type: 'observer-finding'; messageId: string; partId: string; findingId: string; severity: string; title: string; detail?: string }
  | { type: 'error-part'; messageId: string; partId: string; message: string; detail?: string }
  | { type: 'status-update'; sessionId: string; status: string; llmStatus?: unknown }
  | { type: 'todo-update'; sessionId: string; todos: unknown[] };
