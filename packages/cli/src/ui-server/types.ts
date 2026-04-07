import type { DagEvent } from '@orchestrace/core';

export interface UiServerOptions {
  port?: number;
  workspace?: string;
  hmr?: boolean;
}

export type WorkState = 'running' | 'completed' | 'failed' | 'cancelled';
export type ExecutionContext = 'workspace' | 'git-worktree';
export type SessionCreationReason = 'start' | 'retry';

export type LlmSessionState =
  | 'queued'
  | 'analyzing'
  | 'thinking'
  | 'planning'
  | 'awaiting-approval'
  | 'implementing'
  | 'using-tools'
  | 'validating'
  | 'retrying'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface SessionLlmStatus {
  state: LlmSessionState;
  label: string;
  detail?: string;
  failureType?: string;
  taskId?: string;
  phase?: 'planning' | 'implementation';
  updatedAt: string;
}

export interface SessionAgentGraphNode {
  id: string;
  name?: string;
  prompt: string;
  weight?: number;
  dependencies: string[];
  status?: 'pending' | 'running' | 'completed' | 'failed';
  provider?: string;
  model?: string;
  reasoning?: 'minimal' | 'low' | 'medium' | 'high';
}

export interface UiDagEvent {
  time: string;
  runId?: string;
  type: DagEvent['type'];
  taskId?: string;
  failureType?: string;
  message: string;
}

export type AuthSessionState = 'running' | 'awaiting-auth' | 'awaiting-input' | 'completed' | 'failed';

export interface AuthSession {
  id: string;
  providerId: string;
  state: AuthSessionState;
  createdAt: string;
  updatedAt: string;
  authUrl?: string;
  authInstructions?: string;
  promptMessage?: string;
  promptPlaceholder?: string;
  error?: string;
  resolveInput?: (value: string) => void;
}

export type ChatRole = 'user' | 'assistant' | 'system';

export type SessionChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string; name?: string };

export interface SessionChatMessage {
  role: ChatRole;
  content: string;
  contentParts?: SessionChatContentPart[];
  time: string;
  usage?: { input: number; output: number; cost: number };
}

export interface SessionChatThread {
  sessionId: string;
  provider: string;
  model: string;
  workspacePath: string;
  taskPrompt: string;
  createdAt: string;
  updatedAt: string;
  messages: SessionChatMessage[];
}

export interface AgentTodoItem {
  id: string;
  text: string;
  status?: 'todo' | 'in_progress' | 'done';
  done: boolean;
  weight?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatTokenStream {
  id: string;
  sessionId: string;
  status: 'running' | 'completed' | 'failed';
  replyText: string;
  usage?: { input: number; output: number; cost: number };
  usageEstimated?: boolean;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkSession {
  id: string;
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  prompt: string;
  promptParts?: SessionChatContentPart[];
  provider: string;
  model: string;
  autoApprove: boolean;
  quickStartMode?: boolean;
  quickStartMaxPreDelegationToolCalls?: number;
  executionContext: ExecutionContext;
  selectedWorktreePath?: string;
  useWorktree: boolean;
  adaptiveConcurrency: boolean;
  batchConcurrency: number;
  batchMinConcurrency: number;
  enableTrivialTaskGate: boolean;
  trivialTaskMaxPromptLength: number;
  worktreePath?: string;
  worktreeBranch?: string;
  creationReason: SessionCreationReason;
  sourceSessionId?: string;
  source?: 'user' | 'observer';
  createdAt: string;
  updatedAt: string;
  status: WorkState;
  llmStatus: SessionLlmStatus;
  taskStatus: Record<string, string>;
  events: UiDagEvent[];
  agentGraph: SessionAgentGraphNode[];
  error?: string;
  output?: { text?: string; planPath?: string; failureType?: string };
  controller: AbortController;
  /** Clean up an auto-created per-session worktree on session delete. Not persisted. */
  cleanupWorktree?: () => Promise<void>;
}

export interface PersistedWorkSession {
  id: string;
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  prompt: string;
  promptParts?: SessionChatContentPart[];
  provider: string;
  model: string;
  autoApprove: boolean;
  quickStartMode?: boolean;
  quickStartMaxPreDelegationToolCalls?: number;
  executionContext?: ExecutionContext;
  selectedWorktreePath?: string;
  useWorktree?: boolean;
  adaptiveConcurrency?: boolean;
  batchConcurrency?: number;
  batchMinConcurrency?: number;
  enableTrivialTaskGate?: boolean;
  trivialTaskMaxPromptLength?: number;
  worktreePath?: string;
  worktreeBranch?: string;
  creationReason?: SessionCreationReason;
  sourceSessionId?: string;
  createdAt: string;
  updatedAt: string;
  status: WorkState;
  llmStatus?: SessionLlmStatus;
  taskStatus: Record<string, string>;
  events: UiDagEvent[];
  agentGraph?: SessionAgentGraphNode[];
  error?: string;
  output?: { text?: string; planPath?: string; failureType?: string };
}

export interface UiPreferences {
  activeTab: 'graph' | 'settings';
  observerShowFindings: boolean;
  defaultProvider: string;
  defaultModel: string;
  executionContext: ExecutionContext;
  selectedWorktreePath?: string;
  useWorktree: boolean;
  adaptiveConcurrency: boolean;
  batchConcurrency: number;
  batchMinConcurrency: number;
  enableTrivialTaskGate: boolean;
  trivialTaskMaxPromptLength: number;
}

export interface PersistedUiPreferences {
  activeTab?: 'graph' | 'settings';
  observerShowFindings?: boolean;
  defaultProvider?: string;
  defaultModel?: string;
  executionContext?: ExecutionContext;
  selectedWorktreePath?: string;
  useWorktree?: boolean;
  adaptiveConcurrency?: boolean;
  batchConcurrency?: number;
  batchMinConcurrency?: number;
  enableTrivialTaskGate?: boolean;
  trivialTaskMaxPromptLength?: number;
}

export interface PersistedUiState {
  version: 1;
  updatedAt: string;
  sessions: PersistedWorkSession[];
  chats: SessionChatThread[];
  todos: Array<{ sessionId: string; items: AgentTodoItem[] }>;
  preferences?: PersistedUiPreferences;
}