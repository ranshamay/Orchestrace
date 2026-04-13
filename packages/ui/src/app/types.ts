import type { AgentModels, ChatContentPart } from '../lib/api';

export type Tab = 'graph' | 'settings' | 'logs';
export type ThemeMode = 'light' | 'dark';

export type GraphNodeView = {
  id: string;
  label: string;
  prompt: string;
  x: number;
  y: number;
  status: string;
  dependencies: string[];
};

export type NodeTokenStream = {
  phase: 'planning' | 'implementation';
  text: string;
  updatedAt: string;
};

export type TimelineItem = {
  key: string;
  time: string;
  kind: 'chat' | 'event' | 'tool-call';
  role?: string;
  title?: string;
  subtitle?: string;
  failureType?: string;
  tone?: 'neutral' | 'tool' | 'success' | 'error';
  content: string;
  contentParts?: ChatContentPart[];
  toolName?: string;
  inputSummary?: string;
  outputSummary?: string;
  inputPayload?: string;
  outputPayload?: string;
  toolStatus?: 'pending' | 'success' | 'error';
  endTime?: string;
  llmContextSnapshotId?: string;
  llmContextPhase?: 'chat' | 'planning' | 'implementation' | 'testing';
  llmContextProvider?: string;
  llmContextModel?: string;
  llmContextTextChars?: number;
  llmContextImageCount?: number;
};

export type ComposerImageAttachment = {
  id: string;
  name: string;
  mime: string;
  dataUrl: string;
};

export type SessionLlmControls = {
  planningProvider: string;
  planningModel: string;
  implementationProvider: string;
  implementationModel: string;
  agentModels: AgentModels;
  deliveryStrategy: 'pr-only' | 'merge-after-ci';
  planningNoToolGuardMode: 'enforce' | 'warn';
  workspaceId: string;
  autoApprove: boolean;
  quickStartMode: boolean;
  quickStartMaxPreDelegationToolCalls: number;
  adaptiveConcurrency: boolean;
  batchConcurrency: number;
  batchMinConcurrency: number;
  enableTrivialTaskGate: boolean;
  trivialTaskMaxPromptLength: number;
};

export type SessionStatus = 'running' | 'idle' | 'completed' | 'failed' | 'cancelled' | 'merged' | 'pending' | 'unknown';
export type LlmSessionPhase = 'planning' | 'implementation' | 'testing';
export type ComposerMode = 'run' | 'chat' | 'planning' | 'implementation' | 'testing';

export type LlmSessionState =
  | 'queued'
  | 'analyzing'
  | 'thinking'
  | 'planning'
  | 'awaiting-approval'
  | 'idle'
  | 'implementing'
  | 'using-tools'
  | 'validating'
  | 'retrying'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type LlmSessionStatus = {
  state: LlmSessionState;
  label: string;
  detail?: string;
  failureType?: string;
  phase?: LlmSessionPhase;
};

export type FailureType =
  | 'timeout'
  | 'auth'
  | 'rate_limit'
  | 'tool_schema'
  | 'tool_runtime'
  | 'validation'
  | 'empty_response'
  | 'unknown';