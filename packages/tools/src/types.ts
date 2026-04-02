import type { Tool } from '@mariozechner/pi-ai';
import type { LlmToolResult } from '@orchestrace/provider';

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
  commandTimeoutMs?: number;
  maxOutputChars?: number;
  permissions?: Partial<AgentToolPermissions>;
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