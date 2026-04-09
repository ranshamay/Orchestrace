import type { ChatContentPart } from '../lib/api';

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
  planningNoToolGuardMode: 'enforce' | 'warn';
  workspaceId: string;
  autoApprove: boolean;
  adaptiveConcurrency: boolean;
  batchConcurrency: number;
  batchMinConcurrency: number;
};

export type SessionStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'pending' | 'unknown';
export type LlmSessionPhase = 'planning' | 'implementation';
export type ComposerMode = 'run' | 'chat' | 'planning' | 'implementation';

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