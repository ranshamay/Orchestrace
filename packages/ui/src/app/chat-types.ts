// ---------------------------------------------------------------------------
// Chat Message-Parts Model — UI-side types (mirrors @orchestrace/store/chat-types)
// ---------------------------------------------------------------------------
// These types are duplicated from the store package to avoid adding a Node.js
// dependency to the Vite-built UI bundle. Keep in sync with store/src/chat-types.ts.
// ---------------------------------------------------------------------------

export type ChatSessionPhase = 'planning' | 'implementation' | 'testing';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  agentId?: string;
  phase?: ChatSessionPhase;
  taskId?: string;
  timestamp: string;
  status: 'streaming' | 'complete' | 'error';
  parts: MessagePart[];
  metadata?: {
    model?: string;
    provider?: string;
    tokenUsage?: { prompt: number; completion: number };
  };
}

export type MessagePart =
  | ReasoningMessagePart
  | TextMessagePart
  | ToolCallMessagePart
  | PhaseTransitionMessagePart
  | ContextSnapshotMessagePart
  | ApprovalRequestMessagePart
  | ObserverFindingMessagePart
  | ErrorMessagePart;

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

export function resolveToolIcon(toolName: string): string {
  return TOOL_ICON[toolName] ?? TOOL_ICON._default;
}
