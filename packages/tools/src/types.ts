import type { Tool } from '@mariozechner/pi-ai';
import type { LlmToolResult } from '@orchestrace/provider';
import type { SharedContextStore } from '@orchestrace/context';
import type { FileReadCache } from './file-read-cache.js';

export type AgentToolPhase = 'planning' | 'implementation' | 'chat';

export interface AgentToolPermissions {
  allowWriteTools: boolean;
  allowRunCommand: boolean;
  runCommandAllowPrefixes?: string[];
  toolAllowlist?: string[];
  toolBlocklist?: string[];
}

export interface AgentToolsetOptions {
  cwd: string;
  phase?: AgentToolPhase;
  taskType?: string;
  graphId?: string;
  taskId?: string;
  provider?: string;
  model?: string;
  reasoning?: 'minimal' | 'low' | 'medium' | 'high';
  commandTimeoutMs?: number;
  maxOutputChars?: number;
  batchConcurrency?: number;
  batchMinConcurrency?: number;
  adaptiveConcurrency?: boolean;
  permissions?: Partial<AgentToolPermissions>;
  runSubAgent?: (request: SubAgentRequest, signal?: AbortSignal) => Promise<SubAgentResult>;
  modeController?: AgentModeController;
  resolveGithubToken?: () => Promise<string | undefined>;
  sharedContextStore?: SharedContextStore;
  agentId?: string;
  fileReadCache?: FileReadCache;
}

export interface AgentModeController {
  getMode: () => AgentToolPhase;
  setMode: (mode: AgentToolPhase, reason?: string) => Promise<ModeChangeResult>;
  availableModes?: AgentToolPhase[];
}

export interface ModeChangeResult {
  mode: AgentToolPhase;
  changed: boolean;
  detail?: string;
}

export interface RegisteredAgentTool {
  tool: Tool;
  execute: (toolArgs: Record<string, unknown>, signal?: AbortSignal) => Promise<LlmToolResult>;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface TodoItem {
  id: string;
  title: string;
  status: 'todo' | 'in_progress' | 'done';
  weight?: number;
  details?: string;
  dependsOn?: string[];
}

export interface AgentGraphNode {
  id: string;
  name?: string;
  prompt: string;
  weight?: number;
  dependencies?: string[];
  provider?: string;
  model?: string;
  reasoning?: 'minimal' | 'low' | 'medium' | 'high';
}

export interface SubAgentRequest {
  nodeId?: string;
  prompt: string;
  systemPrompt?: string;
  provider?: string;
  model?: string;
  reasoning?: 'minimal' | 'low' | 'medium' | 'high';
  contextPacket?: SubAgentContextPacket;
}

export interface SubAgentFileSnippet {
  path: string;
  content: string;
}

export interface SubAgentContextPacket {
  objective: string;
  boundaries?: {
    writePolicy?: 'none' | 'scoped' | 'full';
    allowedTools?: string[];
    timeoutMs?: number;
  };
  relevantContext?: string[];
  requiredOutputSchema?: string;
  evidenceRequirements?: string[];
  fileSnippets?: SubAgentFileSnippet[];
}

export interface SubAgentEvidenceItem {
  type: 'file' | 'command' | 'test' | 'log' | 'url' | 'other';
  ref: string;
  note?: string;
}

export interface SubAgentResult {
  text: string;
  usage?: { input: number; output: number; cost: number };
  summary?: string;
  actions?: string[];
  evidence?: SubAgentEvidenceItem[];
  risks?: string[];
  openQuestions?: string[];
  patchIntent?: string[];
}